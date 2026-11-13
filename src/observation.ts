import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"
import type {
  DesktopClient,
  DesktopObservation,
  DesktopObservationTarget,
  DesktopView,
} from "./desktop-client.js"
import { recordError } from "./error-log.js"
import type { ToolRegistrar } from "./registrar.js"
import {
  appInput,
  desktopToolError,
  snapshotInput,
  toolFailure,
  windowIdInput,
} from "./tool-shared.js"
import { asRecord } from "./utils.js"

/** Time for the UI to react before the observation that follows an action. */
const SETTLE_MS = 400
const WAIT_POLL_MS = 200

export interface ActionInput {
  observe_after?: boolean
  snapshot_id?: string
  app?: string
  window_id?: number
}

const regionInput = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .describe("Part of the snapshot's screenshot to look at, in its pixels. Needs snapshot_id.")

const viewFields = {
  app: appInput.optional(),
  window_id: windowIdInput.optional(),
  snapshot_id: snapshotInput.optional().describe("Look at what this snapshot observed."),
  region: regionInput.optional(),
}

interface ViewInput extends ActionInput {
  region?: DesktopView["region"]
}

function checkRegion(value: ViewInput, context: z.RefinementCtx): void {
  if (value.region && !value.snapshot_id) {
    context.addIssue({ code: "custom", message: "region needs the snapshot_id it was read from." })
  }
}

function viewOf(desktop: DesktopClient, input: ViewInput): DesktopView {
  return {
    target: targetOf(desktop, input),
    ...(input.snapshot_id ? { snapshotId: input.snapshot_id } : {}),
    ...(input.region ? { region: input.region } : {}),
  }
}

/** Tools that look at the desktop beyond computer_observe: zooming, waiting, and watching motion. */
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
        'Wait for something that takes time, instead of observing repeatedly. With text: until it appears in (or, with gone=true, disappears from) the elements; returns a snapshot_id and the matching elements. With visual, for apps that expose no elements (games, canvases, Wine): "change" waits until the picture differs from how it looks now, "still" until it stops changing (loading or an animation finished); returns a fresh observation. Narrow a visual wait with snapshot_id and region so a clock or a spinner elsewhere does not end it.',
      inputSchema: z
        .object({
          text: z
            .string()
            .min(1)
            .optional()
            .describe("Label or text to look for, case-insensitive."),
          gone: z.boolean().default(false),
          visual: z.enum(["change", "still"]).optional(),
          ...viewFields,
          timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
        })
        .superRefine((value, context) => {
          checkRegion(value, context)
          if ((value.text === undefined) === (value.visual === undefined)) {
            context.addIssue({ code: "custom", message: "Supply exactly one of text or visual." })
          }
        }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ text, gone, visual, timeout_ms, ...input }, ctx) => {
      const signal = ctx.mcpReq.signal
      if (text !== undefined) {
        return waitForText(
          desktop,
          { text, gone, timeoutMs: timeout_ms },
          targetOf(desktop, input),
          signal
        )
      }
      try {
        const until = visual ?? "change"
        const { met, elapsedMs } = await desktop.watch(
          viewOf(desktop, input),
          until,
          timeout_ms,
          signal
        )
        if (!met) {
          return toolFailure(
            "WAIT_TIMEOUT",
            `The picture ${until === "change" ? "did not change" : "kept changing"} within ${timeout_ms} ms. Observe to see the current state.`,
            "watch"
          )
        }
        const summary = `The picture ${until === "change" ? "changed" : "settled"} after ${elapsedMs} ms.`
        return await withObservation(
          desktop,
          { content: [{ type: "text", text: summary }] },
          input,
          signal,
          0
        )
      } catch (error) {
        return desktopToolError(error)
      }
    }
  )

  registerTool(
    "computer_frames",
    {
      description:
        "Capture an app, window, the screen, or a region of a snapshot several times in a row, to see motion: an animation, a game, a transition. Frames are small and for watching only; observe again before clicking.",
      inputSchema: z
        .object({
          ...viewFields,
          count: z.number().int().min(2).max(8).default(4),
          interval_ms: z.number().int().min(100).max(5000).default(500),
        })
        .superRefine(checkRegion),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ count, interval_ms, ...input }, ctx) => {
      try {
        const frames = await desktop.frames(
          viewOf(desktop, input),
          count,
          interval_ms,
          ctx.mcpReq.signal
        )
        return {
          content: [
            {
              type: "text",
              text: `${frames.length} frames, taken at ${frames.map((frame) => frame.atMs).join(", ")} ms.`,
            },
            ...frames.map((frame) => ({
              type: "image" as const,
              data: frame.imageData,
              mimeType: frame.mimeType,
            })),
          ],
        }
      } catch (error) {
        return desktopToolError(error)
      }
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
  const outcome = `${wait.gone ? "was still present" : "did not appear"} within ${wait.timeoutMs} ms.${lastError}`
  // The log never holds tool arguments, so it leaves out the text that was waited for.
  recordError({ source: "tool", code: "WAIT_TIMEOUT", command: "see", message: `Text ${outcome}` })
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `WAIT_TIMEOUT: ${quoted} ${outcome} Observe to see the current state.`,
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

/** What an input names: its app or window, else whatever its snapshot observed. */
function targetOf(desktop: DesktopClient, input: ActionInput): DesktopObservationTarget {
  const observed = input.snapshot_id ? desktop.getSnapshotTarget(input.snapshot_id) : undefined
  if (observed?.kind?.includes("screen")) {
    return { kind: "screen", screenIndex: observed.screenIndex ?? 0 }
  }
  return observationTarget({
    app: input.app ?? observed?.app,
    window_id: input.window_id ?? observed?.windowId,
  })
}

/** Appends what the target looks like now, so the model need not spend a call to find out. */
export async function withObservation(
  desktop: DesktopClient,
  result: CallToolResult,
  input: ActionInput,
  signal: AbortSignal,
  settleMs = SETTLE_MS
): Promise<CallToolResult> {
  const target = targetOf(desktop, input)
  await new Promise((resolve) => setTimeout(resolve, settleMs))
  try {
    // The picture is what shows the effect; reading a window with no elements would add about a second.
    const observation = await desktop.observe(
      { target, annotate: false, noWebFocus: true, noOcr: true },
      signal
    )
    return { content: [...result.content, ...observationResult(observation).content] }
  } catch (error) {
    // The action itself succeeded, so the call does not fail; the lost observation is still a problem to keep.
    const failure = desktopToolError(error)
    const reason = failure.content[0]?.type === "text" ? failure.content[0].text : String(error)
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
