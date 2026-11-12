// Run after npm run build in a disposable, pinned-dependency checkout:
// node docs/research/inline-hardening-benchmark.mjs > benchmark.json
// Each sample runs in a fresh child; RSS includes runtime/framework startup.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scenarios = ["json", "logs", "quotes", "toml", "small-strings", "repeated-redaction", "auto-at", "auto-over"];
if (process.argv[2] !== "--worker") {
  const results = [];
  for (const scenario of scenarios) {
    for (const mode of ["link", "inline", "auto"]) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker", scenario, mode], {
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LOG_LEVEL: "error", MCP_SECRET_SCRUB_ENABLED: "true" },
      });
      if (child.status !== 0) throw new Error(`Benchmark failed: ${scenario}/${mode}: ${child.stderr}`);
      results.push(JSON.parse(child.stdout.trim()));
    }
  }
  console.log(JSON.stringify({ node: process.version, iterations: 8, results }, null, 2));
} else {
  await import("../../build/utils/polyfills.js");
  const { mock } = await import("node:test");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { ToolRegistry, ResourceRegistry, defineDynamicResourceTemplate, configureDynamicResourceRegistry, logger } =
    await import("mcp-server-framework");
  const { createSecretScrubber } = await import("mcp-server-framework/logger");
  const { stringify } = await import("smol-toml");
  const { config, ToolScopes } = await import("../../build/config/index.js");
  const { resolveScrubOptions } = await import("../../build/utils/redact.js");
  const { tryRegisterResource } = await import("../../build/utils/resource-link.js");
  const { KomodoClient, configureKomodoConnections, stopKomodoConnections } = await import("../../build/client.js");
  const { getStackInfoTool } = await import("../../build/tools/stack.js");
  const { getContainerLogsTool } = await import("../../build/tools/container.js");
  const { exportAllResourcesToTomlTool } = await import("../../build/tools/toml.js");
  const [scenario, mode] = process.argv.slice(3);
  config.MCP_RESOURCE_RESPONSE_MODE = mode;
  config.MCP_RESOURCE_INLINE_THRESHOLD_BYTES = 16384;
  config.MCP_SECRET_SCRUB_ENABLED = true;
  const scrubber = createSecretScrubber(resolveScrubOptions());
  const registry = configureDynamicResourceRegistry({ scrub: resolveScrubOptions(), cleanupIntervalMs: 0 });
  const fixture = KomodoClient.connectWithApiKey("https://komodo.invalid", "synthetic-key", "synthetic-secret");
  mock.method(KomodoClient, "ping", async () => ({ reachable: true }));
  mock.method(KomodoClient, "connectWithApiKey", () => fixture);
  mock.method(fixture, "healthCheck", async () => ({ healthy: true }));
  mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected external request");
  });
  Object.assign(process.env, {
    KOMODO_URL: "https://komodo.invalid",
    KOMODO_API_KEY: "synthetic-key",
    KOMODO_API_SECRET: "synthetic-secret",
  });
  await configureKomodoConnections({ anonymousMode: true });
  const text = "benign-é漢😀-line\n".repeat(50000);
  const data =
    scenario === "small-strings" || scenario === "repeated-redaction"
      ? {
          name: "fixture",
          config: Object.fromEntries(
            Array.from({ length: 12000 }, (_, i) => [
              `k${i}`,
              { note: "ordinary text", password: "synthetic-private" },
            ]),
          ),
        }
      : { name: "fixture", config: { note: text, password: "synthetic-private" } };
  const document =
    scenario === "quotes"
      ? stringify({ config: { environment: 'password="synthetic-private"', note: '\\"'.repeat(100000) } })
      : stringify({ config: { note: text, password: "synthetic-private" } });
  mock.method(fixture.client, "read", async (type) =>
    type.startsWith("Export") ? { toml: document } : type === "GetContainerLog" ? { stdout: text, stderr: "" } : data,
  );
  const sdk = new McpServer({ name: "benchmark", version: "1" });
  const client = new Client({ name: "benchmark", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  st.sessionId = "benchmark-owner";
  const tools = ToolRegistry.createIsolated();
  for (const tool of [getStackInfoTool, getContainerLogsTool, exportAllResourcesToTomlTool])
    tools.registerFromFactory(tool);
  ToolRegistry.bindToSdk(sdk, tools.getTools(), {
    logger,
    stateless: false,
    resultScrubber: scrubber,
    anonymousScopes: [ToolScopes.READ],
  });
  const resources = ResourceRegistry.createIsolated();
  resources.registerTemplateFromFactory(defineDynamicResourceTemplate({ registry }));
  ResourceRegistry.bindToSdk(sdk, [], resources.getTemplates(), { logger, resultScrubber: scrubber });
  await sdk.connect(st);
  await client.connect(ct);
  const isToml = scenario === "quotes" || scenario === "toml";
  const name = isToml
    ? exportAllResourcesToTomlTool.name
    : scenario === "logs"
      ? getContainerLogsTool.name
      : getStackInfoTool.name;
  const args = isToml ? {} : scenario === "logs" ? { server: "s", container: "c" } : { stack: "s" };
  let serializationNs = 0n,
    resultBytes = 0,
    failed = 0,
    linked = 0;
  let payloadSerializations = 0;
  const originalStringify = JSON.stringify;
  JSON.stringify = function (value, ...rest) {
    if (value === data) payloadSerializations++;
    return originalStringify(value, ...rest);
  };
  async function run(measured) {
    registry.clear();
    if (scenario.startsWith("auto-")) {
      const content = "é".repeat(8192) + (scenario === "auto-over" ? "x" : "");
      const link = tryRegisterResource({
        ctx: { sessionId: st.sessionId },
        category: "logs",
        name: "boundary",
        mimeType: "text/plain",
        content,
        ttlMs: 60000,
      });
      if (measured) {
        linked += Number(!!link);
        resultBytes += Buffer.byteLength(content);
      }
      return;
    }
    if (scenario === "repeated-redaction") {
      let value = data;
      for (let i = 0; i < 5; i++) value = scrubber.scrubStructured(value);
    }
    const result = await client.callTool({ name, arguments: args });
    const start = process.hrtime.bigint();
    const wire = JSON.stringify(result);
    const elapsed = process.hrtime.bigint() - start;
    if (measured) {
      serializationNs += elapsed;
      resultBytes += Buffer.byteLength(wire);
      failed += Number(result.isError === true);
    }
    const link = result.structuredContent?.resourceLink;
    if (link) {
      await client.readResource({ uri: link.uri });
      if (measured) linked++;
    }
  }
  try {
    for (let i = 0; i < 2; i++) await run(false);
    payloadSerializations = 0;
    const cpuStart = process.cpuUsage(),
      start = process.hrtime.bigint();
    for (let i = 0; i < 8; i++) await run(true);
    const cpu = process.cpuUsage(cpuStart);
    console.log(
      JSON.stringify({
        scenario,
        mode,
        wallMs: Number(process.hrtime.bigint() - start) / 8e6,
        cpuMs: (cpu.user + cpu.system) / 8000,
        peakRssKiB: process.resourceUsage().maxRSS,
        serializationMs: Number(serializationNs) / 8e6,
        resultBytes: resultBytes / 8,
        payloadSerializations: payloadSerializations / 8,
        failed,
        linked,
      }),
    );
  } finally {
    JSON.stringify = originalStringify;
    await client.close();
    await sdk.close();
    stopKomodoConnections();
    registry.clear();
    mock.restoreAll();
  }
}
