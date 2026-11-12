/** Computer Use for Claude Code: a stdio MCP server that drives the user's GNOME desktop. */
import process from "node:process"
import { McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { registerComputerUseTools } from "./computer-tools.js"
import { DesktopClient } from "./desktop-client.js"

declare const __VERSION__: string

const INSTRUCTIONS = `# Computer Claude

Observes and controls the user's real GNOME desktop, which the user shares with you.

- Start with computer_observe (or computer_list) and act on element ids or screenshot coordinates from the latest observation.
- Observe again after an action changes the screen; do not act on stale coordinates.
- Ask the user before sending messages, submitting forms, deleting data, purchases, or anything hard to undo.
- Never type passwords, tokens, or payment details; ask the user to do it.
- If a tool reports that the Computer Claude extension is not running, tell the user to run /computer-claude:setup.`

const desktop = new DesktopClient()
const server = new McpServer(
  { name: "computer-claude", version: __VERSION__ },
  { instructions: INSTRUCTIONS }
)
registerComputerUseTools(server.registerTool.bind(server), desktop)
await server.connect(new StdioServerTransport())

let closing = false
async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  await Promise.allSettled([server.close(), desktop.close()])
  process.exit(0)
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown())
process.stdin.once("end", () => void shutdown())
