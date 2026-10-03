// Local-discovery shim. OpenCode loads plugin packages from `.opencode/plugins/`,
// and OpenTUI's Solid transform skips every path containing `node_modules`. A plugin
// installed from npm lives at `<cache>/node_modules/<pkg>/src/tui.tsx`, so its JSX is
// never host-transformed: bun falls back to native JSX, the `@jsxImportSource` pragma
// resolves `@opentui/solid` against the plugin's own node_modules, and the plugin ends
// up with a *different* `RendererContext` object than the host provides. Element
// creation then throws "No renderer found".
//
// Re-exporting from outside node_modules puts the real module back in reach of the
// host transform, so its JSX compiles against the host's renderer. A symlink to the
// repo root would achieve the same thing but creates a self-referential path that
// breaks recursive globbing, so these shims point at the source instead.
//
// These files are deliberately outside `tsconfig.json`'s `include` (which is `["src"]`).
export { default } from "../../../src/index.ts"
