import "../polyfills.js";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { after, before, mock, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Types } from "komodo_client";
import { AuthorizationError, OperationCancelledError } from "mcp-server-framework";
import { configureKomodoConnections, stopKomodoConnections } from "../../client.js";
import { config } from "../../config/index.js";
import { ApiError, ConnectionError } from "../../errors/index.js";
import { requireClient } from "../api-helpers.js";
import { wrapExecuteAndPoll } from "../polling.js";

const deadlineMs = 30 * 60 * 1000;
const updateId = "0123456789abcdef01234567";
const inProgress = { _id: { $oid: updateId }, status: Types.UpdateStatus.InProgress, logs: [{ stage: "deploy" }] };
const complete = { ...inProgress, status: Types.UpdateStatus.Complete, success: true };

before(async () => {
  process.env["KOMODO_URL"] = "http://core.invalid";
  process.env["KOMODO_API_KEY"] = "fixture-key";
  process.env["KOMODO_API_SECRET"] = "fixture-secret";
  const fetch = mock.method(globalThis, "fetch", async () => Response.json({ version: "2.3.4" }));
  try {
    await configureKomodoConnections({ anonymousMode: true });
  } finally {
    fetch.mock.restore();
  }
});

after(stopKomodoConnections);

function execute(action = "fixture") {
  return requireClient().client.execute("RunAction", { action });
}

function assertRecovery(error: Error, knownId?: string): void {
  assert.match(error.message, /MCP stopped waiting/);
  if (knownId) {
    assert.ok(error.message.includes(`Komodo update ${knownId} may still be running`));
    assert.ok(error.message.includes(`komodo_update_info with id "${knownId}" before retrying`));
  } else {
    assert.match(error.message, /outcome in Komodo is unknown.*komodo_update_list before retrying/);
  }
}

test("a stalled poll body hits the HTTP timeout before the workflow deadline", { timeout: 1_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let pollStarted!: (signal: AbortSignal) => void;
  const polling = new Promise<AbortSignal>((resolve) => {
    pollStarted = resolve;
  });
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === "/execute/RunAction") return Response.json(inProgress);
    assert.equal(new URL(url).pathname, "/read/GetUpdate");
    const signal = init?.signal;
    assert.ok(signal);
    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          pollStarted(signal);
        },
      }),
    );
  });
  const caller = new AbortController();
  const result = wrapExecuteAndPoll("run", () => execute(), caller.signal);
  const rejected = assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof ConnectionError);
    assert.match(error.message, /HTTP request timed out/);
    assertRecovery(error, updateId);
    return true;
  });
  await setImmediate();
  t.mock.timers.tick(1_000);
  const pollSignal = await polling;
  t.mock.timers.tick(config.KOMODO_API_TIMEOUT_MS);
  await rejected;
  assert.equal(pollSignal.aborted, true);
  assert.equal(caller.signal.aborted, false);
  t.mock.timers.tick(deadlineMs);
  assert.equal(fetch.mock.callCount(), 2);
});

for (const phase of ["submit", "GetUpdate", "progress", "final progress"] as const) {
  test(`the workflow deadline covers stalled ${phase}`, { timeout: 1_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const paths: string[] = [];
    let httpSignal: AbortSignal | null | undefined;
    let resolveLateResponse: ((response: Response) => void) | undefined;
    let rejectLateProgress: ((error: Error) => void) | undefined;
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      paths.push(path);
      httpSignal = init?.signal;
      if (
        (path === "/execute/RunAction" && phase === "submit") ||
        (path === "/read/GetUpdate" && phase === "GetUpdate")
      ) {
        // Model a transport that delivers a late reply despite being signalled.
        return new Promise<Response>((resolve) => {
          resolveLateResponse = resolve;
        });
      }
      return Response.json(
        phase === "final progress" && path === "/read/GetUpdate" ? { ...complete, logs: [] } : inProgress,
      );
    });
    const reportProgress = t.mock.fn(
      async () =>
        new Promise<boolean>((_, reject) => {
          rejectLateProgress = reject;
        }),
    );
    const result = wrapExecuteAndPoll("deploy", () => execute(), undefined, reportProgress);
    const rejected = assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /30-minute deadline/);
      assertRecovery(error, phase === "submit" ? undefined : updateId);
      return true;
    });
    await setImmediate();
    t.mock.timers.tick(1_000);
    await setImmediate();
    const expectedPaths = phase === "submit" ? ["/execute/RunAction"] : ["/execute/RunAction", "/read/GetUpdate"];
    const expectedReports = phase.endsWith("progress") ? 1 : 0;
    assert.deepEqual(paths, expectedPaths);
    assert.equal(reportProgress.mock.callCount(), expectedReports);
    t.mock.timers.tick(deadlineMs - 1_000);
    await rejected;
    assert.equal(httpSignal?.aborted, true);

    resolveLateResponse?.(Response.json(complete));
    rejectLateProgress?.(new Error("late reporter failure"));
    await setImmediate();
    t.mock.timers.tick(2_000);
    await setImmediate();
    assert.deepEqual(paths, expectedPaths, "no additional requests, including remote cancellation");
    assert.equal(reportProgress.mock.callCount(), expectedReports);
  });
}

