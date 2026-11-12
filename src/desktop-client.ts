/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Biome fails to track stopping across async lifecycle callbacks */
import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { asRecord, finiteNumber as numberValue } from "./utils.js"

const execFileAsync = promisify(execFile)
/** Raw JPEG budget that keeps the base64 image within a 4 MB tool result. */
const MAX_IMAGE_BYTES = 2_900_000
const PID_APP_RE = /^PID:\d+$/u

interface DesktopEnvelope {
  success: boolean
  data?: unknown
  summary?: unknown
  messages?: unknown
  error?: {
    code?: unknown
    message?: unknown
    details?: unknown
  }
}

export interface DesktopResult {
  data?: unknown
  summary?: unknown
  messages?: string[]
}

export interface DesktopObservation extends DesktopResult {
  imageData: string
  mimeType: "image/jpeg"
  target?: DesktopSnapshotTarget
}

export interface DesktopSnapshotTarget {
  kind?: string
  app?: string
  windowId?: number
  windowTitle?: string
  screenIndex?: number
  bounds?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export type DesktopObservationTarget =
  | { kind: "frontmost" }
  | { kind: "screen"; screenIndex: number }
  | { kind: "app"; app: string }
  | { kind: "window"; windowId: number; app?: string }

export interface DesktopObservationRequest {
  target: DesktopObservationTarget
  annotate: boolean
  noWebFocus?: boolean
  savePath?: string
}

export interface DesktopInspectRequest {
  snapshotId: string
  maxDepth: number
  maxElements: number
  maxChildren: number
  offset?: number
}

export interface DesktopExactWindowTarget {
  app?: string
  windowId: number
}

export interface DesktopResolvedCoordinates {
  x: number
  y: number
  global: boolean
  targetArgs: string[]
  exactWindowTarget?: DesktopExactWindowTarget
}

export interface DesktopClientOptions {
  executable?: string
  baseArgs?: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
}

export class DesktopError extends Error {
  readonly code: string
  readonly details?: string

  constructor(code: string, message: string, details?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DesktopError"
    this.code = code
    this.details = details
  }
}

export class DesktopClient {
  readonly executable: string

  private readonly baseArgs: string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly shutdownController = new AbortController()
  private readonly snapshots = new Map<string, DesktopSnapshotTarget>()

  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(options: DesktopClientOptions = {}) {
    this.executable = options.executable ?? defaultExecutable()
    this.baseArgs = options.baseArgs ?? []
    this.env = options.env ?? process.env
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024
  }

  run(args: string[], signal?: AbortSignal): Promise<DesktopResult> {
    return this.enqueue((requestSignal) => this.runNow(args, requestSignal), signal)
  }

  observe(request: DesktopObservationRequest, signal?: AbortSignal): Promise<DesktopObservation> {
    return this.enqueue((requestSignal) => this.observeNow(request, requestSignal), signal)
  }

  inspect(request: DesktopInspectRequest, signal?: AbortSignal): Promise<DesktopResult> {
    return this.enqueue((requestSignal) => this.inspectNow(request, requestSignal), signal)
  }

