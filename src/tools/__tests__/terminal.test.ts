import "../../utils/polyfills.js";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { logger } from "mcp-server-framework";
import type { ToolContext } from "mcp-server-framework";
import { configureKomodoConnections, stopKomodoConnections } from "../../client.js";
import { config, resolveKomodoConfig } from "../../config/env.js";
import { execTool } from "../terminal.js";

interface TerminalRequest {
  target?: unknown;
  name?: string;
  terminal?: string;
  command?: string;
  init?: { command: string };
}
let onRequest: (path: string, body: TerminalRequest, signal: AbortSignal | undefined) => Promise<Response> | Response;

before(async () => {
  process.env["KOMODO_URL"] = "http://core.invalid";
  process.env["KOMODO_API_KEY"] = "test-key";
  process.env["KOMODO_API_SECRET"] = "test-secret";
  process.env["MCP_CONFIRM_DESTRUCTIVE"] = "false";
  resolveKomodoConfig();
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (url.endsWith("/version")) return new Response("2.3.4");
    if (path === "/read/GetVersion") return Response.json({ version: "2.3.4" });
    assert.ok(typeof init.body === "string");
    return onRequest(path, JSON.parse(init.body) as TerminalRequest, init.signal ?? undefined);
  });
  await configureKomodoConnections({ anonymousMode: true });
});
after(stopKomodoConnections);

async function callTerminal(
  input: unknown,
  signal = new AbortController().signal,
  sessionId = "one",
  recordAuditDetail: ToolContext["recordAuditDetail"] = () => {},
) {
  const context: ToolContext = {
    abortSignal: signal,
    caller: { remoteAddress: undefined },
    recordAuditDetail,
    requestId: sessionId,
    sendNotification: async () => {},
    sessionId,
    stateless: false,
  };
  return execTool.handler(execTool.input.parse(input), context);
}

function readPayload(result: Awaited<ReturnType<typeof callTerminal>>) {
  const output = execTool.output;
  assert.ok(output);
  return output.parse(result.structuredContent);
}

async function run(command: string, signal?: AbortSignal, terminal?: string, sessionId = "one") {
  return readPayload(
    await callTerminal({ target: "server", server: "server-a", command, terminal }, signal, sessionId),
  );
}

function pendingStream(signal: AbortSignal | undefined, initialOutput?: string) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (initialOutput !== undefined) controller.enqueue(new TextEncoder().encode(initialOutput));
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }),
  );
}

test("two sessions get distinct default terminals and only their own output", async () => {
  const active = new Set<string>();
  const deleted = new Set<string>();
  const executions: string[] = [];
  const outputByTerminal = new Map<string, string>();
  onRequest = async (path, body) => {
    if (path === "/write/CreateTerminal") {
      assert.ok(body.name);
      active.add(body.name);
      return Response.json({});
    }
    if (path === "/write/DeleteTerminal") {
      assert.ok(body.terminal);
      assert.ok(active.delete(body.terminal));
      deleted.add(body.terminal);
      return Response.json({});
    }
    assert.ok(body.terminal && body.command);
    executions.push(body.terminal);
    // Simulate the terminal owning the output stream while two calls overlap.
    const output = outputByTerminal.get(body.terminal) ?? body.command;
    outputByTerminal.set(body.terminal, output);
    await Promise.resolve();
    return new Response(`${output}\n__KOMODO_EXIT_CODE:0\n`);
  };
  const results = await Promise.all([run("one", undefined, undefined, "one"), run("two", undefined, undefined, "two")]);
  assert.deepEqual(
    results.map(({ output }) => output),
    ["one", "two"],
  );
  assert.equal(new Set(executions).size, 2);
  assert.deepEqual(new Set(executions), deleted);
  assert.equal(active.size, 0);
});

test("an explicit terminal retains its name and initialization and is never deleted", async () => {
  onRequest = (path, body) => {
    assert.equal(path, "/terminal/execute");
    assert.equal(body.terminal, "mcp");
    assert.ok(body.init?.command);
    return new Response("__KOMODO_EXIT_CODE:4\n");
  };
  assert.equal((await run("command", undefined, "mcp")).exit_code, "4");
});

test("a no-output terminal times out and is cleaned up", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let deleted = false;
  onRequest = (path, _body, signal) => {
    if (path === "/terminal/execute") {
      start();
      return pendingStream(signal);
    }
    if (path === "/write/DeleteTerminal") deleted = true;
    return Response.json({});
  };
  const result = run("quiet");
  await started;
  t.mock.timers.tick(300_000);
  const payload = await result;
  assert.equal(payload.truncated, true);
  assert.equal(payload.exit_code, null);
  assert.match(payload.output, /timeout/i);
  assert.equal(deleted, true);
});

test("a timeout does not report an exit code from an unfinished stream", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  onRequest = (path, _body, signal) => {
    if (path === "/terminal/execute") {
      start();
      return pendingStream(signal, "__KOMODO_EXIT_CODE:0\n");
    }
    return Response.json({});
  };
  const result = run("exit-code-like output");
  await started;
  await setImmediate();
  t.mock.timers.tick(300_000);
  const payload = await result;
  assert.match(payload.output, /timeout/i);
  assert.equal(payload.exit_code, null);
});

