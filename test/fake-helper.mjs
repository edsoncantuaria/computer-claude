#!/usr/bin/env node
// Stands in for desktop/computer-claude-desktop: records its arguments and answers with canned envelopes.
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { createInterface } from "node:readline"

function answer(args) {
  appendFileSync(process.env.FAKE_HELPER_LOG, `${JSON.stringify(args)}\n`)
  const [command] = args
  const envelope = { success: true, data: {}, summary: `${command} ok` }
  if (command === "see") {
    const path = args.includes("--path") ? args[args.indexOf("--path") + 1] : undefined
    if (path) writeFileSync(path, "png")
    envelope.data = {
      snapshot_id: "S1",
      application_name: "Calc",
      window_title: "Calc",
      capture_mode: "window",
      text: '[E1] button "Save"',
      observation: {
        target: {
          resolved_kind: "window-id",
          window_id: 7,
          bounds: { x: 100, y: 50, width: 800, height: 600 },
        },
      },
      ...(path ? { screenshot_raw: path } : {}),
    }
  } else if (command === "encode") {
    // The screenshot the model sees is half the size of the desktop.
    envelope.data = { path: `${args[2]}.jpg`, mime: "image/jpeg", scale: 0.5 }
    writeFileSync(envelope.data.path, "jpeg")
  } else if (command === "pointer") {
    envelope.data = { x: 300, y: 250 }
    envelope.summary = "The pointer is at desktop (300, 250)."
  } else if (command === "click" && args.includes("missing")) {
    return { success: false, error: { code: "ELEMENT_NOT_FOUND", message: "No element." } }
  } else if (command === "watch") {
    // The picture changes, and never settles.
    envelope.data = { met: !args.includes("still"), elapsed_ms: 320 }
  } else if (command === "frames") {
    const directory = args[args.indexOf("--path") + 1]
    const count = Number(args[args.indexOf("--count") + 1])
    envelope.data = {
      frames: Array.from({ length: count }, (_, index) => {
        const path = join(directory, `frame-${index}.png`)
        writeFileSync(path, "png")
        return { path, mime: "image/png", at_ms: index * 500 }
      }),
    }
  } else if (command === "window" && args.includes("close")) {
    // A helper that dies in the middle of a command.
    process.exit(3)
  }
  return envelope
}

// Like the real helper's serve mode: one JSON array of arguments per line in, one envelope per line out.
if (process.argv[2] !== "serve") process.exit(2)
appendFileSync(process.env.FAKE_HELPER_STARTS, "started\n")
for await (const line of createInterface({ input: process.stdin })) {
  const args = JSON.parse(line)
  // A helper stuck in a command never answers.
  if (args[0] !== "hang") process.stdout.write(`${JSON.stringify(answer(args))}\n`)
}
