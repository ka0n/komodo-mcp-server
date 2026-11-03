// Must precede komodo_client's import chain.
import "../utils/polyfills.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logger, ToolRegistry } from "mcp-server-framework";
import { config, ToolScopes } from "../config/index.js";
import { KomodoClient, configureKomodoConnections, stopKomodoConnections } from "../client.js";
import { deleteStackTool } from "./stack.js";

// Exercise the SDK/framework boundary with a real destructive handler. All
// downstream calls are mocked; no stack or production connection is touched.
test("SDK upgrade preserves scope checks and destructive-action elicitation", async (t) => {
  const originalConfig = { ...config };
  const originalEnv = { ...process.env };
  t.after(() => {
    stopKomodoConnections();
    Object.assign(config, originalConfig);
    process.env = originalEnv;
  });
  config.MCP_CONFIRM_DESTRUCTIVE = true;
  config.MCP_CONFIRM_FALLBACK = "deny";
  const fixture = KomodoClient.connectWithApiKey("https://komodo.invalid", "test-key", "test-secret");
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network access in SDK compatibility tests");
  });
  t.mock.method(KomodoClient, "ping", async () => ({ reachable: true }));
  t.mock.method(KomodoClient, "connectWithApiKey", () => fixture);
  t.mock.method(fixture, "healthCheck", async () => ({ healthy: true }));
  const writes = t.mock.method(fixture.client, "write", async () => ({ name: "test-stack" }));
  process.env["KOMODO_URL"] = "https://komodo.invalid";
  process.env["KOMODO_API_KEY"] = "test-key";
  process.env["KOMODO_API_SECRET"] = "test-secret";
  await configureKomodoConnections({ anonymousMode: true });
  const registry = ToolRegistry.createIsolated();
  registry.registerFromFactory(deleteStackTool);

  for (const scenario of [
    { name: "read scope cannot delete", scope: ToolScopes.READ, reply: "accept", allowed: false, prompts: 0 },
    {
      name: "invalid arguments cannot execute",
      scope: ToolScopes.ADMIN,
      reply: "accept",
      invalid: true,
      allowed: false,
      prompts: 0,
    },
    { name: "missing elicitation fails closed", scope: ToolScopes.ADMIN, allowed: false, prompts: 0 },
    { name: "declined approval cannot execute", scope: ToolScopes.ADMIN, reply: "decline", allowed: false, prompts: 1 },
    { name: "cancelled approval cannot execute", scope: ToolScopes.ADMIN, reply: "cancel", allowed: false, prompts: 1 },
    { name: "accepted approval executes once", scope: ToolScopes.ADMIN, reply: "accept", allowed: true, prompts: 1 },
  ] as const) {
    await t.test(scenario.name, async (st) => {
      const sdk = new McpServer({ name: "sdk-compatibility-test", version: "1.0.0" });
      const client = new Client(
        { name: "test-client", version: "1.0.0" },
        { capabilities: { ...("reply" in scenario ? { elicitation: { form: {} } } : {}) } },
      );
      st.after(async () => {
        await client.close();
        await sdk.close();
      });
      let prompts = 0;
      if ("reply" in scenario) {
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          prompts++;
          assert.match(request.params.message, /Delete stack "test-stack"/);
          return { action: scenario.reply, ...(scenario.reply === "accept" ? { content: {} } : {}) };
        });
      }
      ToolRegistry.bindToSdk(sdk, registry.getTools(), {
        stateless: false,
        logger,
        anonymousScopes: [scenario.scope],
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await sdk.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools[0];
      assert.equal(advertised?.annotations?.destructiveHint, true);
      const before = writes.mock.callCount();
      const response = await client.callTool({
        name: deleteStackTool.name,
        arguments: { stack: "invalid" in scenario ? 123 : "test-stack" },
      });
      assert.equal(response.isError === true, !scenario.allowed, JSON.stringify(response));
      assert.equal(prompts, scenario.prompts);
      assert.equal(writes.mock.callCount() - before, scenario.allowed ? 1 : 0);
      if (scenario.allowed) {
        assert.deepEqual(writes.mock.calls.at(-1)?.arguments, ["DeleteStack", { id: "test-stack" }]);
      }
    });
  }
});
