import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse, stringify } from "smol-toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const secret = "synthetic-sensitive-value-longer-than-marker";
const raw = stringify({
  stack: [
    {
      name: "fixture-☃",
      config: {
        file_contents: `password="${secret}"\nnext: visible`,
        environment: `https://fixture.invalid/?password=${secret}&visible=yes`,
        deployed_config: { text: secret },
      },
    },
  ],
  variable: [{ name: "fixture", is_secret: true, value: secret }],
  server: [{ config: { passkey: secret } }],
  alerter: [{ config: { endpoint: { params: { url: secret } } } }],
});

await test("upstream TOML tools deliver valid redacted inline and linked exports with exact UTF-8 sizes", async (t) => {
  let writes = 0;
  const downstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/version") {
      res.end('"2.3.1"');
      return;
    }
    if (req.url === "/read/GetVersion") {
      res.end(JSON.stringify({ version: "2.3.1" }));
      return;
    }
    if (req.url?.startsWith("/write/")) writes++;
    if (req.url === "/read/ExportAllResourcesToToml" || req.url === "/read/ExportResourcesToToml") {
      res.end(JSON.stringify({ toml: raw }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Unexpected fixture endpoint" }));
  });
  downstream.listen(0, "127.0.0.1");
  await once(downstream, "listening");
  t.after(() => new Promise<void>((resolve, reject) => downstream.close((err) => (err ? reject(err) : resolve()))));
  const address = downstream.address();
  assert.ok(address && typeof address !== "string");
  for (const enabled of [true, false]) {
    await t.test(`redaction=${enabled}`, async (st) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [process.env["KOMODO_TOML_TEST_ENTRY"] ?? fileURLToPath(new URL("../index.js", import.meta.url))],
        stderr: "pipe",
        env: {
          PATH: process.env["PATH"] ?? "",
          MCP_TRANSPORT: "stdio",
          LOG_LEVEL: "error",
          KOMODO_URL: `http://127.0.0.1:${address.port}`,
          KOMODO_API_KEY: "fixture-key",
          KOMODO_API_SECRET: "fixture-secret",
          MCP_SECRET_SCRUB_ENABLED: String(enabled),
          MCP_TOOLS_ALLOWED_CATEGORIES: "toml",
        },
      });
      transport.stderr?.on("data", () => {});
      const client = new Client({ name: "upstream-toml-regression", version: "1" });
      st.after(() => client.close());
      await client.connect(transport);
      for (const tool of ["komodo_toml_export_all", "komodo_toml_export_resources"]) {
        let inline: string | undefined;
        for (const inlineFull of [true, false]) {
          await st.test(`${tool}: inline_full=${inlineFull}`, async () => {
            const result = await client.callTool({ name: tool, arguments: { inline_full: inlineFull } });
            assert.notEqual(result.isError, true, JSON.stringify(result));
            const payload = result.structuredContent as {
              summary: { bytes: number; secrets_masked: boolean };
              toml?: string;
              resourceLink?: { uri: string };
            };
            let toml: string;
            if (inlineFull) {
              assert.equal(typeof payload.toml, "string");
              assert.equal(payload.resourceLink, undefined);
              toml = payload.toml ?? "";
              inline = toml;
              const content = result.content as { type: string; text?: string }[];
              const text = content.find((block) => block.type === "text")?.text;
              assert.ok(text?.includes(`\`\`\`toml\n${toml}\n\`\`\``), "rendered and structured TOML must agree");
            } else {
              assert.equal(payload.toml, undefined);
              assert.ok(payload.resourceLink);
              const read = await client.readResource({ uri: payload.resourceLink.uri });
              const item = read.contents[0];
              assert.ok(item && "text" in item && typeof item.text === "string");
              toml = item.text;
              assert.equal(toml, inline, "linked and inline output must agree");
            }
            assert.doesNotThrow(() => parse(toml));
            assert.equal(payload.summary.bytes, Buffer.byteLength(toml, "utf8"));
            assert.equal(payload.summary.secrets_masked, enabled);
            assert.ok(JSON.stringify(result).includes(`${payload.summary.bytes} bytes`));
            if (enabled) {
              assert.ok(!toml.includes(secret));
              assert.ok(!JSON.stringify(result).includes(secret));
              const doc = parse(toml);
              assert.equal((doc["variable"] as { is_secret: boolean }[])[0]?.is_secret, true);
              assert.ok(!toml.includes("deployed_config"));
            } else assert.equal(toml, raw);
          });
        }
      }
    });
  }
  assert.equal(writes, 0);
});