test("cancellation stops a pending fetch and cleans up its terminal", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let deleted = false;
  onRequest = (path, _body, signal) => {
    if (path === "/terminal/execute") {
      start();
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("request cancelled")), { once: true }),
      );
    }
    if (path === "/write/DeleteTerminal") deleted = true;
    return Response.json({});
  };
  const result = run("quiet", controller.signal);
  await started;
  controller.abort();
  await assert.rejects(result, /cancel/i);
  assert.equal(deleted, true);
});

test("a failed execution retains the primary error and retries failed cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let terminal: string | undefined;
  const deletions: (string | undefined)[] = [];
  onRequest = (path, body) => {
    if (path === "/write/CreateTerminal") terminal = body.name;
    if (path === "/terminal/execute") return Response.json({ error: "operation failed" }, { status: 500 });
    if (path === "/write/DeleteTerminal") {
      deletions.push(body.terminal);
      if (deletions.length === 1) return Response.json({ error: "cleanup failed" }, { status: 500 });
    }
    return Response.json({});
  };
  await assert.rejects(run("failure"), /operation failed/i);
  assert.ok(terminal);
  assert.deepEqual(deletions, [terminal]);
  t.mock.timers.tick(5_000);
  assert.deepEqual(deletions, [terminal, terminal]);
});

test("an unacknowledged creation is deleted again if it completes after the first cleanup", async (t) => {
  let terminal: string | undefined;
  const active = new Set<string>();
  const requests: string[] = [];
  onRequest = (path, body) => {
    requests.push(path);
    if (path === "/write/CreateTerminal") {
      terminal = body.name;
      throw new DOMException("creation timed out", "TimeoutError");
    }
    assert.ok(body.terminal);
    assert.equal(body.terminal, terminal);
    active.delete(body.terminal);
    return Response.json({});
  };
  await assert.rejects(run("never executed"), /creation timed out/i);
  assert.ok(terminal);
  assert.deepEqual(requests, ["/write/CreateTerminal", "/write/DeleteTerminal"]);
  active.add(terminal);
  await delay(5_000, undefined, { signal: t.signal });
  assert.deepEqual(requests, ["/write/CreateTerminal", "/write/DeleteTerminal", "/write/DeleteTerminal"]);
  assert.equal(active.size, 0);
});

test("a rejected creation does not execute or delete a terminal", async () => {
  const requests: string[] = [];
  onRequest = (path) => {
    requests.push(path);
    return Response.json({ error: "permission denied" }, { status: 403 });
  };
  await assert.rejects(run("never executed"), /permission/i);
  assert.deepEqual(requests, ["/write/CreateTerminal"]);
});

test("cancellation during creation cleans up after Core acknowledges the terminal", async () => {
  const controller = new AbortController();
  const requests: string[] = [];
  let name: string | undefined;
  onRequest = (path, body, signal) => {
    requests.push(path);
    if (path === "/write/CreateTerminal") {
      name = body.name;
      controller.abort();
    } else {
      assert.ok(name);
      assert.equal(body.terminal, name);
      assert.equal(signal?.aborted, false);
    }
    return Response.json({});
  };
  await assert.rejects(run("quiet", controller.signal), /cancel/i);
  assert.deepEqual(requests, ["/write/CreateTerminal", "/write/DeleteTerminal"]);
});

test(
  "terminal creation uses the JSON body deadline and cancellation still allows cleanup",
  { timeout: 1_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const originalTimeout = config.KOMODO_API_TIMEOUT_MS;
    config.KOMODO_API_TIMEOUT_MS = 100;
    t.after(() => {
      config.KOMODO_API_TIMEOUT_MS = originalTimeout;
    });
    const caller = new AbortController();
    let startCreation!: (signal: AbortSignal) => void;
    const creating = new Promise<AbortSignal>((resolve) => {
      startCreation = resolve;
    });
    const requests: string[] = [];
    let name: string | undefined;
    onRequest = (path, body, signal) => {
      requests.push(path);
      assert.ok(signal);
      if (path === "/write/CreateTerminal") {
        name = body.name;
        startCreation(signal);
        return pendingStream(signal, "{");
      }
      assert.equal(path, "/write/DeleteTerminal");
      assert.ok(name);
      assert.equal(body.terminal, name);
      assert.equal(signal.aborted, false);
      return Response.json({});
    };
    const result = assert.rejects(run("never executed", caller.signal), /cancel/i);
    const creationSignal = await creating;
    caller.abort();
    assert.equal(creationSignal.aborted, false);
    t.mock.timers.tick(config.KOMODO_API_TIMEOUT_MS);
    await result;
    assert.equal(creationSignal.aborted, true);
    assert.deepEqual(requests, ["/write/CreateTerminal", "/write/DeleteTerminal"]);
    t.mock.timers.tick(5_000);
    await setImmediate();
    assert.deepEqual(requests, ["/write/CreateTerminal", "/write/DeleteTerminal", "/write/DeleteTerminal"]);
  },
);

