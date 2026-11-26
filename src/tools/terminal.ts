/**
 * Terminal Execution Tool
 *
 * Consolidated `komodo_exec` tool for executing commands on Komodo servers,
 * containers, deployments, and stack services via the `komodo_client` terminal API.
 *
 * All targets stream output through the same abortable HTTP request.
 * Server calls can own an isolated terminal with independent cleanup.
 *
 * @module tools/terminal
 */

import { randomUUID } from "node:crypto";
import { defineTool, logger, structured } from "mcp-server-framework";
import type { ProgressReporter, ToolContext } from "mcp-server-framework";
import { Types } from "komodo_client";
import { KomodoRequestError, type KomodoApi } from "../client.js";
import { ToolCategories, ToolScopes } from "../config/index.js";
import { ValidationError } from "../errors/index.js";
import { execInputSchema, execOutputSchema } from "./schemas/index.js";
import {
  requireClient,
  requireKomodoPermission,
  requireDestructiveConfirmation,
  requireMinimalVersion,
  readCoreVersion,
  KOMODO_MINIMAL_API_VERSION,
  wrapApiCall,
  checkCancelled,
  renderExecResult,
} from "../utils/index.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum output length returned to the client (characters) */
const MAX_OUTPUT_LENGTH = 50_000;

/** Maximum time to wait for a terminal command to complete (5 minutes) */
const TERMINAL_TIMEOUT_MS = 300_000;

/** Independent limit for creating or deleting an isolated terminal. */
const TERMINAL_MANAGEMENT_TIMEOUT_MS = 5_000;

/** Give a delayed CreateTerminal request time to reach Periphery before retrying deletion. */
const TERMINAL_CLEANUP_RETRY_DELAY_MS = 5_000;

/** Report progress every N lines of output */
const PROGRESS_INTERVAL = 50;

/** Estimated total lines based on max output capacity (for progress reporting) */
const ESTIMATED_TOTAL_LINES = Math.ceil(MAX_OUTPUT_LENGTH / 80);

/** Sentinel prefix emitted by Komodo to signal exit code*/
const EXIT_CODE_PREFIX = "__KOMODO_EXIT_CODE:";

/**
 * Build the terminal init shell with PTY input echo disabled.
 *
 * Komodo Periphery sends its command scaffold as a multi-line string to the
 * PTY. Without `stty -echo`, the PTY echoes each scaffold line back into stdout
 * and Periphery's sentinel-matching loop fires on the echo rather than on the
 * real `printf` output — so the stream closes before the actual command output
 * arrives, returning the echoed scaffold with no exit code. Disabling echo makes
 * the sentinel match the real output. Used by every target so container,
 * deployment and stack_service exec behave like the server terminal.
 *
 * Workaround until upstream fix: `\n` to `\\n` in the scaffold printf format
 * literal, or a dedicated exec API without the scaffold.
 */
function echoSuppressedInit(shell: string): Types.InitTerminal {
  return {
    command: `sh -c 'stty -echo; exec ${shell}'`,
    recreate: Types.TerminalRecreateMode.DifferentCommand,
  };
}

/**
 * Parses and validates a raw exit-code value from the Komodo sentinel.
 *
 * The PTY echo can inject the printf format literal `"%d"` or other
 * non-numeric strings before the real sentinel arrives. Any value that
 * is not a valid integer is treated as unknown and returned as `null`.
 */
function parseExitCode(raw: string): string | null {
  const trimmed = raw.trim();
  return /^-?\d+$/.test(trimmed) ? trimmed : null;
}

// ============================================================================
// Output Collection
// ============================================================================

interface TerminalResult {
  readonly output: string;
  readonly exitCode: string | null;
  readonly truncated: boolean;
}

/** Buffers terminal output with truncation, timeout, and progress reporting. */
class OutputBuffer {
  private readonly lines: string[] = [];
  private readonly startTime = Date.now();
  private totalLength = 0;
  private truncated = false;
  private lineCount = 0;
  exitCode: string | null = null;

