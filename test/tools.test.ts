/** The MCP tool layer against a fake helper: what each tool asks the helper to do. */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { after, beforeEach, test } from "node:test"
import type { CallToolResult } from "@modelcontextprotocol/server"
import type { z } from "zod"
import { registerComputerUseTools } from "../src/computer-tools.js"
import { DesktopClient } from "../src/desktop-client.js"
import type { ToolRegistrar } from "../src/registrar.js"

type Handler = (input: unknown, ctx: { mcpReq: { signal: AbortSignal } }) => Promise<CallToolResult>

const directory = mkdtempSync(join(tmpdir(), "computer-claude-test-"))
const log = join(directory, "calls.jsonl")
const starts = join(directory, "starts")
process.env.FAKE_HELPER_LOG = log
process.env.FAKE_HELPER_STARTS = starts

const tools = new Map<string, { schema: z.ZodType; handler: Handler }>()
const desktop = new DesktopClient({ executable: join(process.cwd(), "test/fake-helper.mjs") })
registerComputerUseTools(
  ((name: string, config: { inputSchema: z.ZodType }, handler: Handler) => {
    tools.set(name, { schema: config.inputSchema, handler })
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: A recording stand-in for the MCP server's registrar.
  }) as unknown as ToolRegistrar,
  desktop
)

/** Calls a tool the way the MCP server does: validate the input, then run the handler. */
function call(name: string, input: unknown): Promise<CallToolResult> {
  const tool = tools.get(name)
  assert.ok(tool, `${name} is registered`)
  return tool.handler(tool.schema.parse(input), {
    mcpReq: { signal: new AbortController().signal },
  })
}

/** The helper commands run since the last test. */
function calls(): string[][] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line): string[] => JSON.parse(line))
}

/** How many helper processes have been started so far. */
function helperStarts(): number {
  return readFileSync(starts, "utf8").split("\n").filter(Boolean).length
}

function text(result: CallToolResult): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n")
}

beforeEach(() => writeFileSync(log, ""))
after(() => desktop.close())

test("a coordinate click is scaled to desktop pixels and aimed at a fresh look at the window", async () => {
  await call("computer_observe", { window_id: 7 })
  writeFileSync(log, "")
  await call("computer_click", { snapshot_id: "S1", x: 100, y: 50 })
  const [look, click] = calls()
  assert.deepEqual(look?.slice(0, 4), ["see", "--app", "Calc", "--window-id"])
  assert.deepEqual(click, ["click", "--at", "200,100", "--window-id", "7", "--snapshot", "S1"])
})

test("a click passes its modifiers, and an element click names the element", async () => {
  await call("computer_click", {
    snapshot_id: "S1",
    element_id: "E1",
    modifiers: ["shift", "ctrl"],
  })
  assert.deepEqual(calls(), [
    ["click", "--on", "E1", "--snapshot", "S1", "--modifiers", "shift+ctrl"],
  ])
})

test("hover moves the pointer without any button", async () => {
  await call("computer_hover", { snapshot_id: "S1", query: "Save" })
  assert.deepEqual(calls(), [["click", "Save", "--snapshot", "S1", "--hover"]])
})

test("a pointer target needs exactly one of element, text or coordinates", () => {
  const schema = tools.get("computer_hover")?.schema
  assert.equal(schema?.safeParse({ snapshot_id: "S1" }).success, false)
  assert.equal(schema?.safeParse({ snapshot_id: "S1", x: 1 }).success, false)
  assert.equal(
    schema?.safeParse({ snapshot_id: "S1", query: "a", element_id: "E1" }).success,
    false
  )
})

test("a batch runs in order and stops at the first failure", async () => {
  const result = await call("computer_batch", {
    actions: [
      { tool: "computer_press", input: { keys: ["tab"], window_id: 7 } },
      { tool: "computer_click", input: { snapshot_id: "S1", query: "missing" } },
      { tool: "computer_press", input: { keys: ["return"], window_id: 7 } },
    ],
  })
  assert.equal(result.isError, true)
  assert.deepEqual(
    calls().map((args) => args[0]),
    ["press", "click"]
  )
  assert.ok(text(result).includes("[1/3] computer_press: press ok"))
  assert.ok(text(result).includes("[2/3] computer_click: ELEMENT_NOT_FOUND"))
  assert.ok(text(result).includes("1 later step(s) did not run"))
})

