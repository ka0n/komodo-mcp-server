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
import { createSecretScrubber, SecretScrubber, Logger } from "mcp-server-framework/logger";
import { parse, stringify } from "smol-toml";
import { KomodoClient, configureKomodoConnections, stopKomodoConnections } from "../client.js";
import { config, ToolScopes } from "../config/index.js";
import { resolveScrubOptions } from "../utils/redact.js";
import { exportAllResourcesToTomlTool, exportResourcesToTomlTool } from "./toml.js";

// Only synthetic credentials. Assert both representations and the real resource
// read boundary; registry-only tests cannot establish resources/read behavior.
test("TOML delivery withholds unstable inline serialization and preserves structural links", async (t) => {
  const savedConfig = { ...config };
  const savedEnv = { ...process.env };
  config.MCP_SECRET_SCRUB_ENABLED = true;
  const scrubber = createSecretScrubber(resolveScrubOptions());
  assert.ok(scrubber);
  const registry = configureDynamicResourceRegistry({
    maxEntries: 2,
    scrub: resolveScrubOptions(),
    cleanupIntervalMs: 0,
  });
  const fixture = KomodoClient.connectWithApiKey("https://komodo.invalid", "fixture-key", "fixture-secret");
  t.mock.method(KomodoClient, "ping", async () => ({ reachable: true }));
  t.mock.method(KomodoClient, "connectWithApiKey", () => fixture);
  t.mock.method(fixture, "healthCheck", async () => ({ healthy: true }));
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected external request");
  });
  let document = "";
  t.mock.method(fixture.client, "read", async () => ({ toml: document }));
  Object.assign(process.env, {
    KOMODO_URL: "https://komodo.invalid",
    KOMODO_API_KEY: "fixture-key",
    KOMODO_API_SECRET: "fixture-secret",
  });
  const sdk = new McpServer({ name: "toml-hardening", version: "1" });
  const client = new Client({ name: "fixture", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  st.sessionId = "owner";
  t.after(async () => {
    await client.close();
    await sdk.close();
    stopKomodoConnections();
    registry.clear();
    Object.assign(config, savedConfig);
    process.env = savedEnv;
  });
  await configureKomodoConnections({ anonymousMode: true });
  const tools = ToolRegistry.createIsolated();
  for (const tool of [exportAllResourcesToTomlTool, exportResourcesToTomlTool]) tools.registerFromFactory(tool);
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

  const secret = "synthetic-private-credential-739";
  const cases = [
    {
      name: "escaped environment quotes",
      raw: stringify({ config: { environment: `password="${secret}"` } }),
      unstable: true,
    },
    {
      name: "multiline environment",
      raw: stringify({ config: { environment: `HOST=db\npassword="${secret}"\nTAIL=ok` } }),
      unstable: false,
    },
    {
      name: "triple quoted sensitive key",
      raw: `password = """${secret}\nsecond-line"""\nname = "kept"\n`,
      unstable: false,
    },
    {
      name: "literal triple quoted sensitive key",
      raw: `password = '''${secret}\nsecond-line'''\nname = "kept"\n`,
      unstable: false,
    },
    { name: "multiline ordinary content", raw: 'note = """first\nsecond\nthird"""\nname = "kept"\n', unstable: false },
    {
      name: "structural variable rule",
      raw: `[[variable]]\nis_secret=true\nvalue="${secret}"\nname="kept"\n`,
      unstable: false,
    },
    {
      name: "large quote-heavy export",
      raw: stringify({ config: { environment: `password="${secret}"`, note: '\\"'.repeat(100000) } }),
      unstable: true,
    },
    { name: "large stable export", raw: stringify({ note: "é漢😀".repeat(20000), name: "kept" }), unstable: false },
  ];
  for (const entry of cases) {
    document = entry.raw;
    const canonical = stringify(scrubber.scrubObject(parse(document)));
    // Retain a direct reproduction of the pinned framework defect.
    if (entry.unstable) assert.notEqual(scrubber.scrub(canonical), canonical);
    for (const delivery of [
      "link",
      "inline",
      "auto-small",
      "auto-large",
      "inline-full",
      "missing-session",
      "failed-register",
    ] as const) {
      await t.test(`${entry.name}: ${delivery}`, async (stt) => {
        registry.clear();
        config.MCP_RESOURCE_RESPONSE_MODE = delivery.startsWith("auto")
          ? "auto"
          : delivery === "inline"
            ? "inline"
            : "link";
        config.MCP_RESOURCE_INLINE_THRESHOLD_BYTES = delivery === "auto-small" ? Buffer.byteLength(document) : 1;
        if (delivery === "missing-session") delete st.sessionId;
        else st.sessionId = "owner";
        if (delivery === "failed-register")
          stt.mock.method(registry, "register", () => {
            throw new Error("fixture failure");
          });
        const linked = delivery === "link" || delivery === "auto-large";
        for (const tool of tools.getTools()) {
          const response = await client.callTool({
            name: tool.name,
            arguments: { inline_full: delivery === "inline-full" },
          });
          assert.ok(!JSON.stringify(response).includes(secret));
          if (entry.unstable && !linked) {
            assert.equal(response.isError, true, "unsafe inline delivery must be an explicit failure");
            assert.equal(response.structuredContent, undefined);
            assert.match(
              JSON.stringify(response.content),
              /TOML export withheld: inline serialization is not stable under secret redaction/,
            );
            assert.equal(registry.size, 0);
            continue;
          }
          assert.notEqual(response.isError, true, JSON.stringify(response));
          const payload = response.structuredContent as {
            toml?: string;
            resourceLink?: { uri: string };
            summary: { bytes: number };
          };
          let delivered: string;
          if (linked) {
            assert.ok(payload.resourceLink);
            const stored = registry.read(payload.resourceLink.uri, "owner");
            assert.equal(stored.content, canonical, "registration must preserve canonical TOML");
            const read = await client.readResource({ uri: payload.resourceLink.uri });
            const block = read.contents[0];
            assert.ok(block && "text" in block);
            assert.equal(block.mimeType, "application/toml");
            delivered = block.text;
            st.sessionId = "intruder";
            await assert.rejects(client.readResource({ uri: payload.resourceLink.uri }), /Cross-session/);
            st.sessionId = "owner";
          } else {
            assert.ok(typeof payload.toml === "string");
            delivered = payload.toml;
            const rendered = (response.content as { type: string; text?: string }[]).find(
              (block) => block.type === "text",
            )?.text;
            assert.ok(rendered);
            if (canonical.length < 2000)
              assert.ok(rendered.includes(canonical), "rendered TOML must preserve serialization too");
          }
          assert.equal(delivered, canonical);
          assert.equal(payload.summary.bytes, Buffer.byteLength(delivered));
          assert.deepEqual(parse(delivered), parse(canonical));
          assert.ok(!delivered.includes(secret));
        }
      });
    }
  }
  await t.test("resources/read enforces session, capacity eviction and expiration", async (stt) => {
    registry.clear();
    config.MCP_RESOURCE_RESPONSE_MODE = "link";
    st.sessionId = "owner";
    document = 'name = "kept"\n';
    stt.mock.timers.enable({ apis: ["Date"], now: 1000 });
    const uris: string[] = [];
    for (let index = 0; index < 3; index++) {
      const response = await client.callTool({ name: exportAllResourcesToTomlTool.name, arguments: {} });
      assert.notEqual(response.isError, true);
      uris.push((response.structuredContent as { resourceLink: { uri: string } }).resourceLink.uri);
    }
    assert.equal(registry.size, 2);
    const [evicted, live] = uris;
    assert.ok(evicted && live);
    await assert.rejects(client.readResource({ uri: evicted }), /not found/i);
    await client.readResource({ uri: live });
    delete st.sessionId;
    await assert.rejects(client.readResource({ uri: live }), /session/i);
    st.sessionId = "owner";
    stt.mock.timers.tick(config.MCP_RESOURCE_TTL_INFO);
    await assert.rejects(client.readResource({ uri: live }), /not found/i);
    registry.clear();
  });
  await t.test("custom sensitive TOML field fails closed rather than returning an invalid document", async () => {
    document = 'name = "kept"\n';
    config.MCP_RESOURCE_RESPONSE_MODE = "inline";
    config.MCP_SECRET_SCRUB_KEYS = ["toml"];
    try {
      for (const tool of tools.getTools()) {
        const response = await client.callTool({ name: tool.name, arguments: {} });
        assert.equal(response.isError, true);
        assert.equal(response.structuredContent, undefined);
      }
    } finally {
      config.MCP_SECRET_SCRUB_KEYS = savedConfig.MCP_SECRET_SCRUB_KEYS;
    }
  });
  await t.test("inline preflight failure withholds the export without exposing the cause", async (stt) => {
    document = `password="${secret}"\n`;
    config.MCP_RESOURCE_RESPONSE_MODE = "inline";
    const logs = (["warn", "error"] as const).map((level) => stt.mock.method(Logger.prototype, level, () => {}));
    const original = SecretScrubber.prototype.scrubStructured;
    stt.mock.method(
      SecretScrubber.prototype,
      "scrubStructured",
      function (this: SecretScrubber, value: unknown, collector?: Set<string>) {
        if (value && typeof value === "object" && "toml" in value) throw new Error(secret);
        return original.call(this, value, collector);
      },
    );
    for (const tool of tools.getTools()) {
      const response = await client.callTool({ name: tool.name, arguments: {} });
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent, undefined);
      assert.ok(!JSON.stringify(response).includes(secret));
      assert.match(JSON.stringify(response), /inline serialization validation failed/);
    }
    for (const log of logs) assert.equal(log.mock.callCount(), 0);
  });
});