  runWithFreshLocalWindowSnapshot(
    target: DesktopExactWindowTarget,
    args: string[],
    signal?: AbortSignal
  ): Promise<DesktopResult> {
    return this.enqueue(async (requestSignal) => {
      const directory = await mkdtemp(join(tmpdir(), "computer-claude-receipt-"))
      const requestedPath = join(directory, "capture.png")

      try {
        const seeArgs = ["see"]
        if (target.app) seeArgs.push("--app", target.app)
        seeArgs.push(
          "--window-id",
          String(target.windowId),
          "--no-elements",
          "--path",
          requestedPath
        )
        const observation = await this.runNow(seeArgs, requestSignal)
        const snapshotId = stringValue(asRecord(observation.data)?.snapshot_id)
        if (!snapshotId) {
          throw new DesktopError(
            "SNAPSHOT_MISSING",
            "The desktop helper did not return a snapshot ID for the exact window."
          )
        }
        return this.runNow([...args, "--snapshot", snapshotId], requestSignal)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, signal)
  }

  getSnapshotTarget(snapshotId: string): DesktopSnapshotTarget | undefined {
    return this.snapshots.get(snapshotId)
  }

  requireSnapshotTarget(snapshotId: string): DesktopSnapshotTarget {
    const target = this.snapshots.get(snapshotId)
    if (target) return target
    throw new DesktopError(
      "SNAPSHOT_TARGET_MISSING",
      "The observation target is no longer available. Call computer_observe again."
    )
  }

  requireExactWindowTarget(snapshotId: string, message: string): DesktopExactWindowTarget {
    const target = this.requireSnapshotTarget(snapshotId)
    const exactWindow = exactWindowTarget(target)
    if (exactWindow) return exactWindow
    throw new DesktopError("EXACT_WINDOW_REQUIRED", message)
  }

  resolveSnapshotCoordinates(snapshotId: string, x: number, y: number): DesktopResolvedCoordinates {
    const target = this.requireSnapshotTarget(snapshotId)
    const exactWindow = exactWindowTarget(target)
    const needsGlobalCoordinates =
      isScreenSnapshotTarget(target) || (target.windowId === undefined && !target.app)

    if (!needsGlobalCoordinates) {
      return {
        x,
        y,
        global: false,
        targetArgs: snapshotActionTargetArgs(target),
        ...(exactWindow ? { exactWindowTarget: exactWindow } : {}),
      }
    }
    if (!target.bounds) {
      throw new DesktopError(
        "SNAPSHOT_BOUNDS_MISSING",
        "The observation bounds are unavailable. Call computer_observe again."
      )
    }
    return {
      x: x + target.bounds.x,
      y: y + target.bounds.y,
      global: true,
      targetArgs: snapshotActionTargetArgs(target),
      ...(exactWindow ? { exactWindowTarget: exactWindow } : {}),
    }
  }

  rememberSnapshotTarget(snapshotId: string, target: DesktopSnapshotTarget): void {
    this.rememberSnapshot(snapshotId, target)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.shutdownController.abort()
    await this.queue
  }

  private enqueue<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const queued = async () => {
      if (this.closed) {
        throw new DesktopError("COMPUTER_CLOSED", "Computer Use is closed.")
      }
      const requestSignal = signal
        ? AbortSignal.any([signal, this.shutdownController.signal])
        : this.shutdownController.signal
      requestSignal.throwIfAborted()
      return operation(requestSignal)
    }

    const result = this.queue.then(queued, queued)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async observeNow(
    request: DesktopObservationRequest,
    signal: AbortSignal
  ): Promise<DesktopObservation> {
    const directory = await mkdtemp(join(tmpdir(), "computer-claude-"))
    const requestedPath = join(directory, "capture.png")
    const args = observationRequestArgs(request)

    try {
      const result = await this.runNow(
        ["see", ...args, "--path", requestedPath, ...(request.annotate ? ["--annotate"] : [])],
        signal
      )
      const data = asRecord(result.data)
      const snapshotId = stringValue(data?.snapshot_id)
      const target = await this.resolveObservationTarget(request.target, data, signal)
      if (snapshotId && target) this.rememberSnapshot(snapshotId, target)
      const imagePath = screenshotPath(data, requestedPath, request.annotate)

      try {
        if (request.savePath) {
          await mkdir(dirname(request.savePath), { recursive: true })
          await copyFile(imagePath, request.savePath)
        }
        const jpegPath = join(directory, "capture.jpg")
        await this.runNow(["jpeg", imagePath, jpegPath, String(MAX_IMAGE_BYTES)], signal)
        return {
          ...result,
          imageData: (await readFile(jpegPath)).toString("base64"),
          mimeType: "image/jpeg",
          ...(target ? { target } : {}),
        }
      } catch (error) {
        if (error instanceof DesktopError) throw error
        throw desktopErrorWithCause(
          "SCREENSHOT_READ_FAILED",
          "The desktop helper completed but its screenshot could not be read, saved, or encoded.",
          unknownErrorMessage(error),
          error
        )
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async inspectNow(
    request: DesktopInspectRequest,
    signal: AbortSignal
  ): Promise<DesktopResult> {
    const target = this.requireSnapshotTarget(request.snapshotId)
    const result = await this.runNow(
      [
        "see",
        ...snapshotObservationTargetArgs(target),
        "--tree",
        "--no-screenshot",
        "--depth",
        String(request.maxDepth),
        "--max-elements",
        String(request.maxElements),
        "--max-children",
        String(request.maxChildren),
        ...(request.offset ? ["--skip", String(request.offset)] : []),
      ],
      signal
    )
    const inspectedSnapshotId = stringValue(asRecord(result.data)?.snapshot_id)
    if (inspectedSnapshotId) this.rememberSnapshot(inspectedSnapshotId, target)
    return result
  }

  private async resolveObservationTarget(
    requestedTarget: DesktopObservationTarget,
    data: Record<string, unknown> | undefined,
    signal: AbortSignal
  ): Promise<DesktopSnapshotTarget | undefined> {
    let target = observationTarget(data)
    const requestedApp =
      requestedTarget.kind === "app" || requestedTarget.kind === "window"
        ? requestedTarget.app
        : undefined
    if (requestedApp !== undefined && PID_APP_RE.test(requestedApp)) {
      target = {
        ...target,
        app: requestedApp,
      }
    }
    const requestedWindowId =
      requestedTarget.kind === "window" ? requestedTarget.windowId : undefined
    if (requestedWindowId !== undefined && target?.windowId === undefined) {
      target = {
        ...target,
        kind: target?.kind ?? "window-id",
        windowId: requestedWindowId,
      }
    }

    const screenCapture = isScreenSnapshotTarget(target) || requestedTarget.kind === "screen"
    if (screenCapture) {
      const screenIndex = requestedTarget.kind === "screen" ? requestedTarget.screenIndex : 0
      target = { ...target, kind: target?.kind ?? "screen", screenIndex }
      if (!target.bounds) {
        const screens = await this.runNow(["screen", "list"], signal)
        const bounds = screenBounds(screens.data, screenIndex)
        if (bounds) {
          target = { ...target, bounds }
        }
      }
    }
    return target
  }

  private rememberSnapshot(snapshotId: string, target: DesktopSnapshotTarget): void {
    this.snapshots.delete(snapshotId)
    this.snapshots.set(snapshotId, target)
    while (this.snapshots.size > 64) {
      const oldest = this.snapshots.keys().next()
      if (oldest.done) break
      this.snapshots.delete(oldest.value)
    }
  }

  private async runNow(args: string[], signal: AbortSignal): Promise<DesktopResult> {
    const commandArgs = [...this.baseArgs, ...args, "--json"]
    let stdout: string
    let stderr: string

    try {
      const output = await execFileAsync(this.executable, commandArgs, {
        encoding: "utf8",
        env: this.env,
        maxBuffer: this.maxOutputBytes,
        signal,
        timeout: this.timeoutMs,
      })
      stdout = String(output.stdout)
      stderr = String(output.stderr)
    } catch (error) {
      stdout = processOutput(error, "stdout")
      stderr = processOutput(error, "stderr")
      const envelope = tryParseEnvelope(stdout)
      if (envelope?.success === false) throw envelopeError(envelope, error)

      if (errorCode(error) === "ENOENT") {
        throw desktopErrorWithCause(
          "HELPER_NOT_FOUND",
          `The desktop helper ${JSON.stringify(this.executable)} was not found.`,
          undefined,
          error
        )
      }

      const detail = unknownErrorMessage(error)
      throw desktopErrorWithCause(
        "HELPER_PROCESS_FAILED",
        `The desktop helper command failed: ${detail}`,
        stderr.trim().slice(-4096) || undefined,
        error
      )
    }

    const envelope = parseEnvelope(stdout, stderr)
    if (!envelope.success) throw envelopeError(envelope)

    return {
      ...(envelope.data === undefined ? {} : { data: envelope.data }),
      ...(envelope.summary === undefined ? {} : { summary: envelope.summary }),
      ...(Array.isArray(envelope.messages)
        ? {
            messages: envelope.messages.filter((item): item is string => typeof item === "string"),
          }
        : {}),
    }
  }
}

function parseEnvelope(stdout: string, stderr: string): DesktopEnvelope {
  const envelope = tryParseEnvelope(stdout)
  if (envelope) return envelope

  throw new DesktopError(
    "HELPER_INVALID_JSON",
    "The desktop helper did not return its expected JSON response.",
    stderr.trim().slice(-4096) || stdout.trim().slice(-4096) || undefined
  )
}

function tryParseEnvelope(stdout: string): DesktopEnvelope | null {
  try {
    const parsed = asRecord(JSON.parse(stdout.trim()))
    if (!parsed) return null
    const success = parsed.success
    if (typeof success !== "boolean") return null
    const parsedError = asRecord(parsed.error)
    return {
      success,
      ...("data" in parsed ? { data: parsed.data } : {}),
      ...("summary" in parsed ? { summary: parsed.summary } : {}),
      ...("messages" in parsed ? { messages: parsed.messages } : {}),
      ...(parsedError
        ? {
            error: {
              ...("code" in parsedError ? { code: parsedError.code } : {}),
              ...("message" in parsedError ? { message: parsedError.message } : {}),
              ...("details" in parsedError ? { details: parsedError.details } : {}),
            },
          }
        : {}),
    }
  } catch {
    return null
  }
}

function envelopeError(envelope: DesktopEnvelope, cause?: unknown): DesktopError {
  const code =
    typeof envelope.error?.code === "string" ? envelope.error.code : "HELPER_COMMAND_FAILED"
  const message =
    typeof envelope.error?.message === "string"
      ? envelope.error.message
      : "The desktop helper reported a command failure."
  const details = typeof envelope.error?.details === "string" ? envelope.error.details : undefined
  return cause === undefined
    ? new DesktopError(code, message, details)
    : desktopErrorWithCause(code, message, details, cause)
}

function processOutput(error: unknown, field: "stdout" | "stderr"): string {
  const value = asRecord(error)?.[field]
  if (typeof value === "string") return value
  if (Buffer.isBuffer(value)) return value.toString("utf8")
  return ""
}

function screenshotPath(
  data: Record<string, unknown> | undefined,
  requestedPath: string,
  annotate: boolean
): string {
  if (annotate && typeof data?.screenshot_annotated === "string" && data.screenshot_annotated) {
    return data.screenshot_annotated
  }
  if (typeof data?.screenshot_raw === "string" && data.screenshot_raw) return data.screenshot_raw
  return requestedPath
}

function errorCode(error: unknown): string | undefined {
  const code = asRecord(error)?.code
  return typeof code === "string" ? code : undefined
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error)
  }
  return "Unknown error"
}

function desktopErrorWithCause(
  code: string,
  message: string,
  details: string | undefined,
  cause: unknown
): DesktopError {
  return new DesktopError(code, message, details, { cause })
}

function observationTarget(
  data: Record<string, unknown> | undefined
): DesktopSnapshotTarget | undefined {
  if (!data) return undefined
  const observation = asRecord(data.observation)
  const target = asRecord(observation?.target)
  const bounds = rectangle(target?.bounds)
  const kind =
    stringValue(target?.resolvedKind) ??
    stringValue(target?.resolved_kind) ??
    stringValue(target?.requestedKind) ??
    stringValue(target?.requested_kind) ??
    stringValue(data.capture_mode)
  const stateSnapshot =
    asRecord(observation?.stateSnapshot) ?? asRecord(observation?.state_snapshot)
  const windowId =
    numberValue(target?.windowID) ??
    numberValue(target?.window_id) ??
    numberValue(stateSnapshot?.frontmostWindowID) ??
    numberValue(stateSnapshot?.frontmost_window_id)
  const app = stringValue(data.application_name)
  const windowTitle = stringValue(data.window_title)

  if (!kind && !windowId && !app && !windowTitle && !bounds) return undefined
  return {
    ...(kind ? { kind } : {}),
    ...(app ? { app } : {}),
    ...(windowId ? { windowId } : {}),
    ...(windowTitle ? { windowTitle } : {}),
    ...(bounds ? { bounds } : {}),
  }
}

function rectangle(value: unknown): DesktopSnapshotTarget["bounds"] | undefined {
  if (Array.isArray(value)) {
    const origin = Array.isArray(value[0]) ? value[0] : []
    const size = Array.isArray(value[1]) ? value[1] : []
    const x = numberValue(origin[0])
    const y = numberValue(origin[1])
    const width = numberValue(size[0])
    const height = numberValue(size[1])
    return x !== undefined && y !== undefined && width !== undefined && height !== undefined
      ? { x, y, width, height }
      : undefined
  }
  const record = asRecord(value)
  if (!record) return undefined
  const origin = asRecord(record.origin)
  const size = asRecord(record.size)
  const x = numberValue(record.x) ?? numberValue(origin?.x)
  const y = numberValue(record.y) ?? numberValue(origin?.y)
  const width = numberValue(record.width) ?? numberValue(size?.width)
  const height = numberValue(record.height) ?? numberValue(size?.height)
  return x !== undefined && y !== undefined && width !== undefined && height !== undefined
    ? { x, y, width, height }
    : undefined
}

function screenBounds(
  data: unknown,
  screenIndex: number
): DesktopSnapshotTarget["bounds"] | undefined {
  const screens = asRecord(data)?.screens
  if (!Array.isArray(screens)) return undefined
  const screen = screens.map(asRecord).find((item) => numberValue(item?.index) === screenIndex)
  return rectangle(screen?.bounds)
}

function observationRequestArgs(request: DesktopObservationRequest): string[] {
  const args: string[] = []
  const target = request.target
  if (target.kind === "frontmost") {
    args.push("--mode", "frontmost")
  } else if (target.kind === "screen") {
    args.push("--mode", "screen", "--screen-index", String(target.screenIndex))
  } else if (target.kind === "app") {
    args.push("--app", target.app)
  } else {
    if (target.app) args.push("--app", target.app)
    args.push("--window-id", String(target.windowId))
  }
  if (request.noWebFocus) args.push("--no-web-focus")
  return args
}

function isScreenSnapshotTarget(target: DesktopSnapshotTarget | undefined): boolean {
  return target?.kind?.toLowerCase().includes("screen") ?? false
}

function exactWindowTarget(target: DesktopSnapshotTarget): DesktopExactWindowTarget | undefined {
  if (isScreenSnapshotTarget(target) || target.windowId === undefined) return undefined
  return {
    ...(target.app ? { app: target.app } : {}),
    windowId: target.windowId,
  }
}

function snapshotActionTargetArgs(target: DesktopSnapshotTarget): string[] {
  if (isScreenSnapshotTarget(target)) return []
  if (target.windowId !== undefined) return ["--window-id", String(target.windowId)]
  if (target.app) return ["--app", target.app]
  return []
}

function snapshotObservationTargetArgs(target: DesktopSnapshotTarget): string[] {
  if (isScreenSnapshotTarget(target)) {
    return ["--mode", "screen", "--screen-index", String(target.screenIndex ?? 0)]
  }
  if (target.windowId !== undefined) {
    return [...(target.app ? ["--app", target.app] : []), "--window-id", String(target.windowId)]
  }
  if (target.app && target.windowTitle) {
    return ["--app", target.app, "--window-title", target.windowTitle]
  }
  if (target.app) return ["--app", target.app]
  return ["--mode", "frontmost"]
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** The helper ships next to the bundled server (`dist/`) and next to the sources (`src/`). */
function defaultExecutable(): string {
  return fileURLToPath(new URL("../desktop/computer-claude-desktop", import.meta.url))
}
