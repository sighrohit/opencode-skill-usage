// See ./index.ts for why this shim exists. `src/tui.tsx` holds the panel JSX; keeping
// the entry point outside node_modules is what puts it in reach of OpenCode's Solid
// transform, so its `RendererContext` is the host's rather than a second copy's.
export { default } from "../../../src/tui.tsx"
