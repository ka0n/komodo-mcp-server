// Portable reproduction: copy into docs/research of the exact integration or
// upstream 1.5.1 checkout, build, then run with the pinned framework installed.
// Prints validity and disclosure flags only; never prints exported credentials.
import "../../build/utils/polyfills.js";
import { mock } from "node:test";
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
import { parse, stringify } from "smol-toml";
import { KomodoClient, configureKomodoConnections, stopKomodoConnections } from "../../build/client.js";
import { config, ToolScopes } from "../../build/config/index.js";
import { resolveScrubOptions } from "../../build/utils/redact.js";
import { exportAllResourcesToTomlTool, exportResourcesToTomlTool } from "../../build/tools/toml.js";
import { getStackInfoTool } from "../../build/tools/stack.js";
import { getContainerLogsTool } from "../../build/tools/container.js";

config.MCP_SECRET_SCRUB_ENABLED = true;
config.MCP_RESOURCE_RESPONSE_MODE = "link";
const secret = "synthetic-private-credential-739";
const fixture = KomodoClient.connectWithApiKey("https://komodo.invalid", "synthetic-key", "synthetic-secret");
mock.method(KomodoClient, "ping", async () => ({ reachable: true }));
mock.method(KomodoClient, "connectWithApiKey", () => fixture);
mock.method(fixture, "healthCheck", async () => ({ healthy: true }));
mock.method(globalThis, "fetch", () => {
  throw new Error("Unexpected external request");
});
let document;
let environment;
mock.method(fixture.client, "read", async (type) =>
  type === "GetStack"
    ? { name: "fixture", config: { environment } }
    : type === "GetContainerLog"
      ? { stdout: environment, stderr: "" }
      : { toml: document },
);
Object.assign(process.env, {
  KOMODO_URL: "https://komodo.invalid",
  KOMODO_API_KEY: "synthetic-key",
  KOMODO_API_SECRET: "synthetic-secret",
});
await configureKomodoConnections({ anonymousMode: true });
const scrubber = createSecretScrubber(resolveScrubOptions());
const registry = configureDynamicResourceRegistry({ scrub: resolveScrubOptions(), cleanupIntervalMs: 0 });
const sdk = new McpServer({ name: "repro", version: "1" });
const client = new Client({ name: "repro", version: "1" });
const [ct, st] = InMemoryTransport.createLinkedPair();
st.sessionId = "owner";
const tools = ToolRegistry.createIsolated();
for (const tool of [exportAllResourcesToTomlTool, exportResourcesToTomlTool, getStackInfoTool, getContainerLogsTool])
  tools.registerFromFactory(tool);
ToolRegistry.bindToSdk(sdk, tools.getTools(), {
  logger,
  stateless: false,
  anonymousScopes: [ToolScopes.READ],
  resultScrubber: scrubber,
});
const resources = ResourceRegistry.createIsolated();
resources.registerTemplateFromFactory(defineDynamicResourceTemplate({ registry }));
ResourceRegistry.bindToSdk(sdk, [], resources.getTemplates(), { logger, resultScrubber: scrubber });
const valid = (value) => {
  try {
    parse(value);
    return true;
  } catch {
    return false;
  }
};
const results = [];
try {
  await sdk.connect(st);
  await client.connect(ct);
  for (const [scenario, raw] of [
    ["escaped-quotes", stringify({ config: { environment: `password="${secret}"` } })],
    ["multiline", stringify({ config: { environment: `HOST=db\npassword="${secret}"\nTAIL=ok` } })],
    ["triple-quoted", `password="""${secret}\nsecond-line"""\nname="kept"\n`],
    ["literal-triple-quoted", `password='''${secret}\nsecond-line'''\nname="kept"\n`],
    ["escaped-quotes-in-environment", stringify({ config: { environment: `password=\\"${secret}\\"` } })],
    [
      "multiline-escaped-environment",
      stringify({ config: { environment: `HOST=db\npassword=\\"${secret}\\"\nTAIL=ok` } }),
    ],
    ["triple-quotes-in-environment", stringify({ config: { environment: `password="""${secret}"""` } })],
    ["escaped-quote-inside-password", stringify({ config: { environment: `password="prefix\\"${secret}"` } })],
  ]) {
    document = raw;
    for (const tool of [exportAllResourcesToTomlTool, exportResourcesToTomlTool]) {
      for (const inline_full of [true, false]) {
        const result = await client.callTool({ name: tool.name, arguments: { inline_full } });
        const payload = result.structuredContent;
        const row = {
          scenario,
          format: "toml",
          tool: tool.name,
          inline_full,
          withheld: result.isError === true,
          leaked: JSON.stringify(result).includes(secret),
        };
        if (payload?.toml !== undefined) {
          row.structuredValid = valid(payload.toml);
          const text = result.content.find((block) => block.type === "text")?.text ?? "";
          const rendered = text.match(/```toml\n([\s\S]*?)\n```/);
          row.renderedValid = !!rendered && valid(rendered[1]);
        }
        if (payload?.resourceLink) {
          const stored = registry.read(payload.resourceLink.uri, "owner").content;
          const read = await client.readResource({ uri: payload.resourceLink.uri });
          const text = read.contents[0]?.text;
          row.registeredValid = valid(stored);
          row.readValid = valid(text);
          row.readMatchesRegistered = text === stored;
          row.bytesMatch = payload.summary.bytes === Buffer.byteLength(text);
          row.leaked ||= JSON.stringify(read).includes(secret);
        }
        results.push(row);
      }
    }
  }
  // The underlying heuristic limitation also affects JSON-embedded configuration
  // strings and plain logs. Removing TOML exposure alone is not a complete fix.
  for (environment of [`password=\\"${secret}\\"`, `password="""${secret}"""`]) {
    for (const [tool, args, format] of [
      [getStackInfoTool, { stack: "s" }, "json"],
      [getContainerLogsTool, { server: "s", container: "c" }, "logs"],
    ]) {
      for (const inline_full of [true, false]) {
        const result = await client.callTool({ name: tool.name, arguments: { ...args, inline_full } });
        const row = {
          scenario: environment.includes('"""') ? "nested-triple-quotes" : "nested-escaped-quotes",
          format,
          tool: tool.name,
          inline_full,
          withheld: result.isError === true,
          leaked: JSON.stringify(result).includes(secret),
        };
        const uri = result.structuredContent?.resourceLink?.uri;
        if (uri) row.leaked ||= JSON.stringify(await client.readResource({ uri })).includes(secret);
        results.push(row);
      }
    }
  }
  const violations = {
    disclosures: results.filter((row) => row.leaked).length,
    invalidDocuments: results.filter(
      (row) =>
        row.structuredValid === false ||
        row.renderedValid === false ||
        row.registeredValid === false ||
        row.readValid === false,
    ).length,
    byteMismatches: results.filter((row) => row.bytesMatch === false).length,
  };
  console.log(JSON.stringify({ results, violations }, null, 2));
  // Deliberately fail on inherited defects too. Do not turn a known disclosure
  // into a passing test or conflate this with the passing guard regressions.
  if (Object.values(violations).some((count) => count > 0)) process.exitCode = 1;
} finally {
  await client.close();
  await sdk.close();
  registry.clear();
  stopKomodoConnections();
  mock.restoreAll();
}
