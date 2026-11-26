/**
 * Polling Utilities
 *
 * Execute-and-poll workflow for long-running Komodo operations.
 * Provides cancellation via AbortSignal, progress reporting,
 * and timeout enforcement on top of `komodo_client.execute()`.
 *
 * @module utils/polling
 */

import { addAbortListener } from "node:events";
import timers from "node:timers/promises";
import { Types } from "komodo_client";
import type { ProgressReporter } from "mcp-server-framework";
import { AuthorizationError, OperationCancelledError, getCurrentToolContext } from "mcp-server-framework";
import { HttpStatus } from "mcp-server-framework/errors";
import type { KomodoClient } from "../client.js";
import { ApiError, AuthenticationError, ConnectionError } from "../errors/index.js";
import { checkCancelled, requireClient, wrapApiCall } from "./api-helpers.js";
import { getKomodoRequestSignal, runWithKomodoRequestSignal } from "./request-signal.js";

type Update = Types.Update;

// ============================================================================
// Polling Constants
// ============================================================================

/** Interval between status polls (ms) */
const POLL_INTERVAL_MS = 1_000;

/** Maximum time to submit an operation and wait for it to complete (30 minutes) */
const POLL_MAX_DURATION_MS = 1_800_000;

/** Interval between progress reports to the MCP client (ms) */
const POLL_PROGRESS_INTERVAL_MS = 5_000;

// ============================================================================
// Update Helpers
// ============================================================================

/**
 * Extract the MongoDB ObjectId string from a Komodo Update object.
 */
export function extractUpdateId(update: { _id?: { $oid?: string } }): string {
  return update._id?.$oid || "unknown";
}

// ============================================================================
// Polling
// ============================================================================

/**
 * Polls a Komodo update until its status reaches `Complete`.
 *
 * Komodo updates follow the lifecycle `Queued → InProgress → Complete`.
 * During `InProgress`, the backend appends log entries to `update.logs[]`
 * via `update_update()` — each entry represents a completed stage
 * (e.g. "Deploy Container", "Clone Repo", "Diff compose files").
 *
 * Progress is reported based on these **real operation stages**:
 * - New stages are reported immediately when detected
 * - Between stages, a heartbeat is sent every {@link POLL_PROGRESS_INTERVAL_MS}
 * - Progress is **indeterminate** (no `total`) because stage count varies
 *   per operation (typically 1–8) and is not known upfront
 *
 * @param client     - Komodo API client
 * @param updateId   - The `_id.$oid` of the Update returned by `execute()`
 * @param operation  - Human-readable operation name (for progress messages)
 * @param signal     - The combined caller cancellation and workflow deadline
 * @param reportProgress - MCP progress reporter (optional)
 * @returns The final Update with `status === "Complete"`
 */
async function pollUntilComplete(
  client: KomodoClient,
  updateId: string,
  operation: string,
  signal: AbortSignal,
  reportProgress?: ProgressReporter,
): Promise<Update> {
  const startTime = Date.now();
  let lastProgressTime = 0;
  let lastStageCount = 0;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional polling loop, exits via return or throw
  while (true) {
    // Wait one poll interval
    await timers.setTimeout(POLL_INTERVAL_MS, undefined, { signal });
    const elapsed = Date.now() - startTime;

    // Poll status
    const update = await wrapApiCall(
      `${operation} (poll)`,
      () => client.client.read("GetUpdate", { id: updateId }),
      signal,
    );
    signal.throwIfAborted();

    const logs = update.logs;
    const stageCount = logs.length;
    const elapsedSec = Math.round(elapsed / 1000);

    if (reportProgress) {
      if (stageCount > lastStageCount) {
        lastStageCount = stageCount;
        lastProgressTime = elapsed;
        const latestStage = logs[stageCount - 1]?.stage ?? "processing";
        await reportProgress({
          progress: stageCount,
          message: `${operation}: ${latestStage} (${elapsedSec}s)`,
        });
      } else if (elapsed - lastProgressTime >= POLL_PROGRESS_INTERVAL_MS) {
        lastProgressTime = elapsed;
        await reportProgress({
          progress: stageCount,
          message: `${operation}: in progress (${elapsedSec}s)`,
        });
      }
      signal.throwIfAborted();
    }

    if (update.status === Types.UpdateStatus.Complete) {
      if (reportProgress) {
        const totalSec = Math.round((Date.now() - startTime) / 1000);
        await reportProgress({
          progress: stageCount,
          total: stageCount || 1,
          message: `${operation}: complete (${totalSec}s)`,
        });
        signal.throwIfAborted();
      }
      // Record the operation's effect on the tool.call audit entry (what was produced).
      getCurrentToolContext()?.recordAuditDetail({
        effect: {
          updateId: extractUpdateId(update),
          status: update.status,
          success: update.success,
        },
      });
      return update;
    }
  }
}

/**
 * Executes a Komodo action and polls until the operation completes.
 *
 * Replaces the direct use of `komodo_client.execute_and_poll()` to add:
 * - Cancellation via AbortSignal
 * - Progress reporting to the MCP client
 * - A single deadline for submission, polling and progress
 *
 * For instant operations (status already `Complete` after `execute()`),
 * the polling loop is skipped entirely.
 * Stopping this wait cannot undo an operation Komodo has already received.
 */