  /** Append a line to the buffer. Returns false if timed out (caller should stop). */
  addLine(line: string): boolean {
    if (Date.now() - this.startTime > TERMINAL_TIMEOUT_MS) {
      this.markTimeout();
      return false;
    }

    this.lineCount++;

    if (this.truncated) return true;

    this.totalLength += line.length + 1;
    if (this.totalLength > MAX_OUTPUT_LENGTH) {
      this.truncated = true;
      this.lines.push("... [output truncated]");
    } else {
      this.lines.push(line);
    }
    return true;
  }

  /** Report progress to the MCP client if the line threshold is reached. */
  async reportProgress(reporter?: ProgressReporter): Promise<void> {
    if (reporter && this.lineCount % PROGRESS_INTERVAL === 0) {
      await reporter({
        progress: Math.min(this.lineCount, ESTIMATED_TOTAL_LINES),
        total: ESTIMATED_TOTAL_LINES,
        message: `Received ${this.lineCount} lines...`,
      });
    }
  }

  /** Report a stopped wait without claiming the command has exited. */
  markTimeout(): void {
    this.lines.push("... [timeout — command may still be running]");
    this.truncated = true;
  }

  getResult(): TerminalResult {
    // Trim leading/trailing empty lines injected by Komodo's scaffold protocol
    // (printf outputs a \n before and after the sentinel lines). Internal blank
    // lines that are part of real command output are preserved.
    const output = this.lines.join("\n").trim();
    return { output, exitCode: this.exitCode, truncated: this.truncated };
  }
}

async function collectTerminalOutput(
  api: KomodoApi,
  request: Types.ExecuteTerminalBody,
  signal: AbortSignal,
  buf: OutputBuffer,
  reportProgress?: ProgressReporter,
): Promise<void> {
  let reporting = false;
  let exitCode: string | null = null;
  const stream = await api.execute_terminal_stream(request, signal);
  for await (const line of stream) {
    signal.throwIfAborted();
    if (line.startsWith(EXIT_CODE_PREFIX)) {
      exitCode = parseExitCode(line.slice(EXIT_CODE_PREFIX.length));
    } else {
      if (!buf.addLine(line)) return;
      if (reportProgress && !reporting) {
        reporting = true;
        void buf
          .reportProgress(reportProgress)
          .catch(() => {})
          .finally(() => {
            reporting = false;
          });
      }
    }
  }
  signal.throwIfAborted();
  // A command can print text resembling an exit marker. Wait for Core to close the stream.
  buf.exitCode = exitCode;
}

