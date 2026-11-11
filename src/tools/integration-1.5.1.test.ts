import "../utils/polyfills.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logger, ToolRegistry } from "mcp-server-framework";
import { komodoIdentity } from "../auth/komodo-identity.js";
import { KomodoClient, configureKomodoConnections, stopKomodoConnections } from "../client.js";
import { config, ToolScopes } from "../config/index.js";
import { clientForAuth } from "../utils/api-helpers.js";
import { deleteStackTool } from "./stack.js";

test("1.5.1 stdio child preserves delivery, filtering, redaction and confirmation denial", async (t) => {
  let writes = 0;
  const downstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/version") return res.end('"2.3.1"');
    assert.equal(req.headers["x-api-key"], "fixture-key");
    assert.equal(req.headers["x-api-secret"], "fixture-secret");
    if (req.url?.startsWith("/write/")) writes++;
    switch (req.url) {
      case "/read/GetVersion":
        return res.end(JSON.stringify({ version: "2.3.1" }));
      case "/read/GetStack":
        return res.end(JSON.stringify({ name: "fixture", config: { webhook_secret: "fixture-sensitive-value" } }));
      case "/read/ExportAllResourcesToToml":
        return res.end(
          JSON.stringify({ toml: '[[server]]\nname="fixture"\n[server.config]\npasskey="fixture-sensitive-value"\n' }),
        );
      default:
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "Unexpected fixture endpoint" }));
    }
  });
  downstream.listen(0, "127.0.0.1");
  await once(downstream, "listening");
  t.after(() => new Promise<void>((resolve, reject) => downstream.close((err) => (err ? reject(err) : resolve()))));
  const address = downstream.address();
  assert.ok(address && typeof address !== "string");
  for (const mode of ["link", "inline", "auto"]) {
    await t.test(mode, async (st) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../index.js", import.meta.url))],
        stderr: "pipe",
        env: {
          PATH: process.env["PATH"] ?? "",
          MCP_TRANSPORT: "stdio",
          LOG_LEVEL: "error",
          KOMODO_URL: `http://127.0.0.1:${address.port}`,
          KOMODO_API_KEY: "fixture-key",
          KOMODO_API_SECRET: "fixture-secret",
          MCP_SECRET_SCRUB_ENABLED: "true",
          MCP_RESOURCE_RESPONSE_MODE: mode,
          MCP_RESOURCE_INLINE_THRESHOLD_BYTES: "1",
          MCP_TOOLS_ALLOWED_CATEGORIES: "stack,toml",
          MCP_TOOLS_EXCLUDED_TOOLS: "komodo_stack_action",
          MCP_CONFIRM_DESTRUCTIVE: "true",
          MCP_CONFIRM_FALLBACK: "deny",
        },
      });
      transport.stderr?.on("data", () => {});
      const client = new Client({ name: "stdio-integration-fixture", version: "1" });
      st.after(() => client.close());
      await client.connect(transport);
      const listed = (await client.listTools()).tools;
      assert.ok(listed.some((tool) => tool.name === "komodo_stack_info" && tool.outputSchema));
      assert.ok(!listed.some((tool) => tool.name.startsWith("komodo_docker_") || tool.name === "komodo_stack_action"));
      for (const [name, args, field] of [
        ["komodo_stack_info", { stack: "fixture" }, "info"],
        ["komodo_toml_export_all", {}, "toml"],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const payload = result.structuredContent as Record<string, unknown> | undefined;
        assert.ok(payload);
        // Framework 1.3 supplies stdio session ids, so link and auto can offload.
        if (mode === "inline") {
          assert.ok(field in payload);
        } else {
          const link = payload["resourceLink"] as { uri: string };
          assert.ok(link.uri.startsWith("ephemeral://"));
          const resource = await client.readResource({ uri: link.uri });
          assert.ok(!JSON.stringify(resource).includes("fixture-sensitive-value"));
        }
        assert.ok(!JSON.stringify(result).includes("fixture-sensitive-value"));
      }
      const removed = await client.callTool({
        name: "komodo_stack_action",
        arguments: { stack: "fixture", action: "destroy" },
      });
      assert.equal(removed.isError, true);
      const denied = await client.callTool({ name: "komodo_stack_delete", arguments: { stack: "fixture" } });
      assert.equal(denied.isError, true);
      assert.equal(writes, 0, "missing elicitation must never reach Komodo writes");
    });
  }
});