export async function wrapExecuteAndPoll(
  operation: string,
  executeCall: () => Promise<Update>,
  signal = getKomodoRequestSignal() ?? getCurrentToolContext()?.abortSignal,
  reportProgress?: ProgressReporter,
): Promise<Update> {
  checkCancelled(signal, "The caller cancelled before MCP submitted the operation.");

  const client = requireClient();
  const deadline = new AbortController();
  const workflowSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), POLL_MAX_DURATION_MS);
  let abortListener: ReturnType<typeof addAbortListener> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abortListener = addAbortListener(workflowSignal, () => reject(new OperationCancelledError(operation)));
  });
  const context = getCurrentToolContext();
  const state: { phase: "submission" | "polling" | "progress"; updateId?: string } = { phase: "submission" };
  try {
    const workflow = runWithKomodoRequestSignal(workflowSignal, async () => {
      const update = await wrapApiCall(operation, executeCall, workflowSignal);
      state.phase = "polling";
      const id: unknown = update._id?.$oid;
      // Core returns a MongoDB ObjectId. Only expose a valid ID in diagnostics.
      if (typeof id === "string" && /^[a-f0-9]{24}$/i.test(id)) {
        state.updateId = id;
        context?.recordAuditDetail({ effect: { updateId: id } });
      }
      workflowSignal.throwIfAborted();
      if (update.status === Types.UpdateStatus.Complete) return update;

      const acceptedId = state.updateId;
      if (!acceptedId) throw ApiError.invalidResponse("Komodo returned no valid update ID");
      const progress: ProgressReporter | undefined =
        reportProgress &&
        (async (notification) => {
          state.phase = "progress";
          const reported = await reportProgress({
            ...notification,
            message: `${notification.message ?? operation} (update ${acceptedId})`,
          });
          state.phase = "polling";
          return reported;
        });
      return await pollUntilComplete(client, acceptedId, operation, workflowSignal, progress);
    });
    return await Promise.race([workflow, stopped]);
  } catch (error) {
    const { phase, updateId } = state;
    const cancelled = signal?.aborted || (!deadline.signal.aborted && OperationCancelledError.isCancellation(error));
    if (phase === "submission" && !cancelled && !deadline.signal.aborted) {
      // A definite rejection did not accept the operation. Preserve existing authorization
      // and input errors, while treating interrupted requests and invalid responses as ambiguous.
      const status = error instanceof ApiError ? error.apiStatusCode : undefined;
      if (
        error instanceof AuthorizationError ||
        error instanceof AuthenticationError ||
        (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 499)
      ) {
        throw error;
      }
    }

    const recoveryHint = updateId
      ? `Check komodo_update_info with id "${updateId}" before retrying.`
      : "Check recent operations with komodo_update_list before retrying.";
    const outcome = updateId
      ? `Komodo update ${updateId} may still be running.`
      : "No update ID was received. The outcome in Komodo is unknown.";
    let reason = phase === "submission" ? "Submission was interrupted." : "Polling was interrupted.";
    if (cancelled) reason = "The caller cancelled the request.";
    else if (deadline.signal.aborted)
      reason = `The workflow reached its ${POLL_MAX_DURATION_MS / 60_000}-minute deadline.`;
    else if (phase === "progress") reason = "Progress reporting was interrupted.";
    else if (error instanceof ConnectionError && error.statusCode === HttpStatus.GATEWAY_TIMEOUT) {
      reason = "A Komodo HTTP request timed out.";
    }
    const message = `MCP stopped waiting. ${reason} ${outcome} ${recoveryHint}`;
    const options = { recoveryHint, context: updateId ? { updateId } : undefined };
    context?.recordAuditDetail({ effect: { ...(updateId && { updateId }), wait: "interrupted" } });
    if (cancelled) throw new OperationCancelledError(message, undefined, options);
    if (deadline.signal.aborted || phase === "progress") throw new ApiError(message, options);
    if (error instanceof ConnectionError) {
      throw new ConnectionError(message, "Komodo", { ...options, statusCode: error.statusCode });
    }
    if (error instanceof AuthorizationError) throw new AuthorizationError(message, options);
    if (error instanceof AuthenticationError) throw new AuthenticationError(message, options);
    throw new ApiError(message, options);
  } finally {
    clearTimeout(timer);
    abortListener?.[Symbol.dispose]();
  }
}

// ============================================================================
// Action Result Payload
// ============================================================================

/**
 * Typed `actionResultSchema`-shaped payload built from a completed Update.
 */
export interface ActionResult {
  readonly success: boolean;
  readonly status: string;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string;
  readonly server?: string;
  readonly version?: string;
  readonly [key: string]: unknown;
}

export function buildActionResult(
  update: Update,
  action: string,
  resourceType: string,
  resourceId: string,
  serverName?: string,
): ActionResult {
  const version = update.version
    ? `${update.version.major}.${update.version.minor}.${update.version.patch}`
    : undefined;

  return {
    success: update.success,
    status: update.status,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    ...(serverName !== undefined ? { server: serverName } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}
