/** The desktop helper as one long-lived process: starting Python for every command costs more than most commands do. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { createInterface } from "node:readline"

interface Pending {
  resolve: (line: string) => void
  reject: (error: Error) => void
}

export class HelperProcess {
  private readonly executable: string
  private readonly args: string[]
  private readonly env: NodeJS.ProcessEnv

  private child?: ChildProcessWithoutNullStreams
  private pending?: Pending
  private stderr = ""

  constructor(executable: string, baseArgs: string[], env: NodeJS.ProcessEnv) {
    this.executable = executable
    this.args = [...baseArgs, "serve"]
    this.env = env
  }

  /**
   * Run one command and return the helper's answer, a line of JSON. One request at a time.
   * A failure carries `stderr`, and `code` when the helper could not be started.
   */
  request(args: string[], signal: AbortSignal, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const settle = (finish: () => void) => {
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        this.pending = undefined
        finish()
      }
      // The helper runs one command at a time and cannot be interrupted, so giving up on one ends the process.
      const abandon = (error: Error) => {
        this.stop()
        settle(() => reject(error))
      }
      const onAbort = () =>
        abandon(
          signal.reason instanceof Error ? signal.reason : new Error("The command was cancelled.")
        )
      const timer = setTimeout(
        () => abandon(new Error(`The helper did not answer within ${timeoutMs} ms.`)),
        timeoutMs
      )
      signal.addEventListener("abort", onAbort, { once: true })
      this.pending = {
        resolve: (line) => settle(() => resolve(line)),
        reject: (error) => settle(() => reject(error)),
      }
      this.start().stdin.write(`${JSON.stringify(args)}\n`)
    })
  }

  stop(): void {
    const child = this.child
    this.child = undefined
    child?.kill()
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    const child = spawn(this.executable, this.args, { env: this.env })
    this.child = child
    this.stderr = ""
    const lost = (error: Error) => {
      // A helper that was stopped on purpose has nobody waiting on it any more.
      if (this.child !== child) return
      this.child = undefined
      this.pending?.reject(Object.assign(error, { stderr: this.stderr }))
    }
    child.on("error", lost)
    child.on("exit", (code, exitSignal) =>
      lost(new Error(`The helper exited (${exitSignal ?? `code ${code}`}).`))
    )
    // A write to a helper that just died fails here; its exit is what gets reported.
    child.stdin.on("error", () => undefined)
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4096)
    })
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.child === child) this.pending?.resolve(line)
    })
    return child
  }
}