/** Execute a server command with a deadline and clean up terminals owned by this call. */
async function executeServerTerminal(
  api: KomodoApi,
  {
    server,
    shell,
    command,
    terminal: persistentName,
  }: { server: string; shell: string; command: string; terminal?: string | undefined },
  { abortSignal, reportProgress, recordAuditDetail }: ToolContext,
): Promise<TerminalResult & { cleanupWarning?: string }> {
  const operation = "executeServerTerminal";
  checkCancelled(abortSignal, operation);
  const target = { type: "Server", params: { server } } as const;
  const terminal = persistentName ?? `mcp-${randomUUID()}`;
  const init = echoSuppressedInit(shell);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TERMINAL_TIMEOUT_MS);
  const signal = AbortSignal.any([abortSignal, deadline.signal]);
  const buf = new OutputBuffer();
  let creation: "none" | "confirmed" | "uncertain" = persistentName === undefined ? "uncertain" : "none";
  let cleanupWarning: string | undefined;

  try {
    if (persistentName === undefined) {
      // Create separately so a late execute request cannot recreate a deleted terminal.
      // Let creation settle even if the caller cancels, then delete with an independent signal.
      try {
        await api.write(
          "CreateTerminal",
          { target, name: terminal, ...init },
          AbortSignal.timeout(TERMINAL_MANAGEMENT_TIMEOUT_MS),
        );
        creation = "confirmed";
      } catch (error) {
        // These rejections occur before Core can create the terminal. Other failures may occur after delivery.
        if (error instanceof KomodoRequestError && [400, 401, 403, 404, 405, 409, 422].includes(error.status)) {
          creation = "none";
        }
        throw error;
      }
    }

    signal.throwIfAborted();
    await collectTerminalOutput(
      api,
      { target, terminal, command, ...(persistentName !== undefined && { init }) },
      signal,
      buf,
      reportProgress,
    );
  } catch (error) {
    checkCancelled(abortSignal, operation);
    if (!deadline.signal.aborted) throw error;
    buf.markTimeout();
  } finally {
    clearTimeout(timer);
    if (creation !== "none") {
      const deleteTerminal = async (): Promise<boolean> => {
        try {
          await api.write("DeleteTerminal", { target, terminal }, AbortSignal.timeout(TERMINAL_MANAGEMENT_TIMEOUT_MS));
          return true;
        } catch {
          return false;
        }
      };
      const deleted = await deleteTerminal();
      if (creation === "confirmed" && deleted) {
        recordAuditDetail({ effect: { terminal, cleanup: "deletion_confirmed" } });
      } else {
        cleanupWarning =
          `Cleanup of isolated terminal ${terminal} is unconfirmed. One best-effort retry is scheduled. ` +
          "If it remains, find it under Terminals in Komodo and remove it there.";
        recordAuditDetail({ effect: { terminal, cleanup: "retry_scheduled" } });
        logger.warn(cleanupWarning);
        // Delete is idempotent. An earlier success may have found no terminal if creation was still in flight.
        setTimeout(() => {
          void deleteTerminal().then((acknowledged) => {
            if (acknowledged) logger.info("Komodo acknowledged the cleanup retry for isolated terminal %s.", terminal);
            else
              logger.warn(
                "Cleanup of isolated terminal %s remains unconfirmed after retry. Check Terminals in Komodo.",
                terminal,
              );
          });
        }, TERMINAL_CLEANUP_RETRY_DELAY_MS).unref();
      }
    }
  }

  checkCancelled(abortSignal, operation);
  return { ...buf.getResult(), ...(cleanupWarning ? { cleanupWarning } : {}) };
}

/** Execute a command on a container, deployment, or stack service without managing its terminal. */
async function executeTerminal(
  api: KomodoApi,
  request: Types.ExecuteTerminalBody,
  abortSignal: AbortSignal,
  reportProgress?: ProgressReporter,
): Promise<TerminalResult> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TERMINAL_TIMEOUT_MS);
  const signal = AbortSignal.any([abortSignal, deadline.signal]);
  const buf = new OutputBuffer();
  try {
    await collectTerminalOutput(api, request, signal, buf, reportProgress);
  } catch (error) {
    if (abortSignal.aborted || !deadline.signal.aborted) throw error;
    buf.markTimeout();
  } finally {
    clearTimeout(timer);
  }
  return buf.getResult();
}

// ============================================================================
// Consolidated `komodo_exec` Tool
// ============================================================================