for (const [args, target] of [
  [
    { target: "container", server: "server-a", container: "container-a" },
    { type: "Container", params: { server: "server-a", container: "container-a" } },
  ],
  [
    { target: "deployment", deployment: "deployment-a" },
    { type: "Deployment", params: { deployment: "deployment-a" } },
  ],
  [
    { target: "stack_service", stack: "stack-a", service: "service-a" },
    { type: "Stack", params: { stack: "stack-a", service: "service-a" } },
  ],
] as const) {
  test(`${args.target}: the terminal deadline aborts stalled response headers`, { timeout: 1_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let start!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      start = resolve;
    });
    onRequest = async (path, body, signal) => {
      assert.equal(path, "/terminal/execute");
      assert.deepEqual(body.target, target);
      assert.ok(body.init?.command);
      assert.ok(signal);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Request aborted", "AbortError")), {
          once: true,
        });
        start(signal);
      });
    };
    const result = callTerminal({ ...args, command: "fixture" });
    const signal = await started;
    t.mock.timers.tick(300_000);
    const payload = readPayload(await result);
    assert.equal(signal.aborted, true);
    assert.equal(payload.truncated, true);
    assert.equal(payload.exit_code, null);
    assert.match(payload.output, /command may still be running/);
  });

  test(`${args.target}: cancellation aborts a silent response body`, { timeout: 1_000 }, async () => {
    const caller = new AbortController();
    let start!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      start = resolve;
    });
    onRequest = (path, _body, signal) => {
      assert.equal(path, "/terminal/execute");
      assert.ok(signal);
      const response = pendingStream(signal);
      start(signal);
      return response;
    };
    const rejected = assert.rejects(callTerminal({ ...args, command: "fixture" }, caller.signal), /cancel/i);
    const signal = await started;
    await setImmediate();
    caller.abort();
    await rejected;
    assert.equal(signal.aborted, true);
  });

  test(`${args.target}: a reply arriving after cancellation is released`, { timeout: 1_000 }, async () => {
    const caller = new AbortController();
    let start!: () => void;
    let sendLateResponse!: (response: Response) => void;
    let released = false;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    onRequest = (path, _body, signal) => {
      assert.equal(path, "/terminal/execute");
      assert.ok(signal);
      return new Promise((resolve) => {
        sendLateResponse = resolve;
        start();
      });
    };
    const rejected = assert.rejects(callTerminal({ ...args, command: "fixture" }, caller.signal), /cancel/i);
    await started;
    caller.abort();
    sendLateResponse(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("late output\n__KOMODO_EXIT_CODE:0\n"));
          },
          cancel() {
            released = true;
          },
        }),
      ),
    );
    await rejected;
    assert.equal(released, true);
  });
}

for (const deletionConfirmed of [true, false]) {
  test(`an isolated terminal reports ${deletionConfirmed ? "confirmed" : "unconfirmed"} cleanup`, async (t) => {
    const command = "fixture-command-that-must-not-appear-in-diagnostics";
    const diagnostics = t.mock.method(logger, "warn", () => {});
    const audit = t.mock.fn<ToolContext["recordAuditDetail"]>();
    let terminal: string | undefined;
    let deletes = 0;
    onRequest = (path, body) => {
      if (path === "/write/CreateTerminal") {
        terminal = body.name;
        return Response.json({});
      }
      if (path === "/terminal/execute") return new Response("fixture output\n__KOMODO_EXIT_CODE:0\n");
      assert.equal(path, "/write/DeleteTerminal");
      assert.equal(body.terminal, terminal);
      deletes++;
      return deletionConfirmed ? Response.json({}) : Response.json({ error: command }, { status: 500 });
    };
    const result = await callTerminal({ target: "server", server: "server-a", command }, undefined, "session", audit);
    assert.equal(readPayload(result).exit_code, "0");
    assert.ok(typeof terminal === "string" && terminal.startsWith("mcp-"));
    assert.deepEqual(
      audit.mock.calls.map(({ arguments: args }) => args[0]),
      [{ effect: { terminal, cleanup: deletionConfirmed ? "deletion_confirmed" : "retry_scheduled" } }],
    );
    const rendered = JSON.stringify(result.content);
    assert.equal(rendered.includes(terminal), !deletionConfirmed);
    assert.equal(deletes, 1);
    if (deletionConfirmed) {
      assert.equal(diagnostics.mock.callCount(), 0);
    } else {
      assert.match(rendered, /cleanup.*unconfirmed.*Terminals in Komodo/i);
      await delay(5_000);
      await setImmediate();
      assert.equal(deletes, 2);
      assert.equal(diagnostics.mock.callCount(), 2);
      const warnings = JSON.stringify(diagnostics.mock.calls.map(({ arguments: args }) => args));
      assert.ok(warnings.includes(terminal));
      assert.match(warnings, /remains unconfirmed after retry/);
      assert.ok(!warnings.includes(command));
    }
  });
}