test("a batch checks each step against that tool's own schema before running it", async () => {
  const result = await call("computer_batch", {
    actions: [{ tool: "computer_click", input: { snapshot_id: "S1" } }],
  })
  assert.equal(result.isError, true)
  assert.ok(text(result).includes("INVALID_ARGUMENTS"))
  assert.deepEqual(calls(), [])
})

test("a batch cannot ask for access or nest another batch", () => {
  const schema = tools.get("computer_batch")?.schema
  for (const tool of ["computer_access", "computer_batch"]) {
    assert.equal(schema?.safeParse({ actions: [{ tool, input: {} }] }).success, false)
  }
})

test("an access request names the apps and the reason", async () => {
  await call("computer_access", {
    action: "request",
    apps: ["Calculator", "shell"],
    reason: "To add the numbers.",
  })
  assert.deepEqual(calls(), [
    ["access", "request", "Calculator", "shell", "--reason", "To add the numbers."],
  ])
  const schema = tools.get("computer_access")?.schema
  assert.equal(schema?.safeParse({ action: "request" }).success, false)
  assert.equal(schema?.safeParse({ action: "request", apps: ["--force"] }).success, false)
})

test("the pointer position is also given in the pixels of a snapshot's screenshot", async () => {
  await call("computer_observe", { window_id: 7 })
  const result = await call("computer_list", { kind: "pointer", snapshot_id: "S1" })
  // Window at (100, 50) on the desktop, shown at half size.
  assert.ok(text(result).includes("desktop (300, 250)"))
  assert.ok(text(result).includes("is (100, 100)"))
})

test("one helper process serves every command, and a new one replaces it when it dies", async () => {
  await call("computer_press", { keys: ["tab"], window_id: 7 })
  const before = helperStarts()
  await call("computer_press", { keys: ["tab"], window_id: 7 })
  assert.equal(helperStarts(), before)

  const died = await call("computer_window", { action: "close", window_id: 7 })
  assert.equal(died.isError, true)
  assert.ok(text(died).includes("HELPER_PROCESS_FAILED"))
  const next = await call("computer_press", { keys: ["tab"], window_id: 7 })
  assert.equal(next.isError, undefined)
  assert.equal(helperStarts(), before + 1)
})

test("a cancelled or overdue command ends the stuck helper, and the next one starts afresh", async () => {
  const before = helperStarts()
  const cancelled = desktop.run(["hang"], AbortSignal.timeout(50))
  await assert.rejects(cancelled, { code: "HELPER_PROCESS_FAILED" })
  await assert.rejects(desktop.run(["hang"], undefined, 50), { code: "HELPER_PROCESS_FAILED" })
  const next = await desktop.run(["pointer"])
  assert.equal(next.summary, "The pointer is at desktop (300, 250).")
  assert.equal(helperStarts(), before + 2)
})

test("a visual wait watches a region in desktop pixels, then observes the target again", async () => {
  await call("computer_observe", { window_id: 7 })
  writeFileSync(log, "")
  const result = await call("computer_wait", {
    visual: "change",
    snapshot_id: "S1",
    region: { x: 10, y: 20, width: 100, height: 50 },
    timeout_ms: 5000,
  })
  const [watch, look] = calls()
  assert.deepEqual(watch, [
    "watch",
    "--app",
    "Calc",
    "--window-id",
    "7",
    "--region",
    "20,40,200,100",
    "--until",
    "change",
    "--timeout",
    "5000",
  ])
  // The look that follows an action or a wait skips reading the window's text.
  assert.equal(look?.[0], "see")
  assert.ok(look?.includes("--no-ocr"))
  assert.ok(text(result).includes("changed after 320 ms"))
  assert.ok(result.content.some((item) => item.type === "image"))
})