test(
  "pre-cancellation prevents submission, and cancellation during the poll delay prevents any poll",
  { timeout: 1_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let httpSignal: AbortSignal | null | undefined;
    const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      httpSignal = init?.signal;
      return Response.json(inProgress);
    });
    await assert.rejects(
      wrapExecuteAndPoll("deploy", () => execute(), AbortSignal.abort()),
      OperationCancelledError,
    );
    assert.equal(fetch.mock.callCount(), 0);

    const caller = new AbortController();
    const rejected = assert.rejects(
      wrapExecuteAndPoll("deploy", () => execute(), caller.signal),
      (error: unknown) => {
        assert.ok(error instanceof OperationCancelledError);
        assertRecovery(error, updateId);
        return true;
      },
    );
    await setImmediate();
    assert.equal(fetch.mock.callCount(), 1);
    caller.abort("client stopped");
    await rejected;
    t.mock.timers.tick(deadlineMs);
    await setImmediate();
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(httpSignal?.aborted, true);
    assert.deepEqual(getEventListeners(httpSignal, "abort"), []);
  },
);

test(
  "concurrent workflows have independent cancellation, completed results and timers",
  { timeout: 1_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const signals: AbortSignal[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const headers = new Headers(init?.headers);
      assert.ok(signal);
      assert.equal(headers.get("x-api-key"), "fixture-key");
      assert.equal(headers.get("x-api-secret"), "fixture-secret");
      signals.push(signal);
      if (signals.length === 1) {
        return new Promise<Response>((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Request aborted", "AbortError")), {
            once: true,
          });
        });
      }
      return Response.json(complete);
    });
    const caller = new AbortController();
    const cancelled = assert.rejects(
      wrapExecuteAndPoll("first", () => execute("first"), caller.signal),
      (error: unknown) => {
        assert.ok(error instanceof OperationCancelledError);
        assertRecovery(error);
        return true;
      },
    );
    const unaffected = wrapExecuteAndPoll("second", () => execute("second"));
    caller.abort();
    await cancelled;
    assert.deepEqual(await unaffected, complete);
    t.mock.timers.tick(deadlineMs);
    assert.deepEqual(
      signals.map((signal) => signal.aborted),
      [true, false],
      "the completed workflow cleared its deadline",
    );
    assert.deepEqual(
      signals.map((signal) => getEventListeners(signal, "abort")),
      [[], []],
    );
  },
);

test(
  "normal polling reports stages and completion, and preserves Komodo authorization errors",
  { timeout: 1_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const responses = [
      Response.json(inProgress),
      Response.json(complete),
      Response.json({ error: "permission denied" }, { status: 403 }),
    ];
    t.mock.method(globalThis, "fetch", async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    });
    const reportProgress = t.mock.fn(async () => true);
    const result = wrapExecuteAndPoll("deploy", () => execute(), undefined, reportProgress);
    await setImmediate();
    t.mock.timers.tick(1_000);
    assert.deepEqual(await result, complete);
    assert.equal(reportProgress.mock.callCount(), 2);
    assert.deepEqual(
      reportProgress.mock.calls.map(({ arguments: args }) => args),
      [
        [{ progress: 1, message: `deploy: deploy (1s) (update ${updateId})` }],
        [{ progress: 1, total: 1, message: `deploy: complete (1s) (update ${updateId})` }],
      ],
    );
    await assert.rejects(
      wrapExecuteAndPoll("unauthorized", () => execute()),
      AuthorizationError,
    );
  },
);

for (const failure of ["poll", "progress"] as const) {
  test(
    `interrupted ${failure} reports the accepted ID without upstream error content`,
    { timeout: 1_000 },
    async (t) => {
      const privateText = "sensitive-fixture-response";
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
        if (new URL(url).pathname === "/execute/RunAction") return Response.json(inProgress);
        return failure === "poll" ? Response.json({ error: privateText }, { status: 500 }) : Response.json(inProgress);
      });
      const report = t.mock.fn(async () => {
        throw new Error(privateText);
      });
      const result = wrapExecuteAndPoll("deploy", () => execute(), undefined, report);
      const rejected = assert.rejects(result, (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assertRecovery(error, updateId);
        assert.match(
          error.message,
          failure === "poll" ? /Polling was interrupted/ : /Progress reporting was interrupted/,
        );
        assert.doesNotMatch(JSON.stringify(error), new RegExp(privateText));
        return true;
      });
      await setImmediate();
      t.mock.timers.tick(1_000);
      await rejected;
      assert.equal(fetch.mock.callCount(), 2, "no submission retry");
      assert.equal(report.mock.callCount(), failure === "progress" ? 1 : 0);
    },
  );
}

test("a failed submission with no usable ID reports an unknown outcome and never resubmits", async (t) => {
  const privateText = "private-fixture-secret";
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      ...inProgress,
      _id: { $oid: privateText },
    }),
  );
  await assert.rejects(
    wrapExecuteAndPoll("deploy", () => execute()),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assertRecovery(error);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(privateText));
      return true;
    },
  );
  assert.equal(fetch.mock.callCount(), 1, "do not poll malformed IDs or resubmit");
});

test("HTTP interruption responses during submission preserve an unknown remote outcome", async (t) => {
  const privateText = "private-fixture-response";
  for (const status of [408, 499, 500]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ error: privateText }, { status }));
    try {
      await assert.rejects(
        wrapExecuteAndPoll("deploy", () => execute()),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assertRecovery(error);
          assert.ok(!JSON.stringify(error).includes(privateText));
          return true;
        },
      );
      assert.equal(fetch.mock.callCount(), 1);
    } finally {
      fetch.mock.restore();
    }
  }
});
