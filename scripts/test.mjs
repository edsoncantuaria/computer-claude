// Runs the tests: the MCP tool layer (bundled the way the server is) and the Python helper's own logic.
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { build } from "esbuild"

const directory = mkdtempSync(join(tmpdir(), "computer-claude-test-"))
const bundle = join(directory, "tools.test.mjs")
let failed = false
try {
  await build({
    entryPoints: ["test/tools.test.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    define: { __VERSION__: '"test"' },
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"\nconst require = __createRequire(import.meta.url)',
    },
  })
  // Failures the tests provoke on purpose must not land in the user's error log.
  const env = { ...process.env, COMPUTER_CLAUDE_NO_ERROR_LOG: "1" }
  for (const [command, args] of [
    [process.execPath, ["--test", bundle]],
    ["python3", ["-B", "-m", "unittest", "discover", "-s", "test", "-p", "test_*.py"]],
  ]) {
    if (spawnSync(command, args, { stdio: "inherit", env }).status !== 0) failed = true
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