test("a visual wait that is not met is a timeout", async () => {
  const result = await call("computer_wait", { visual: "still", window_id: 7 })
  assert.equal(result.isError, true)
  assert.ok(text(result).includes("WAIT_TIMEOUT: The picture kept changing"))
})

test("a wait takes text or visual, never both, and a region needs its snapshot", () => {
  const schema = tools.get("computer_wait")?.schema
  assert.equal(schema?.safeParse({}).success, false)
  assert.equal(schema?.safeParse({ text: "a", visual: "change" }).success, false)
  assert.equal(
    schema?.safeParse({ visual: "change", region: { x: 0, y: 0, width: 1, height: 1 } }).success,
    false
  )
  assert.equal(schema?.safeParse({ text: "a" }).success, true)
})

test("an observation reads the window's text, and carries the image type the helper chose", async () => {
  const result = await call("computer_observe", { window_id: 7 })
  assert.equal(calls()[0]?.includes("--no-ocr"), false)
  const image = result.content.find((item) => item.type === "image")
  assert.equal(image?.type === "image" ? image.mimeType : undefined, "image/jpeg")
})

test("failures the tool layer finds itself reach the error log, without the tool's arguments", async () => {
  const state = mkdtempSync(join(tmpdir(), "computer-claude-state-"))
  const silenced = process.env.COMPUTER_CLAUDE_NO_ERROR_LOG
  delete process.env.COMPUTER_CLAUDE_NO_ERROR_LOG
  process.env.XDG_STATE_HOME = state
  try {
    await call("computer_wait", { visual: "still", window_id: 7 })
    await call("computer_wait", { text: "a secret label", window_id: 7, timeout_ms: 100 })
    await call("computer_batch", { actions: [{ tool: "computer_click", input: {} }] })
    await call("computer_click", { snapshot_id: "S1", query: "missing" })
  } finally {
    process.env.COMPUTER_CLAUDE_NO_ERROR_LOG = silenced
    delete process.env.XDG_STATE_HOME
  }
  const written = readFileSync(join(state, "computer-claude", "errors.jsonl"), "utf8")
  const entries: { code: string; command: string }[] = written
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    entries.map((entry) => [entry.code, entry.command]),
    [
      ["WAIT_TIMEOUT", "watch"],
      ["WAIT_TIMEOUT", "see"],
      ["INVALID_ARGUMENTS", "computer_click"],
      ["ELEMENT_NOT_FOUND", "click"],
    ]
  )
  assert.equal(written.includes("secret"), false)

  // Every tool call and helper command also leaves how long it took, and nothing about its arguments.
  const timings: { kind: string; name: string; ms: number; ok: boolean }[] = readFileSync(
    join(state, "computer-claude", "timings.jsonl"),
    "utf8"
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    timings.filter((entry) => entry.kind === "tool").map((entry) => [entry.name, entry.ok]),
    [
      ["computer_wait", false],
      ["computer_wait", false],
      // The batch's only step was refused before it ran, so it has no timing of its own.
      ["computer_batch", false],
      ["computer_click", false],
    ]
  )
  assert.ok(timings.some((entry) => entry.kind === "helper" && entry.name === "watch" && entry.ok))
  assert.ok(timings.every((entry) => Number.isInteger(entry.ms) && entry.ms >= 0))
  assert.deepEqual(Object.keys(timings[0] ?? {}), ["time", "version", "kind", "name", "ms", "ok"])
})

test("frames come back as one image each, with the byte budget split between them", async () => {
  const result = await call("computer_frames", { window_id: 7, count: 3, interval_ms: 200 })
  const [frames] = calls()
  assert.deepEqual(frames?.slice(0, 7), [
    "frames",
    "--window-id",
    "7",
    "--count",
    "3",
    "--interval",
    "200",
  ])
  assert.equal(frames?.at(-1), String(Math.floor(2_900_000 / 3)))
  assert.equal(result.content.filter((item) => item.type === "image").length, 3)
  assert.ok(text(result).includes("3 frames, taken at 0, 500, 1000 ms."))
})
