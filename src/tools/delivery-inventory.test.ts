import "../utils/polyfills.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  configureDynamicResourceRegistry,
  defineDynamicResourceTemplate,
  logger,
  ResourceRegistry,
  ToolRegistry,
} from "mcp-server-framework";
import { createSecretScrubber } from "mcp-server-framework/logger";
import { KomodoClient, configureKomodoConnections, stopKomodoConnections } from "../client.js";
import { config, ToolScopes } from "../config/index.js";
import { resolveScrubOptions } from "../utils/redact.js";
import { getActionInfoTool } from "./action.js";
import { getAlerterInfoTool } from "./alerter.js";
import { getBuildInfoTool } from "./build.js";
import { getBuilderInfoTool } from "./builder.js";
import { getDeploymentInfoTool } from "./deployment.js";
import { getProcedureInfoTool } from "./procedure.js";
import { getRepoInfoTool } from "./repo.js";
import { getResourceSyncInfoTool } from "./resource-sync.js";
import { getServerInfoTool } from "./server.js";
import { getSwarmInfoTool } from "./swarm.js";
import { getUpdateInfoTool } from "./update.js";
import {
  inspectDockerImageTool,
  getDockerImageHistoryTool,
  inspectDockerNetworkTool,
  inspectDockerVolumeTool,
} from "./docker.js";

// The other seven adaptive tools (stack, container inspect, three log tools,
// two TOML tools) are covered in resource-response.test and inline-hardening.test.
test("remaining adaptive tool inventory preserves schemas, full data and redaction", async (t) => {
  const savedConfig = { ...config },
    savedEnv = { ...process.env };
  config.MCP_SECRET_SCRUB_ENABLED = true;
  const scrubber = createSecretScrubber(resolveScrubOptions());
  const registry = configureDynamicResourceRegistry({ scrub: resolveScrubOptions(), cleanupIntervalMs: 0 });
  const fixture = KomodoClient.connectWithApiKey("https://komodo.invalid", "synthetic-key", "synthetic-secret");
  t.mock.method(KomodoClient, "ping", async () => ({ reachable: true }));
  t.mock.method(KomodoClient, "connectWithApiKey", () => fixture);
  t.mock.method(fixture, "healthCheck", async () => ({ healthy: true }));
  t.mock.method(fixture.client, "core_version", async () => "2.3.1");
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected external request");
  });
  const secret = "synthetic-inventory-private-749";
  const marker = "é漢😀-complete-compose-end";
  const object = {
    _id: { $oid: "fixture" },
    name: "fixture",
    info: { state: "running" },
    config: {
      environment: `API_TOKEN=${secret}\nHOST=db`,
      file_contents: `services:\n  app:\n    image: fixture:latest\n# ${marker}`,
      passkey: secret,
    },
    Config: { Env: [`API_TOKEN=${secret}`, "HOST=db"] },
    marker,
    operation: "RunSync",
    status: "Complete",
    success: true,
    start_ts: 1,
    target: { type: "Stack", id: "s" },
    logs: [],
  };
  t.mock.method(fixture.client, "read", async (type: string) =>
    type === "ListDockerImageHistory"
      ? [{ Id: "layer", Created: 1, CreatedBy: `RUN echo ${marker}`, Size: 10 }]
      : object,
  );
  Object.assign(process.env, {
    KOMODO_URL: "https://komodo.invalid",
    KOMODO_API_KEY: "synthetic-key",
    KOMODO_API_SECRET: "synthetic-secret",
  });
  const sdk = new McpServer({ name: "inventory", version: "1" });
  const client = new Client({ name: "inventory", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  st.sessionId = "owner";
  t.after(async () => {
    await client.close();
    await sdk.close();
    registry.clear();
    stopKomodoConnections();
    Object.assign(config, savedConfig);
    process.env = savedEnv;
  });
  await configureKomodoConnections({ anonymousMode: true });
  const entries = [
    [getActionInfoTool, { action_id: "s" }],
    [getAlerterInfoTool, { alerter: "s" }],
    [getBuildInfoTool, { build: "s" }],
    [getBuilderInfoTool, { builder: "s" }],
    [getDeploymentInfoTool, { deployment: "s" }],
    [getProcedureInfoTool, { procedure: "s" }],
    [getRepoInfoTool, { repo: "s" }],
    [getResourceSyncInfoTool, { resource_sync: "s" }],
    [getServerInfoTool, { server: "s" }],
    [getSwarmInfoTool, { swarm: "s" }],
    [getUpdateInfoTool, { id: "s" }],
    [inspectDockerImageTool, { server: "s", image: "i" }],
    [getDockerImageHistoryTool, { server: "s", image: "i" }],
    [inspectDockerNetworkTool, { server: "s", network: "n" }],
    [inspectDockerVolumeTool, { server: "s", volume: "v" }],
  ] as const;
  const tools = ToolRegistry.createIsolated();
  for (const [tool] of entries) tools.registerFromFactory(tool);
  ToolRegistry.bindToSdk(sdk, tools.getTools(), {
    logger,
    stateless: false,
    anonymousScopes: [ToolScopes.READ],
    resultScrubber: scrubber,
  });
  const resources = ResourceRegistry.createIsolated();
  resources.registerTemplateFromFactory(defineDynamicResourceTemplate({ registry }));
  ResourceRegistry.bindToSdk(sdk, [], resources.getTemplates(), { logger, resultScrubber: scrubber });
  await sdk.connect(st);
  await client.connect(ct);
  const listed = (await client.listTools()).tools;
  for (const mode of ["link", "inline", "auto"] as const) {
    config.MCP_RESOURCE_RESPONSE_MODE = mode;
    config.MCP_RESOURCE_INLINE_THRESHOLD_BYTES = 1;
    for (const [tool, args] of entries) {
      await t.test(`${mode}: ${tool.name}`, async () => {
        registry.clear();
        assert.ok(listed.find((entry) => entry.name === tool.name)?.outputSchema);
        const result = await client.callTool({ name: tool.name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.ok(!JSON.stringify(result).includes(secret));
        const payload = result.structuredContent as Record<string, unknown>;
        let full: unknown;
        if (mode === "inline") {
          assert.equal(payload["resourceLink"], undefined);
          full = payload["info"] ?? payload["inspect"] ?? payload["items"];
          assert.equal(registry.size, 0);
        } else {
          const uri = (payload["resourceLink"] as { uri: string }).uri;
          const resource = await client.readResource({ uri });
          const block = resource.contents[0];
          assert.ok(block && "text" in block);
          assert.equal(block.mimeType, "application/json");
          full = JSON.parse(block.text);
        }
        assert.ok(!JSON.stringify(full).includes(secret));
        assert.ok(
          JSON.stringify(full).includes(marker),
          "delivery must retain complete public data including Compose content",
        );
      });
    }
  }
});
