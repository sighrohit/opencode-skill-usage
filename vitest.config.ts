import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// solid-js's `node` export condition resolves to `dist/server.js`, the SSR
// build, where `createSignal` ignores writes and `createEffect` never re-runs.
// Vitest resolves for node, so without this every reactivity test in the suite
// silently passes against inert primitives. Point bare `solid-js` at the
// development build so tracking actually happens.
const solidDev = fileURLToPath(new URL("./node_modules/solid-js/dist/dev.js", import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^solid-js$/, replacement: solidDev }],
  },
})