test("1.5.1 client routing never gives an unbound identity the global credential", () => {
  const global = KomodoClient.connectWithApiKey("https://komodo.invalid", "global", "global-secret");
  const user = KomodoClient.connectWithJwt("https://komodo.invalid", "user-jwt");
  const credential = { type: "jwt", jwt: "user-jwt" } as const;
  const identity = {
    method: "password",
    komodoUserId: "u",
    username: "u",
    credential,
    isAdmin: false,
    canCreateServers: false,
    canCreateBuilds: false,
  } as const;
  const sources = {
    global: () => global,
    servesAnonymous: () => false,
    user: (actual: unknown) => {
      assert.deepEqual(actual, credential);
      return user;
    },
  };
  assert.equal(clientForAuth({ extra: komodoIdentity.write(identity) }, sources), user);
  assert.throws(() => clientForAuth({ extra: {} }, sources));
  assert.throws(() => clientForAuth(undefined, sources));
  assert.equal(clientForAuth(undefined, { ...sources, servesAnonymous: () => true }), global);
  assert.equal(
    clientForAuth(
      { extra: komodoIdentity.write({ ...identity, method: "service-client", credential: { type: "service" } }) },
      sources,
    ),
    global,
  );
  assert.throws(() =>
    clientForAuth({ extra: komodoIdentity.write({ ...identity, credential: { type: "service" } }) }, sources),
  );
});

test("delivery policies preserve scope denial and explicit destructive approval", async (t) => {
  const originalConfig = { ...config };
  const originalEnv = { ...process.env };
  const fixture = KomodoClient.connectWithApiKey("https://komodo.invalid", "key", "secret");
  t.mock.method(KomodoClient, "ping", async () => ({ reachable: true }));
  t.mock.method(KomodoClient, "connectWithApiKey", () => fixture);
  t.mock.method(fixture, "healthCheck", async () => ({ healthy: true }));
  const writes = t.mock.method(fixture.client, "write", async () => ({ name: "fixture" }));
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected external request");
  });
  Object.assign(process.env, {
    KOMODO_URL: "https://komodo.invalid",
    KOMODO_API_KEY: "key",
    KOMODO_API_SECRET: "secret",
  });
  t.after(() => {
    stopKomodoConnections();
    Object.assign(config, originalConfig);
    process.env = originalEnv;
  });
  await configureKomodoConnections({ anonymousMode: true });
  config.MCP_CONFIRM_DESTRUCTIVE = true;
  config.MCP_CONFIRM_FALLBACK = "deny";
  for (const mode of ["link", "inline", "auto"] as const) {
    config.MCP_RESOURCE_RESPONSE_MODE = mode;
    for (const action of ["decline", "cancel", "accept", "read-scope"] as const) {
      await t.test(`${mode}: ${action}`, async (st) => {
        const sdk = new McpServer({ name: "approval-fixture", version: "1" });
        const client = new Client(
          { name: "approving-client", version: "1" },
          { capabilities: { elicitation: { form: {} } } },
        );
        let prompts = 0;
        client.setRequestHandler(ElicitRequestSchema, async () => {
          prompts++;
          return { action: action === "read-scope" ? "accept" : action, content: {} };
        });
        st.after(async () => {
          await client.close();
          await sdk.close();
        });
        const registry = ToolRegistry.createIsolated();
        registry.registerFromFactory(deleteStackTool);
        ToolRegistry.bindToSdk(sdk, registry.getTools(), {
          logger,
          stateless: false,
          anonymousScopes: [action === "read-scope" ? ToolScopes.READ : ToolScopes.ADMIN],
        });
        const [ct, stt] = InMemoryTransport.createLinkedPair();
        await sdk.connect(stt);
        await client.connect(ct);
        const before = writes.mock.callCount();
        const result = await client.callTool({ name: deleteStackTool.name, arguments: { stack: "fixture" } });
        assert.equal(result.isError === true, action !== "accept");
        assert.equal(prompts, action === "read-scope" ? 0 : 1);
        assert.equal(writes.mock.callCount() - before, action === "accept" ? 1 : 0);
      });
    }
  }
});