export const execTool = defineTool({
  name: "komodo_exec",
  description: [
    "Execute a shell command on a Komodo target. `target` selects the context:",
    "server (server[, shell, terminal]) | container (server, container[, shell]) | deployment (deployment[, shell]) | stack_service (stack, service[, shell]).",
    "Server calls use an isolated terminal by default. Pass a terminal name to reuse a shell.",
    "Output ≤50 KB; timeout 5 min.",
  ].join("\n"),
  input: execInputSchema,
  output: execOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
  },
  _meta: { category: ToolCategories.TERMINAL },
  requiredScopes: [ToolScopes.ADMIN],
  handler: async (args, context) => {
    const { abortSignal, reportProgress } = context;
    const komodo = requireClient();
    requireMinimalVersion(await readCoreVersion(), KOMODO_MINIMAL_API_VERSION, "komodo_exec");
    // Shown in the confirmation prompt — keep it recognizable but bounded.
    const commandPreview = args.command.length > 200 ? `${args.command.slice(0, 200)}…` : args.command;

    switch (args.target) {
      case "server": {
        if (!args.server) throw ValidationError.fieldRequired("server");
        const server = args.server;
        await requireKomodoPermission({ type: "Server", id: server }, Types.PermissionLevel.Execute);
        await requireDestructiveConfirmation({
          action: "execute shell command on",
          resourceType: "server",
          resourceId: server,
          detail: `Command: ${commandPreview}`,
        });
        const result = await wrapApiCall(
          "executeServerTerminal",
          () => executeServerTerminal(komodo.client, { ...args, server }, context),
          abortSignal,
        );
        const payload = {
          target: "server" as const,
          command: args.command,
          output: result.output,
          exit_code: result.exitCode,
          truncated: result.truncated,
          server,
        };
        const text = renderExecResult(payload);
        return structured(payload, { text: result.cleanupWarning ? `${text}\n\n${result.cleanupWarning}` : text });
      }

      case "container": {
        if (!args.server) throw ValidationError.fieldRequired("server");
        if (!args.container) throw ValidationError.fieldRequired("container");
        const server = args.server;
        const container = args.container;
        await requireKomodoPermission({ type: "Server", id: server }, Types.PermissionLevel.Execute);
        await requireDestructiveConfirmation({
          action: "execute shell command in",
          resourceType: "container",
          resourceId: container,
          detail: `On server "${server}"; command: ${commandPreview}`,
        });
        const result = await wrapApiCall(
          "executeContainerExec",
          () =>
            executeTerminal(
              komodo.client,
              {
                target: { type: "Container", params: { server, container } },
                command: args.command,
                init: echoSuppressedInit(args.shell),
              },
              abortSignal,
              reportProgress,
            ),
          abortSignal,
        );
        const payload = {
          target: "container" as const,
          command: args.command,
          output: result.output,
          exit_code: result.exitCode,
          truncated: result.truncated,
          server,
          container,
        };
        return structured(payload, { text: renderExecResult(payload) });
      }

      case "deployment": {
        if (!args.deployment) throw ValidationError.fieldRequired("deployment");
        const deployment = args.deployment;
        await requireKomodoPermission({ type: "Deployment", id: deployment }, Types.PermissionLevel.Execute);
        await requireDestructiveConfirmation({
          action: "execute shell command in",
          resourceType: "deployment",
          resourceId: deployment,
          detail: `Command: ${commandPreview}`,
        });
        const result = await wrapApiCall(
          "executeDeploymentExec",
          () =>
            executeTerminal(
              komodo.client,
              {
                target: { type: "Deployment", params: { deployment } },
                command: args.command,
                init: echoSuppressedInit(args.shell),
              },
              abortSignal,
              reportProgress,
            ),
          abortSignal,
        );
        const payload = {
          target: "deployment" as const,
          command: args.command,
          output: result.output,
          exit_code: result.exitCode,
          truncated: result.truncated,
          deployment,
        };
        return structured(payload, { text: renderExecResult(payload) });
      }

      case "stack_service": {
        if (!args.stack) throw ValidationError.fieldRequired("stack");
        if (!args.service) throw ValidationError.fieldRequired("service");
        const stack = args.stack;
        const service = args.service;
        await requireKomodoPermission({ type: "Stack", id: stack }, Types.PermissionLevel.Execute);
        await requireDestructiveConfirmation({
          action: "execute shell command in",
          resourceType: "stack service",
          resourceId: `${stack}/${service}`,
          detail: `Command: ${commandPreview}`,
        });
        const result = await wrapApiCall(
          "executeStackServiceExec",
          () =>
            executeTerminal(
              komodo.client,
              {
                target: { type: "Stack", params: { stack, service } },
                command: args.command,
                init: echoSuppressedInit(args.shell),
              },
              abortSignal,
              reportProgress,
            ),
          abortSignal,
        );
        const payload = {
          target: "stack_service" as const,
          command: args.command,
          output: result.output,
          exit_code: result.exitCode,
          truncated: result.truncated,
          stack,
          service,
        };
        return structured(payload, { text: renderExecResult(payload) });
      }
    }
  },
});
