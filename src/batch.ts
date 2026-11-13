import type { CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { ToolRegistrar } from "./registrar.js"
import { desktopToolError, timed, toolFailure } from "./tool-shared.js"

export interface ToolContext {
  mcpReq: { signal: AbortSignal }
}

/** Every registered tool's input schema and handler, by name. */
export type BatchTools = Map<
  string,
  { schema: z.ZodType; handler: (input: never, ctx: ToolContext) => Promise<CallToolResult> }
>

/** Calls that stay on their own: the batch itself, and the request only the user can answer. */
const NOT_BATCHABLE = new Set(["computer_batch", "computer_access"])
const MAX_ACTIONS = 20

/** Registers computer_batch, which runs the tools registered before it in one round trip. */
export function registerBatchTool(registerTool: ToolRegistrar, tools: BatchTools): void {
  const names = [...tools.keys()].filter((name) => !NOT_BATCHABLE.has(name))

  registerTool(
    "computer_batch",
    {
      description:
        "Run several computer_* calls in order in one round trip, stopping at the first that fails. Each item is {tool, input}, with the input that tool takes on its own. Use it when you can predict the next steps, such as click, type, press, then observe. A step cannot use a snapshot_id that an earlier step of the same batch returns.",
      inputSchema: z.object({
        actions: z
          .array(
            z.object({
              tool: z.enum(names),
              input: z.record(z.string(), z.unknown()).default({}),
            })
          )
          .min(1)
          .max(MAX_ACTIONS),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    timed("computer_batch", async ({ actions }: { actions: BatchAction[] }, ctx: ToolContext) => {
      const content: CallToolResult["content"] = []
      for (const [index, action] of actions.entries()) {
        const result = await runStep(tools, action, ctx)
        const [first, ...rest] = result.content
        const step = `[${index + 1}/${actions.length}] ${action.tool}`
        if (first?.type === "text")
          content.push({ ...first, text: `${step}: ${first.text}` }, ...rest)
        else content.push({ type: "text", text: `${step}:` }, ...result.content)
        if (result.isError) {
          const left = actions.length - index - 1
          if (left > 0)
            content.push({ type: "text", text: `Stopped here; ${left} later step(s) did not run.` })
          return { content, isError: true }
        }
      }
      return { content }
    })
  )
}

interface BatchAction {
  tool: string
  input: Record<string, unknown>
}

async function runStep(
  tools: BatchTools,
  action: BatchAction,
  ctx: ToolContext
): Promise<CallToolResult> {
  const tool = tools.get(action.tool)
  const parsed = tool?.schema.safeParse(action.input)
  if (!(tool && parsed?.success)) {
    const reason = parsed?.error ? z.prettifyError(parsed.error) : "Unknown tool."
    return toolFailure("INVALID_ARGUMENTS", reason, action.tool)
  }
  try {
    // biome-ignore lint/nursery/noUnsafeTypeAssertion: The tool's own schema has just validated this input.
    return await tool.handler(parsed.data as never, ctx)
  } catch (error) {
    return desktopToolError(error)
  }
}
