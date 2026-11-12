import "../utils/polyfills.js";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logger, ToolRegistry } from "mcp-server-framework";
import { komodoIdentity } from "../auth/komodo-identity.js";
import { KomodoClient, configureKomodoConnections, stopKomodoConnections } from "../client.js";
import { config, ToolScopes } from "../config/index.js";
import { deleteStackTool, getStackInfoTool } from "./stack.js";
import { resourceSyncActionTool } from "./resource-sync.js";
import { listContainersTool } from "./container.js";

test("authorization and confirmation remain independent of delivery policy", async (t) => {
  const savedConfig = { ...config };
  const savedEnv = { ...process.env };
  const global = KomodoClient.connectWithApiKey("https://komodo.invalid", "global-key", "global-secret");
  const alice = KomodoClient.connectWithJwt("https://komodo.invalid", "alice-fixture-jwt");
  const bob = KomodoClient.connectWithJwt("https://komodo.invalid", "bob-fixture-jwt");
  t.mock.method(KomodoClient, "connectWithApiKey", () => global);
  t.mock.method(KomodoClient, "connectWithJwt", (_url: string, jwt: string) => {
    assert.ok(jwt === "alice-fixture-jwt" || jwt === "bob-fixture-jwt");
    return jwt === "alice-fixture-jwt" ? alice : bob;
  });
  t.mock.method(KomodoClient, "ping", async () => ({ reachable: true }));
  t.mock.method(global, "healthCheck", async () => ({ healthy: true }));
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected external request");
  });
  let permission = "Write";
  let downstreamFailure: number | undefined;
  const stats = {
    name: "fixture",
    cpu_perc: "1%",
    mem_perc: "2%",
    mem_usage: "2MiB / 100MiB",
    net_io: "1B / 2B",
    block_io: "3B / 4B",
    pids: "5",
  };
  const reads = [global, alice, bob].map((client, index) =>
    t.mock.method(client.client, "read", async (type: string) => {
      if (type === "GetPermission") {
        if (downstreamFailure)
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- komodo_client rejects with HTTP response objects.
          throw { status: downstreamFailure, result: { error: "permission denied by synthetic Komodo" } };
        return permission;
      }
      if (type === "GetStack") return { name: ["global", "alice", "bob"][index] };
      if (type === "ListDockerContainers") return [{ name: "fixture", state: "running", stats }];
      throw new Error(`Unexpected fixture read ${type}`);
    }),
  );
  const writes = [global, alice, bob].map((client) =>
    t.mock.method(client.client, "write", async () => ({ name: "fixture" })),
  );
  const [globalRead] = reads;
  const [globalWrite] = writes;
  assert.ok(globalRead && globalWrite);
  const executes = t.mock.method(global.client, "execute", async () => ({
    status: "Complete",
    success: true,
    logs: [],
  }));
  Object.assign(process.env, {
    KOMODO_URL: "https://komodo.invalid",
    KOMODO_API_KEY: "global-key",
    KOMODO_API_SECRET: "global-secret",
  });
  t.after(() => {
    stopKomodoConnections();
    Object.assign(config, savedConfig);
    process.env = savedEnv;
  });
  await configureKomodoConnections({ anonymousMode: true });
  config.MCP_CONFIRM_DESTRUCTIVE = true;
  config.MCP_CONFIRM_FALLBACK = "deny";
  config.MCP_CONFIRM_TIMEOUT_MS = 30;
  const allScopes = [ToolScopes.READ, ToolScopes.OPERATE, ToolScopes.ADMIN];
  function auth(user: "alice" | "bob", scopes = allScopes): AuthInfo {
    return {
      token: "synthetic-token",
      clientId: user,
      scopes,
      extra: komodoIdentity.write({
        method: "password",
        komodoUserId: user,
        username: user,
        credential: { type: "jwt", jwt: `${user}-fixture-jwt` },
        isAdmin: false,
        canCreateServers: false,
        canCreateBuilds: false,
      }),
    };
  }
  async function open(
    st: TestContext,
    authInfo?: AuthInfo,
    options: { anonymousAdmin?: boolean; elicitation?: boolean } = {},
  ) {
    const sdk = new McpServer({ name: "authorization-fixture", version: "1" });
    const client = new Client(
      { name: "fixture", version: "1" },
      { capabilities: options.elicitation === false ? {} : { elicitation: { form: {} } } },
    );
    const [ct, transport] = InMemoryTransport.createLinkedPair();
    transport.sessionId = "fixture-owner";
    const send = ct.send.bind(ct);
    st.mock.method(ct, "send", (message: Parameters<typeof ct.send>[0], opts?: Parameters<typeof ct.send>[1]) =>
      send(message, { ...opts, ...(authInfo && { authInfo }) }),
    );
    const tools = ToolRegistry.createIsolated();
    for (const tool of [getStackInfoTool, deleteStackTool, resourceSyncActionTool, listContainersTool])
      tools.registerFromFactory(tool);
    ToolRegistry.bindToSdk(sdk, tools.getTools(), {
      logger,
      stateless: false,
      anonymousScopes: options.anonymousAdmin ? allScopes : [ToolScopes.READ],
    });
    st.after(async () => {
      await client.close();
      await sdk.close();
    });
    await sdk.connect(transport);
    await client.connect(ct);
    return client;
  }
  let resource = 0;
  const target = () => (++resource).toString(16).padStart(24, "0"); // avoid permission-cache reuse
  const writeCount = () => writes.reduce((n, write) => n + write.mock.callCount(), 0);
  for (const mode of ["link", "inline", "auto"] as const) {
    config.MCP_RESOURCE_RESPONSE_MODE = mode;
    for (const caller of [
      "anonymous",
      "read-only",
      "no-scopes",
      "alice",
      "bob",
      "unbound",
      "permission-denied",
      "komodo-403",
      "komodo-500",
    ] as const) {
      await t.test(`${mode}: ${caller} authorization`, async (st) => {
        permission = caller === "permission-denied" ? "Read" : "Write";
        downstreamFailure = caller === "komodo-403" ? 403 : caller === "komodo-500" ? 500 : undefined;
        const identity =
          caller === "anonymous"
            ? undefined
            : caller === "unbound"
              ? { token: "synthetic", clientId: "unbound", scopes: allScopes, extra: {} }
              : auth(
                  caller === "bob" ? "bob" : "alice",
                  caller === "read-only" ? [ToolScopes.READ] : caller === "no-scopes" ? [] : allScopes,
                );
        const client = await open(st, identity);
        let prompts = 0;
        client.setRequestHandler(ElicitRequestSchema, async () => {
          prompts++;
          return { action: "accept", content: {} };
        });
        const before = writeCount();
        const perClientWrites = writes.map((write) => write.mock.callCount());
        const globalReads = globalRead.mock.callCount();
        const read = await client.callTool({
          name: getStackInfoTool.name,
          arguments: { stack: target(), inline_full: true },
        });
        const readable = caller !== "unbound" && caller !== "no-scopes" && !downstreamFailure;
        assert.equal(read.isError === true, !readable);
        if (readable) {
          const name = caller === "anonymous" ? "global" : caller === "bob" ? "bob" : "alice";
          assert.equal((read.structuredContent as { info: { name: string } }).info.name, name);
        }
        if (caller !== "anonymous")
          assert.equal(
            globalRead.mock.callCount(),
            globalReads,
            "authenticated callers must never read with global credentials",
          );
        const result = await client.callTool({ name: deleteStackTool.name, arguments: { stack: target() } });
        const allowed = caller === "alice" || caller === "bob";
        assert.equal(result.isError === true, !allowed);
        assert.equal(writeCount() - before, allowed ? 1 : 0);
        assert.equal(prompts, allowed ? 1 : 0);
        for (const [index, write] of writes.entries()) {
          const previous = perClientWrites[index];
          assert.ok(typeof previous === "number");
          assert.equal(write.mock.callCount() - previous, allowed && index === (caller === "alice" ? 1 : 2) ? 1 : 0);
        }
      });
    }
    downstreamFailure = undefined;
    for (const action of [
      "accept",
      "decline",
      "cancel",
      "unsupported",
      "failure",
      "timeout",
      "client-cancel",
    ] as const) {
      await t.test(`${mode}: confirmation ${action}`, async (st) => {
        const client = await open(st, undefined, { anonymousAdmin: true, elicitation: action !== "unsupported" });
        let release: (() => void) | undefined;
        let prompted!: () => void;
        const pendingPrompt = new Promise<void>((resolve) => {
          prompted = resolve;
        });
        if (action !== "unsupported")
          client.setRequestHandler(ElicitRequestSchema, async () => {
            prompted();
            if (action === "failure") throw new Error("synthetic elicitation failure");
            if (action === "timeout" || action === "client-cancel") {
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              return { action: "accept", content: {} };
            }
            return { action, content: {} };
          });
        const before = writeCount();
        const controller = new AbortController();
        const response = client
          .callTool({ name: deleteStackTool.name, arguments: { stack: target() } }, undefined, {
            signal: controller.signal,
          })
          .then(
            (result) => result,
            (err: unknown) => err,
          );
        if (action === "client-cancel") {
          await pendingPrompt;
          controller.abort();
        }
        const result = await response;
        release?.();
        await nextTurn(); // drain the in-memory server's cancellation / late acceptance
        if (action === "client-cancel") assert.ok(result instanceof Error);
        else assert.equal((result as { isError?: boolean }).isError === true, action !== "accept");
        assert.equal(
          writeCount() - before,
          action === "accept" ? 1 : 0,
          "only authorization plus live acceptance may write",
        );
      });
    }
    await t.test(`${mode}: ResourceSync refresh, run approval and container statistics`, async (st) => {
      const client = await open(st, undefined, { anonymousAdmin: true });
      let action: "accept" | "decline" = "decline";
      let prompts = 0;
      client.setRequestHandler(ElicitRequestSchema, async () => {
        prompts++;
        return { action, content: {} };
      });
      const before = globalWrite.mock.callCount();
      const refresh = await client.callTool({
        name: resourceSyncActionTool.name,
        arguments: { resource_sync: "fixture", action: "refresh" },
      });
      assert.notEqual(refresh.isError, true);
      assert.equal((refresh.structuredContent as { action: string }).action, "refresh");
      assert.equal((refresh.structuredContent as { status: string }).status, "Complete");
      assert.equal(globalWrite.mock.callCount(), before + 1);
      assert.equal(prompts, 0);
      const executed = executes.mock.callCount();
      const run = () =>
        client.callTool({ name: resourceSyncActionTool.name, arguments: { resource_sync: "fixture", action: "run" } });
      assert.equal((await run()).isError, true);
      assert.equal(executes.mock.callCount(), executed);
      action = "accept";
      assert.notEqual((await run()).isError, true);
      assert.equal(executes.mock.callCount(), executed + 1);
      const containers = await client.callTool({ name: listContainersTool.name, arguments: { server: "fixture" } });
      assert.notEqual(containers.isError, true);
      assert.deepEqual((containers.structuredContent as { items: { stats: unknown }[] }).items[0]?.stats, stats);
    });
  }
});
