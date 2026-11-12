// Known upstream issue tracked separately in PR #251. Never invokes a write.
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let writeCalls = 0;
const fixture = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/version") return res.end('"2.3.1"');
  if (req.url?.startsWith("/write/") || req.url?.startsWith("/execute/")) writeCalls++;
  res.statusCode = 500;
  res.end('{"error":"unexpected synthetic fixture request"}');
});
fixture.listen(0, "127.0.0.1");
await once(fixture, "listening");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../../build/index.js", import.meta.url))],
  stderr: "pipe",
  env: {
    PATH: process.env.PATH ?? "",
    LOG_LEVEL: "error",
    MCP_TRANSPORT: "stdio",
    KOMODO_URL: `http://127.0.0.1:${fixture.address().port}`,
    KOMODO_API_KEY: "synthetic-key",
    KOMODO_API_SECRET: "synthetic-secret",
    MCP_TOOLS_ALLOWED_CATEGORIES: "stakc",
    MCP_SECRET_SCRUB_ENABLED: "true",
    MCP_CONFIRM_DESTRUCTIVE: "true",
    MCP_CONFIRM_FALLBACK: "deny",
  },
});
transport.stderr?.on("data", () => {});
const client = new Client({ name: "category-repro", version: "1" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  console.log(
    JSON.stringify({
      invalidCategoryAccepted: true,
      registeredTools: tools.length,
      stackDeletionExposed: tools.some((tool) => tool.name === "komodo_stack_delete"),
      writeCalls,
    }),
  );
  if (tools.length > 0) process.exitCode = 1;
} finally {
  await client.close();
  await new Promise((resolve, reject) => fixture.close((err) => (err ? reject(err) : resolve())));
}
