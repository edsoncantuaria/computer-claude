/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: Biome fails to track stopping across async lifecycle callbacks */
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { recordError, recordTiming } from "./error-log.js"
import { HelperProcess } from "./helper-process.js"
import { asRecord, finiteNumber as numberValue } from "./utils.js"

/** Raw image budget that keeps the base64 image within a 4 MB tool result. */
const MAX_IMAGE_BYTES = 2_900_000
/** Longest screenshot edge. Larger images are downscaled by the model API, which would skew coordinates. */
const MAX_IMAGE_EDGE = 1568
const PID_APP_RE = /^PID:\d+$/u

interface DesktopEnvelope {
  success: boolean
  data?: unknown
  summary?: unknown
  messages?: unknown
  warnings?: unknown
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

export type DesktopImageType = "image/png" | "image/jpeg"

export interface DesktopObservation extends DesktopResult {
  imageData: string
  mimeType: DesktopImageType
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
  /** Screenshot pixels per desktop pixel: the image the model saw is this much smaller. */
  imageScale?: number
}

export interface DesktopImageRegion {
  x: number
  y: number
  width: number
  height: number
}

export type DesktopObservationTarget =
  | { kind: "frontmost" }
  | { kind: "screen"; screenIndex: number }
  | { kind: "app"; app: string }
  | { kind: "window"; windowId: number; app?: string }

/** What a visual command watches: a target, or one region of a snapshot's screenshot of it. */
export interface DesktopView {
  target: DesktopObservationTarget
  snapshotId?: string
  region?: DesktopImageRegion
}

export interface DesktopFrame {
  imageData: string
  mimeType: DesktopImageType
  atMs: number
}

export interface DesktopObservationRequest {
  target: DesktopObservationTarget
  annotate: boolean
  noWebFocus?: boolean
  /** Skip reading the text of a window that exposes no elements, which takes about a second. */
  noOcr?: boolean
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
}

export class DesktopError extends Error {
  readonly code: string
  readonly details?: string
  /** The helper command that failed, set once the error leaves runNow. */
  command?: string

  constructor(code: string, message: string, details?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DesktopError"
    this.code = code
    this.details = details
  }
}

export class DesktopClient {
  readonly executable: string

