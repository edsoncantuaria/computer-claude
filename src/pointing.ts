/** Aiming pointer commands (click, hover) and reading where the pointer is. */
import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"
import {
  type DesktopClient,
  DesktopError,
  type DesktopExactWindowTarget,
} from "./desktop-client.js"
import { callDesktop, commandResult, desktopToolError, snapshotInput } from "./tool-shared.js"
import { asRecord, finiteNumber } from "./utils.js"

/** Where a pointer command aims: an element, a text match, or coordinates of a snapshot's screenshot. */
export const pointFields = {
  snapshot_id: snapshotInput,
  element_id: z.string().min(1).optional(),
  query: z.string().min(1).optional().describe("Visible label or text."),
  x: z.number().optional(),
  y: z.number().optional(),
  wait_ms: z.number().int().min(0).max(30_000).optional(),
}

export interface PointInput {
  snapshot_id: string
  element_id?: string
  query?: string
  x?: number
  y?: number
  foreground?: boolean
}

export function checkPointTarget(value: PointInput, context: z.RefinementCtx): void {
  const hasCoordinates = value.x !== undefined && value.y !== undefined
  if ((value.x === undefined) !== (value.y === undefined)) {
    context.addIssue({ code: "custom", message: "x and y must be supplied together." })
  }
  const targetCount = [value.element_id, value.query, hasCoordinates ? true : undefined].filter(
    (item) => item !== undefined
  ).length
  if (targetCount !== 1) {
    context.addIssue({
      code: "custom",
      message: "Supply exactly one target: element_id, query, or x and y.",
    })
  }
}

export interface PointTarget {
  args: string[]
  /** Set when the coordinates belong to one window, which is observed again right before acting. */
  exactWindow?: DesktopExactWindowTarget
  foreground: boolean
}

/** Helper arguments that aim a pointer command where the input says. */
export function pointArgs(desktop: DesktopClient, input: PointInput): PointTarget {
  const foreground = input.foreground ?? false
  if (input.element_id) {
    return { args: ["--on", input.element_id, "--snapshot", input.snapshot_id], foreground }
  }
  if (input.query) return { args: [input.query, "--snapshot", input.snapshot_id], foreground }
  if (input.x === undefined || input.y === undefined) {
    throw new DesktopError("INVALID_TARGET", "Coordinate targets require both x and y.")
  }
  const coordinates = desktop.resolveSnapshotCoordinates(input.snapshot_id, input.x, input.y)
  const args = ["--at", `${coordinates.x},${coordinates.y}`, ...coordinates.targetArgs]
  if (coordinates.global) args.push("--global")
  if (!coordinates.exactWindowTarget) return { args, foreground: true }
  return foreground
    ? { args, foreground }
    : { args, exactWindow: coordinates.exactWindowTarget, foreground }
}

export async function runPointCommand(
  desktop: DesktopClient,
  args: string[],
  target: PointTarget,
  signal: AbortSignal,
  fallbackSummary: string
): Promise<CallToolResult> {
  if (!target.exactWindow) return callDesktop(desktop, args, signal, fallbackSummary)
  const result = await desktop.runWithFreshLocalWindowSnapshot(target.exactWindow, args, signal)
  return commandResult(result, fallbackSummary)
}

/** Where the pointer is on the desktop and, given a snapshot, in that screenshot's pixels. */
export async function pointerPosition(
  desktop: DesktopClient,
  snapshotId: string | undefined,
  signal: AbortSignal
): Promise<CallToolResult> {
  try {
    const result = await desktop.run(["pointer"], signal)
    const data = asRecord(result.data)
    const x = finiteNumber(data?.x)
    const y = finiteNumber(data?.y)
    const summary = typeof result.summary === "string" ? result.summary : "Pointer read."
    const image =
      snapshotId && x !== undefined && y !== undefined
        ? desktop.toImagePixels(snapshotId, x, y)
        : undefined
    const text = image
      ? `${summary} In the screenshot of ${snapshotId} that is (${image.x}, ${image.y}).`
      : summary
    return { content: [{ type: "text", text }] }
  } catch (error) {
    return desktopToolError(error)
  }
}
