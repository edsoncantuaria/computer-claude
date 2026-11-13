/**
 * Local error log: one JSON line per failure, kept on this machine so a bug can be diagnosed later.
 * Nothing is sent anywhere. Typed text, screenshots, and tool arguments are never recorded; the
 * message and details come from the failure itself and can name a window or app.
 * Set COMPUTER_CLAUDE_NO_ERROR_LOG=1 to turn it off.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import process from "node:process"

declare const __VERSION__: string

const MAX_LOG_BYTES = 1_000_000
const MAX_FIELD_CHARS = 1000

export interface ErrorEntry {
  /** Where it happened: "tool" for a failed tool call, "process" for a crash of the server. */
  source: "tool" | "process"
  code: string
  message: string
  command?: string | undefined
  details?: string | undefined
}

export function errorLogPath(): string {
  const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(state, "computer-claude", "errors.jsonl")
}

const clip = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : value.slice(0, MAX_FIELD_CHARS)

/** Appends one entry. It never throws: a broken log must not break the tool that failed. */
export function recordError(entry: ErrorEntry): void {
  if (process.env.COMPUTER_CLAUDE_NO_ERROR_LOG) return
  try {
    const path = errorLogPath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
      if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // No log yet.
    }
    const line = JSON.stringify({
      time: new Date().toISOString(),
      version: __VERSION__,
      source: entry.source,
      code: entry.code,
      command: entry.command,
      message: clip(entry.message),
      details: clip(entry.details),
    })
    appendFileSync(path, `${line}\n`, { mode: 0o600 })
  } catch {
    // Ignored on purpose.
  }
}
