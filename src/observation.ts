import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"
import type {
  DesktopClient,
  DesktopObservation,
  DesktopObservationTarget,
} from "./desktop-client.js"
import type { ToolRegistrar } from "./registrar.js"
import { appInput, desktopToolError, snapshotInput, windowIdInput } from "./tool-shared.js"
import { asRecord } from "./utils.js"

/** Time for the UI to react before the observation that follows an action. */
const SETTLE_MS = 400
const WAIT_POLL_MS = 500

export interface ActionInput {
  observe_after?: boolean
  snapshot_id?: string
  app?: string
  window_id?: number
}

/** Tools that look at the desktop beyond computer_observe: zooming into a capture and waiting for text. */
export function registerObservationTools(
  registerTool: ToolRegistrar,
  desktop: DesktopClient
): void {
  registerTool(
    "computer_zoom",
    {
      description:
        "Read a region of an observed screenshot at full resolution, for small text. Region is in that screenshot's pixels. The zoomed image is for reading only: keep clicking with coordinates from the observation.",
      inputSchema: z.object({
        snapshot_id: snapshotInput,
        x: z.number().min(0),
        y: z.number().min(0),
        width: z.number().positive(),
        height: z.number().positive(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ snapshot_id, ...region }, ctx) => {
      try {
        const image = await desktop.zoom(snapshot_id, region, ctx.mcpReq.signal)
        return {
          content: [
            { type: "text", text: "Zoomed region." },
            { type: "image", data: image.imageData, mimeType: image.mimeType },
          ],
        }
      } catch (error) {
        return desktopToolError(error)
      }
    }
  )

  registerTool(
    "computer_wait",
    {
      description:
        "Wait until text appears in (or, with gone=true, disappears from) the elements of an app, window, or the screen. Use it after launching apps, loading pages, or starting long operations instead of observing repeatedly. Returns a snapshot_id and the matching elements.",
      inputSchema: z.object({
        text: z.string().min(1).describe("Label or text to look for, case-insensitive."),
        app: appInput.optional(),
        window_id: windowIdInput.optional(),
        gone: z.boolean().default(false),
        timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ text, app, window_id, gone, timeout_ms }, ctx) => {
      return waitForText(
        desktop,
        { text, gone, timeoutMs: timeout_ms },
        observationTarget({ app, window_id }),
        ctx.mcpReq.signal
      )
    }
  )
}

async function waitForText(
  desktop: DesktopClient,
  wait: { text: string; gone: boolean; timeoutMs: number },
  target: DesktopObservationTarget,
  signal: AbortSignal
): Promise<CallToolResult> {
  const needle = wait.text.toLowerCase()
  const quoted = JSON.stringify(wait.text)
  const started = Date.now()
  let lastError = ""
  let elapsed = 0
  do {
    try {
      const data = asRecord((await desktop.readElements(target, signal)).data)
      const snapshotId = stringValue(data?.snapshot_id)
      const matches = (stringValue(data?.text) ?? "")
        .split("\n")
        .filter((line) => line.toLowerCase().includes(needle))
      elapsed = Date.now() - started
      if (matches.length > 0 !== wait.gone) {
        const lines = [
          `${quoted} ${wait.gone ? "is gone" : "appeared"} after ${elapsed} ms.`,
          ...(snapshotId ? [`snapshot_id=${snapshotId}`] : []),
          ...matches.slice(0, 20).map((line) => line.trim()),
        ]
        return { content: [{ type: "text", text: lines.join("\n") }] }
      }
      lastError = ""
    } catch (error) {
      // The app may not have a window yet; keep waiting unless the wait itself was cancelled.
      if (signal.aborted) return desktopToolError(error)
      lastError = ` Last error: ${error instanceof Error ? error.message : String(error)}`
      elapsed = Date.now() - started
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
  } while (elapsed < wait.timeoutMs)
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `WAIT_TIMEOUT: ${quoted} ${wait.gone ? "was still present" : "did not appear"} within ${wait.timeoutMs} ms.${lastError} Observe to see the current state.`,
      },
    ],
  }
}

export function observationTarget(input: {
  app?: string
  window_id?: number
}): DesktopObservationTarget {
  if (input.window_id !== undefined) {
    return { kind: "window", windowId: input.window_id, ...(input.app ? { app: input.app } : {}) }
  }
  return input.app === undefined ? { kind: "frontmost" } : { kind: "app", app: input.app }
}

/** Appends what the target looks like now, so the model need not spend a call to find out. */
export async function withObservation(
  desktop: DesktopClient,
  result: CallToolResult,
  input: ActionInput,
  signal: AbortSignal
): Promise<CallToolResult> {
  const observed = input.snapshot_id ? desktop.getSnapshotTarget(input.snapshot_id) : undefined
  let target: DesktopObservationTarget
  if (observed?.kind?.includes("screen")) {
    target = { kind: "screen", screenIndex: observed.screenIndex ?? 0 }
  } else {
    target = observationTarget({
      app: input.app ?? observed?.app,
      window_id: input.window_id ?? observed?.windowId,
    })
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  try {
    const observation = await desktop.observe({ target, annotate: false, noWebFocus: true }, signal)
    return { content: [...result.content, ...observationResult(observation).content] }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      content: [
        ...result.content,
        { type: "text", text: `The action ran, but the target could not be observed: ${reason}` },
      ],
    }
  }
}

export function observationResult(
  observation: DesktopObservation,
  savedPath?: string
): CallToolResult {
  const data = asRecord(observation.data) ?? {}
  const application = stringValue(data.application_name)
  const windowTitle = stringValue(data.window_title)
  const target = [application, windowTitle].filter(Boolean).join(" — ") || "the screen"
  const snapshotId = stringValue(data.snapshot_id)
  const elements = stringValue(data.text)
  const lines = [
    `Observed ${target}.${savedPath ? ` Saved to ${savedPath}.` : ""}`,
    ...(snapshotId ? [`snapshot_id=${snapshotId}`] : []),
    ...(elements ? [elements] : []),
    ...(data.truncated && !elements?.includes("more elements exist")
      ? ["The element list is partial; use computer_inspect with offset for the rest."]
      : []),
  ]

  return {
    content: [
      { type: "text", text: lines.join("\n") },
      {
        type: "image",
        data: observation.imageData,
        mimeType: observation.mimeType,
      },
    ],
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