  private readonly helper: HelperProcess
  private readonly timeoutMs: number
  private readonly shutdownController = new AbortController()
  private readonly snapshots = new Map<string, DesktopSnapshotTarget>()

  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(options: DesktopClientOptions = {}) {
    this.executable = options.executable ?? defaultExecutable()
    this.helper = new HelperProcess(
      this.executable,
      options.baseArgs ?? [],
      options.env ?? sessionEnvironment()
    )
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /** `timeoutMs` replaces the default for a command that waits on the user. */
  run(args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<DesktopResult> {
    return this.enqueue((requestSignal) => this.runNow(args, requestSignal, timeoutMs), signal)
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

  resolveSnapshotCoordinates(
    snapshotId: string,
    imageX: number,
    imageY: number
  ): DesktopResolvedCoordinates {
    const target = this.requireSnapshotTarget(snapshotId)
    const exactWindow = exactWindowTarget(target)
    const { x, y } = this.toDesktopPixels(snapshotId, imageX, imageY)
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

  /** Convert a point on the screenshot the model saw into the desktop pixels the helper expects. */
  toDesktopPixels(snapshotId: string, x: number, y: number): { x: number; y: number } {
    const scale = this.snapshots.get(snapshotId)?.imageScale ?? 1
    return { x: Math.round(x / scale), y: Math.round(y / scale) }
  }

  /** Convert a desktop point into the pixels of a snapshot's screenshot, when its bounds are known. */
  toImagePixels(snapshotId: string, x: number, y: number): { x: number; y: number } | undefined {
    const target = this.snapshots.get(snapshotId)
    if (!target?.bounds) return undefined
    const scale = target.imageScale ?? 1
    return {
      x: Math.round((x - target.bounds.x) * scale),
      y: Math.round((y - target.bounds.y) * scale),
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
    this.helper.stop()
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
        const { imageData, mimeType, scale } = await this.encodeImage(imagePath, directory, signal)
        if (snapshotId && target)
          this.rememberSnapshot(snapshotId, { ...target, imageScale: scale })
        return {
          ...result,
          imageData,
          mimeType,
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

  /** Read a target's elements without a screenshot, as a snapshot that later actions can use. */
  readElements(target: DesktopObservationTarget, signal?: AbortSignal): Promise<DesktopResult> {
    return this.enqueue(async (requestSignal) => {
      const result = await this.runNow(
        [
          "see",
          ...observationRequestArgs({ target, annotate: false }),
          "--tree",
          "--no-screenshot",
          "--depth",
          "40",
          "--max-elements",
          "300",
          "--max-children",
          "200",
        ],
        requestSignal
      )
      const data = asRecord(result.data)
      const snapshotId = stringValue(data?.snapshot_id)
      const resolved = await this.resolveObservationTarget(target, data, requestSignal)
      if (snapshotId && resolved) this.rememberSnapshot(snapshotId, resolved)
      return result
    }, signal)
  }

  /** Re-capture a snapshot's target and return one region of it at full resolution, for reading. */
  zoom(
    snapshotId: string,
    region: DesktopImageRegion,
    signal?: AbortSignal
  ): Promise<{ imageData: string; mimeType: DesktopImageType }> {
    return this.enqueue(async (requestSignal) => {
      const target = this.requireSnapshotTarget(snapshotId)
      const scale = target.imageScale ?? 1
      const directory = await mkdtemp(join(tmpdir(), "computer-claude-"))
      const capturePath = join(directory, "capture.png")
      try {
        await this.runNow(
          ["see", ...snapshotObservationTargetArgs(target), "--no-elements", "--path", capturePath],
          requestSignal
        )
        const crop = [region.x, region.y, region.width, region.height]
          .map((value) => Math.round(value / scale))
          .join(",")
        const { imageData, mimeType } = await this.encodeImage(
          capturePath,
          directory,
          requestSignal,
          crop
        )
        return { imageData, mimeType }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, signal)
  }

  /** Wait until a view's picture changes, or until it stops changing. */
  async watch(
    view: DesktopView,
    until: "change" | "still",
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ met: boolean; elapsedMs: number }> {
    const result = await this.run(
      ["watch", ...this.viewArgs(view), "--until", until, "--timeout", String(timeoutMs)],
      signal,
      timeoutMs + this.timeoutMs
    )
    const data = asRecord(result.data)
    return { met: data?.met === true, elapsedMs: numberValue(data?.elapsed_ms) ?? 0 }
  }

  /** Capture a view several times in a row, as small images that show motion. */
  frames(
    view: DesktopView,
    count: number,
    intervalMs: number,
    signal?: AbortSignal
  ): Promise<DesktopFrame[]> {
    return this.enqueue(async (requestSignal) => {
      const directory = await mkdtemp(join(tmpdir(), "computer-claude-"))
      try {
        const result = await this.runNow(
          [
            "frames",
            ...this.viewArgs(view),
            "--count",
            String(count),
            "--interval",
            String(intervalMs),
            "--path",
            directory,
            "--max-bytes",
            String(Math.floor(MAX_IMAGE_BYTES / count)),
          ],
          requestSignal,
          count * intervalMs + this.timeoutMs
        )
        const frames = asRecord(result.data)?.frames
        return await Promise.all(
          (Array.isArray(frames) ? frames : []).map(async (item) => {
            const frame = asRecord(item)
            return {
              imageData: (await readFile(stringValue(frame?.path) ?? "")).toString("base64"),
              mimeType: imageType(frame?.mime),
              atMs: numberValue(frame?.at_ms) ?? 0,
            }
          })
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, signal)
  }

  private viewArgs(view: DesktopView): string[] {
    const args = observationRequestArgs({ target: view.target, annotate: false })
    if (view.region) {
      if (!view.snapshotId) {
        throw new DesktopError(
          "SNAPSHOT_REQUIRED",
          "A region needs the snapshot_id it was read from."
        )
      }
      // The region is in the pixels of the screenshot the model saw; the helper crops desktop pixels.
      const scale = this.requireSnapshotTarget(view.snapshotId).imageScale ?? 1
      const { x, y, width, height } = view.region
      args.push(
        "--region",
        [x, y, width, height].map((value) => Math.round(value / scale)).join(",")
      )
    }
    return args
  }

  private async encodeImage(
    imagePath: string,
    directory: string,
    signal: AbortSignal,
    crop?: string
  ): Promise<{ imageData: string; mimeType: DesktopImageType; scale: number }> {
    const encoded = await this.runNow(
      [
        "encode",
        imagePath,
        join(directory, "encoded"),
        String(MAX_IMAGE_BYTES),
        String(MAX_IMAGE_EDGE),
        ...(crop ? [crop] : []),
      ],
      signal
    )
    const data = asRecord(encoded.data)
    return {
      imageData: (await readFile(stringValue(data?.path) ?? "")).toString("base64"),
      mimeType: imageType(data?.mime),
      scale: numberValue(data?.scale) ?? 1,
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

  private async runNow(
    args: string[],
    signal: AbortSignal,
    timeoutMs = this.timeoutMs
  ): Promise<DesktopResult> {
    const started = performance.now()
    let ok = false
    try {
      const result = await this.execute(args, signal, timeoutMs)
      ok = true
      return result
    } catch (error) {
      if (error instanceof DesktopError) error.command ??= args[0]
      throw error
    } finally {
      recordTiming({ kind: "helper", name: args[0] ?? "", ms: performance.now() - started, ok })
    }
  }

  private async execute(
    args: string[],
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<DesktopResult> {
    let stdout: string
    try {
      stdout = await this.helper.request(args, signal, timeoutMs)
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw desktopErrorWithCause(
          "HELPER_NOT_FOUND",
          `The desktop helper ${JSON.stringify(this.executable)} was not found.`,
          undefined,
          error
        )
      }
      throw desktopErrorWithCause(
        "HELPER_PROCESS_FAILED",
        `The desktop helper command failed: ${unknownErrorMessage(error)}`,
        processOutput(error, "stderr").trim() || undefined,
        error
      )
    }

    const envelope = parseEnvelope(stdout)
    // What the helper worked around does not fail the call, so this is the only record of it.
    for (const item of Array.isArray(envelope.warnings) ? envelope.warnings : []) {
      const warning = asRecord(item)
      recordError({
        source: "helper",
        code: stringValue(warning?.code) ?? "HELPER_WARNING",
        message: stringValue(warning?.message) ?? "",
        command: args[0],
      })
    }
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

function parseEnvelope(stdout: string): DesktopEnvelope {
  const envelope = tryParseEnvelope(stdout)
  if (envelope) return envelope

  throw new DesktopError(
    "HELPER_INVALID_JSON",
    "The desktop helper did not return its expected JSON response.",
    stdout.trim().slice(-4096) || undefined
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
      ...("warnings" in parsed ? { warnings: parsed.warnings } : {}),
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

function envelopeError(envelope: DesktopEnvelope): DesktopError {
  const code =
    typeof envelope.error?.code === "string" ? envelope.error.code : "HELPER_COMMAND_FAILED"
  const message =
    typeof envelope.error?.message === "string"
      ? envelope.error.message
      : "The desktop helper reported a command failure."
  const details = typeof envelope.error?.details === "string" ? envelope.error.details : undefined
  return new DesktopError(code, message, details)
}

function processOutput(error: unknown, field: "stderr"): string {
  const value = asRecord(error)?.[field]
  return typeof value === "string" ? value : ""
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
  if (request.noOcr) args.push("--no-ocr")
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

function imageType(value: unknown): DesktopImageType {
  return value === "image/jpeg" ? "image/jpeg" : "image/png"
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

/** The helper ships next to the bundled server (`dist/`) and next to the sources (`src/`). */
function defaultExecutable(): string {
  return fileURLToPath(new URL("../desktop/computer-claude-desktop", import.meta.url))
}

/** Claude Code may start the server without the desktop session's variables; the session bus has a fixed address. */
function sessionEnvironment(): NodeJS.ProcessEnv {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtimeDir}/bus`,
  }
}
