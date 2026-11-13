/**
 * Local logs, kept on this machine so a bug or a slow step can be diagnosed later: one JSON line per
 * failure in errors.jsonl, and one per tool call and helper command, with how long it took, in
 * timings.jsonl. Nothing is sent anywhere. Typed text, screenshots, and tool arguments are never
 * recorded; an error's message and details come from the failure itself and can name a window or app.
 * Set COMPUTER_CLAUDE_NO_ERROR_LOG=1 to turn both off.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"

declare const __VERSION__: string

const MAX_LOG_BYTES = 1_000_000
const MAX_FIELD_CHARS = 1000

export interface ErrorEntry {
  /**
   * Where it happened: "tool" for a failed tool call, "helper" for a problem the helper worked
   * around without failing the call, "process" for a crash of the server.
   */
  source: "tool" | "helper" | "process"
  code: string
  message: string
  command?: string | undefined
  details?: string | undefined
}

export interface TimingEntry {
  /** "tool" for a whole tool call, "helper" for one helper command inside it. */
  kind: "tool" | "helper"
  name: string
  ms: number
  ok: boolean
}

function logPath(file: string): string {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "computer-claude", file)
}

export function errorLogPath(): string {
  return logPath("errors.jsonl")
}

/** Appends one line. It never throws: a broken log must not break the tool that wrote it. */
function append(file: string, record: Record<string, unknown>): void {
  if (process.env.COMPUTER_CLAUDE_NO_ERROR_LOG) return
  try {
    const path = logPath(file)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // No log yet.
    }
    const line = JSON.stringify({ time: new Date().toISOString(), version: __VERSION__, ...record })
    appendFileSync(path, `${line}\n`, { mode: 0o600 })
  } catch {
    // Ignored on purpose.
  }
}

export function recordTiming(entry: TimingEntry): void {
  append("timings.jsonl", { ...entry, ms: Math.round(entry.ms) })
}

const clip = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : value.slice(0, MAX_FIELD_CHARS)

export function recordError(entry: ErrorEntry): void {
  append("errors.jsonl", {
    source: entry.source,
    code: entry.code,
    command: entry.command,
    message: clip(entry.message),
    details: clip(entry.details),
  })
}
