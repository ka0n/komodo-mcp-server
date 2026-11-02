import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Evaluation coverage, NOT an application mitigation: framework 1.2.0 does not
// expose either SDK option exercised below. Never run an exhaustion-sized PoC
// in the test runner. Each bounded case has its own heap cap and kill deadline.
function runIsolated(script: string): void {
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=128",
      "--max-semi-space-size=4",
      "--stack-size=512",
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       globalThis.fetch = () => { throw new Error("Unexpected network access"); };
       ${script}
       process.stdout.write("passed");`,
    ],
    { env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16_384 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "passed");
}

test("bounded invalid collections fail existing application and constrained v3 schemas", () => {
  runIsolated(`
    await import(${JSON.stringify(new URL("../utils/polyfills.js", import.meta.url).href)});
    const { stackApplyInputSchema } = await import(${JSON.stringify(new URL("./schemas/stack.js", import.meta.url).href)});
    const { z } = await import("mcp-server-framework");
    const invalid = Array(4096).fill(0);
    const parsed = await stackApplyInputSchema.safeParseAsync({
      action: "update", stack: "test-stack", config: { links: invalid },
    });
    assert.equal(parsed.success, false);
    assert.ok(parsed.error.issues.length > 0 && parsed.error.issues.length <= 4096);
    // A v3 .max() rejects the input but does not guarantee early termination.
    // Permit fewer issues if upstream later supplies an early-rejection fix.
    const constrained = await z.array(z.string()).max(16).safeParseAsync(invalid);
    assert.equal(constrained.success, false);
    assert.ok(constrained.error.issues.some(issue => issue.code === "too_big"));
    assert.ok(constrained.error.issues.length <= 4097);
  `);
});

test("SDK element budget rejects nested, invalid, and unknown collections before schema validation", () => {
  runIsolated(`
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { z } = await import("zod");
    const sdk = new McpServer({ name: "budget-test", version: "1" }, { maxToolInputElements: 1024 });
    const client = new Client({ name: "budget-client", version: "1" });
    let validations = 0;
    let executions = 0;
    sdk.registerTool("collection", {
      inputSchema: { items: z.preprocess(value => { validations++; return value; }, z.array(z.string())) },
    }, async () => { executions++; return { content: [{ type: "text", text: "ok" }] }; });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await sdk.connect(b);
      await client.connect(a);
      for (const args of [
        { items: Array(4096).fill("valid") },
        { items: Array(4096).fill(0) },
        { items: [Object.fromEntries(Array.from({ length: 2048 }, (_, i) => ["k" + i, 0]))] },
        { items: Array.from({ length: 64 }, () => Array(64).fill(0)) },
        { items: ["valid"], ignored: Array(4096).fill(0) },
      ]) {
        const response = await client.callTool({ name: "collection", arguments: args });
        assert.equal(response.isError, true);
        assert.match(JSON.stringify(response), /maximum of 1024 elements/);
        assert.equal(validations, 0);
        assert.equal(executions, 0);
      }
      // The root member plus 1023 array entries is exactly the SDK's budget.
      const valid = await client.callTool({ name: "collection", arguments: { items: Array(1023).fill("ok") } });
      assert.notEqual(valid.isError, true);
      assert.equal(validations, 1);
      assert.equal(executions, 1);
      const invalid = await client.callTool({ name: "collection", arguments: { items: [0] } });
      assert.equal(invalid.isError, true);
      assert.equal(validations, 2);
      assert.equal(executions, 1);
    } finally {
      await client.close();
      await sdk.close();
    }
  `);
});

test("SDK stdio byte limit closes oversized fragmented input before message delivery", () => {
  runIsolated(`
    const { PassThrough } = await import("node:stream");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: 1024 });
    let messages = 0;
    let errors = 0;
    let closed = 0;
    transport.onmessage = () => { messages++; };
    transport.onerror = error => { errors++; assert.match(error.message, /maximum size of 1024 bytes/); };
    transport.onclose = () => { closed++; };
    await transport.start();
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    stdin.write(line.slice(0, 10));
    assert.equal(messages, 0);
    stdin.write(line.slice(10) + "\\r\\n");
    assert.equal(messages, 1);
    stdin.write(Buffer.alloc(512, 0x20));
    stdin.write(Buffer.alloc(512, 0x20));
    assert.equal(errors, 0);
    stdin.write(" ");
    assert.equal(messages, 1);
    assert.equal(errors, 1);
    assert.equal(closed, 1);
    assert.equal(stdin.listenerCount("data"), 0);
    stdin.destroy();
    stdout.destroy();
  `);
});

test("SDK default stdio buffer cap rejects overflow and clears buffered data", () => {
  runIsolated(`
    const { ReadBuffer, STDIO_DEFAULT_MAX_BUFFER_SIZE } = await import("@modelcontextprotocol/sdk/shared/stdio.js");
    const buffer = new ReadBuffer();
    buffer.append(Buffer.alloc(STDIO_DEFAULT_MAX_BUFFER_SIZE, 0x20));
    assert.throws(() => buffer.append(Buffer.from(" ")), /exceeded maximum size/);
    // The rejected bytes cannot be combined with the next message.
    buffer.append(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\\n'));
    assert.equal(buffer.readMessage().method, "ping");
    assert.equal(buffer.readMessage(), null);
  `);
});
