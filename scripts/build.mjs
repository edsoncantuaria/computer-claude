// Bundles the MCP server into dist/server.mjs, which is committed so the plugin runs without `npm install`.
import { readFileSync } from "node:fs"
import { build } from "esbuild"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  define: { __VERSION__: JSON.stringify(version) },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"\nconst require = __createRequire(import.meta.url)',
  },
})
