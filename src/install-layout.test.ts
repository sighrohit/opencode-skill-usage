import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Guards the install layout, not the code. OpenTUI's Solid transform skips every path
 * containing `node_modules`:
 *
 *   /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/
 *
 * A plugin installed from npm lands at `<cache>/node_modules/<pkg>/src/tui.tsx`, so its
 * JSX is never host-transformed. Bun then handles the JSX natively via the
 * `@jsxImportSource` pragma, which resolves `@opentui/solid` from the plugin's own
 * node_modules. The plugin then holds a different `RendererContext` object than the one
 * the host provides, `useContext` returns undefined, and element creation throws
 * "No renderer found". Every unit test passes while this is true — the failure only
 * exists in the host's module graph — so it needs a structural guard.
 *
 * The fix is to keep the entry point outside `node_modules` via `.opencode/plugins/`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const shimDir = resolve(repoRoot, ".opencode/plugins/skill-usage")

/** Resolves a relative re-export specifier the way a bundler would. */
function resolveFromShim(specifier: string): string {
  return resolve(shimDir, specifier)
}

describe("local plugin discovery layout", () => {
  it("exposes a ./tui entry point for OpenCode to load", () => {
    const manifest = resolve(shimDir, "package.json")
    expect(existsSync(manifest)).toBe(true)

    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      exports?: Record<string, string>
    }
    expect(pkg.exports?.["./tui"]).toBe("./tui.tsx")
    expect(pkg.exports?.["."]).toBe("./index.ts")
  })

  it("routes ./tui and the default export at the real sources", () => {
    for (const shim of ["tui.tsx", "index.ts"]) {
      const contents = readFileSync(resolve(shimDir, shim), "utf8")
      const specifier = /from "(\.\.[^"]+)"/.exec(contents)?.[1]
      expect(specifier, `${shim} should re-export the real source`).toBeDefined()

      const target = resolveFromShim(specifier!)
      expect(existsSync(target), `${shim} -> ${target} should exist`).toBe(true)
    }
  })

  it("keeps every host-loaded module out of node_modules", () => {
    // This is the whole invariant. If a shim ever resolves inside node_modules the
    // host transform skips it again and the panel fails with "No renderer found".
    const paths = [
      resolve(shimDir, "tui.tsx"),
      resolve(shimDir, "index.ts"),
      resolveFromShim("../../../src/tui.tsx"),
      resolveFromShim("../../../src/index.ts"),
    ]

    for (const path of paths) {
      expect(path.split(/[/\\]/)).not.toContain("node_modules")
    }
  })
})
