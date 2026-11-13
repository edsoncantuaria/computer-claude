import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"
import { type DesktopClient, DesktopError, type DesktopResult } from "./desktop-client.js"
import { recordError, recordTiming } from "./error-log.js"

export const appInput = z.string().min(1).describe("App name, bundle or desktop ID, or PID:12345.")
export const snapshotInput = z
  .string()
  .min(1)
  .describe("Snapshot ID from computer_observe or computer_inspect.")
export const windowIdInput = z.number().int().positive().describe("Window ID from computer_list.")

export const targetFields = {
  app: appInput.optional(),
  window_id: windowIdInput.optional(),
  snapshot_id: snapshotInput.optional(),
}

export function addTargetArgs(
  args: string[],
  target: { app?: string; window_id?: number; snapshot_id?: string }
): void {
  if (target.app !== undefined) args.push("--app", target.app)
  if (target.window_id !== undefined) args.push("--window-id", String(target.window_id))
  if (target.snapshot_id !== undefined) args.push("--snapshot", target.snapshot_id)
}

export async function callDesktop(
  desktop: DesktopClient,
  args: string[],
  signal: AbortSignal,
  fallbackSummary: string,
  timeoutMs?: number
): Promise<CallToolResult> {
  try {
    return commandResult(await desktop.run(args, signal, timeoutMs), fallbackSummary)
  } catch (error) {
    return desktopToolError(error)
  }
}

export function commandResult(result: DesktopResult, fallbackSummary: string): CallToolResult {
  const summary =
    typeof result.summary === "string"
      ? result.summary
      : (result.messages?.find((message) => message.trim()) ?? fallbackSummary)
  // Text only: a client that prefers structuredContent would hide the summary from the model.
  return { content: [{ type: "text", text: summary }] }
}

/** Wraps a tool's handler so that every call leaves how long it took in the timing log. */
export function timed<Input, Context>(
  name: string,
  handler: (input: Input, ctx: Context) => Promise<CallToolResult>
): (input: Input, ctx: Context) => Promise<CallToolResult> {
  return async (input, ctx) => {
    const started = performance.now()
    let ok = false
    try {
      const result = await handler(input, ctx)
      ok = !result.isError
      return result
    } finally {
      recordTiming({ kind: "tool", name, ms: performance.now() - started, ok })
    }
  }
}

/** A failure the tool layer found itself, recorded and worded like one from the helper. */
export function toolFailure(code: string, message: string, command?: string): CallToolResult {
  const error = new DesktopError(code, message)
  error.command = command
  return desktopToolError(error)
}

export function desktopToolError(error: unknown): CallToolResult {
  // Every failed tool call ends here, so this is the one place that keeps a record of it.
  if (error instanceof DesktopError) {
    recordError({
      source: "tool",
      code: error.code,
      message: error.message,
      command: error.command,
      details: error.details,
    })
  } else {
    recordError({
      source: "tool",
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof Error ? error.stack : undefined,
    })
  }
  if (error instanceof DesktopError) {
    return {
      content: [
        {
          type: "text",
          text: `${error.code}: ${error.message}${error.details ? ` (${error.details})` : ""}`,
        },
      ],
      isError: true,
    }
  }
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  }
}
