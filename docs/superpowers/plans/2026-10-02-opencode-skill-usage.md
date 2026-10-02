# opencode-skill-usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish an OpenCode V2 plugin that tracks per-skill token usage (content tokens + session spend) and displays it as a descending chart — themed TUI panel plus markdown-table fallback.

**Architecture:** One npm package, three exports: server plugin (collection + storage + command + RPC impl), shared RPC contract, TUI plugin (themed panel). Collection is event-driven (`session.skill.activated`, `session.step.ended`); all logic lives in small pure modules (`tracker`, `store`, `chart`) that the plugin wiring consumes.

**Tech Stack:** TypeScript (published as source, ESM), vitest, `@opencode/plugin` ^2.0.22 (+ `/tui`), zod, solid-js / @opentui for the panel.

**Spec:** `docs/superpowers/specs/2026-10-02-opencode-skill-usage-design.md`

## Global Constraints

- OpenCode V2 only. Peer/dep versions: `@opencode/plugin` ^2.0.22, zod ^4 (match what @opencode/plugin resolves), devDeps: typescript, vitest, @types/node.
- ESM, `"type": "module"`, TypeScript source published uncompiled; no build step.
- Defaults (exact values): `topN` 15, `charsPerToken` 4, `defaultMetric` `"content"`. `charsPerToken` and `topN` are clamped to ≥ 1.
- Stats are **global across projects**. Storage key: `skill-usage:stats` via `ctx.storage`; file fallback path `~/.local/share/opencode/skill-usage.json` (decided by Task 5 verification).
- No telemetry, no network calls. All data stays local.
- Chart always sorted **descending** by the active metric.
- Content tokens are an estimate (`chars / charsPerToken`); spend attribution is approximate (even split). Both disclaimers go in the README.

## Review Focus

1. **`ctx.storage` may be per-location** → cross-project stats silently fragment. Task 5 Step 6 verifies scope across two project dirs and switches the store one-liner if needed.
2. **Sub-file skill reads may not emit `session.skill.activated`** → content undercount. Task 5 Step 7 verifies; fallback tool hook is specified there.
3. **`ctx.session.synthetic` may be invisible in the TUI or trigger the agent loop** → command looks broken. Task 5 Step 8 verifies; fallback prompt approach specified there.
4. **Malformed plugin options** (`charsPerToken: 0`, strings) → division by zero / NaN persisted into stats. Task 1 `parseOptions` clamps/validates; tests pin it.
5. **Concurrent events interleaving with async save** → lost updates. Tracker awaits each flush and `index.ts` consumes the event stream sequentially (`for await`); Task 3 has a two-events-both-counted test.

---

## Phase 1 — Server core

### Task 1: Package scaffold + shared types

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/types.ts`, `src/types.test.ts`

**Interfaces:**
- Produces (consumed by every later task):

```ts
export type Metric = "content" | "spend"
export interface SkillStats {
  loads: number
  contentTokens: number
  spend: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  lastUsed: string // ISO 8601
}
export interface UsageData { version: 1; skills: Record<string, SkillStats> }
export interface Options { topN: number; charsPerToken: number; defaultMetric: Metric }
export const DEFAULT_OPTIONS: Options // { topN: 15, charsPerToken: 4, defaultMetric: "content" }
export interface Row { skillID: string; loads: number; tokens: number; share: number }
export interface Totals { skills: number; loads: number; tokens: number }
export function emptySkillStats(): SkillStats
export function emptyData(): UsageData
export function parseOptions(raw: unknown): Options // unknown fields ignored; numbers clamped ≥1; bad defaultMetric → "content"
```

- [ ] **Step 1: Write `package.json` and `tsconfig.json`**

package.json: name `opencode-skill-usage`, version `0.1.0`, `"type": "module"`, exports `{ ".": "./src/index.ts", "./rpc": "./src/rpc.ts", "./tui": "./src/tui.tsx" }`, scripts `{ "test": "vitest run", "typecheck": "tsc --noEmit" }`, deps `@opencode/plugin` + `zod`, devDeps `typescript` `vitest` `@types/node`. (Exports referencing not-yet-created files is fine — npm doesn't validate on install.) tsconfig: `target ES2022, module ESNext, moduleResolution Bundler, jsx react-jsx, jsxImportSource solid-js, strict, noEmit, skipLibCheck`, include `src`.

- [ ] **Step 2: `npm install`; write the failing test `src/types.test.ts`**

```ts
it("parses defaults from empty input", () => {
  expect(parseOptions(undefined)).toEqual(DEFAULT_OPTIONS)
  expect(parseOptions({})).toEqual(DEFAULT_OPTIONS)
})
it("clamps and validates", () => {
  expect(parseOptions({ topN: 0, charsPerToken: -3, defaultMetric: "bogus" }))
    .toEqual({ topN: 1, charsPerToken: 1, defaultMetric: "content" })
  expect(parseOptions({ topN: 5, charsPerToken: 3.7, defaultMetric: "spend" }))
    .toEqual({ topN: 5, charsPerToken: 3.7, defaultMetric: "spend" })
})
it("emptyData has version 1 and no skills", () => {
  expect(emptyData()).toEqual({ version: 1, skills: {} })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/types.test.ts`
Expected: FAIL — `parseOptions` / `emptyData` not defined.

- [ ] **Step 4: Implement `src/types.ts`**

Exactly the Interfaces block above. `parseOptions` reads from a `Record<string, unknown>` (non-object → defaults), coerces with `Number()`, rejects non-finite, clamps with `Math.max(1, …)`.

- [ ] **Step 5: Run tests + typecheck, verify pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/types.ts src/types.test.ts
git commit -m "feat: package scaffold and shared types"
```

---

### Task 2: Persistence (`src/store.ts`)

**Files:**
- Create: `src/store.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: `UsageData`, `emptyData()` from Task 1.
- Produces:

```ts
export interface Store { load(): Promise<UsageData>; save(data: UsageData): Promise<void> }
export const STORAGE_KEY: string // "skill-usage:stats"
export function createPluginStore(storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }): Store
export function createFileStore(filePath: string): Store
```

Load semantics (both stores): missing / unparseable / `version !== 1` → return `emptyData()`. Never throw on load.

- [ ] **Step 1: Write the failing tests**

Use a fake `storage` object backed by a `Map`, and a tmp dir for the file store. Tests:
`load returns emptyData when nothing stored`; `save then load round-trips`; `load returns emptyData on version mismatch` (seed `{version: 99, skills: {…}}`); `load returns emptyData on corrupt JSON` (file store: write `"not json{"` to the file); `file store creates parent directories on save`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store.test.ts`
Expected: FAIL — module/functions missing.

- [ ] **Step 3: Implement `src/store.ts`**

`createPluginStore`: `get`/`set` at `STORAGE_KEY`, validate shape on load. `createFileStore`: `node:fs/promises` — `mkdir(dirname, {recursive:true})` on save, `readFile`/`JSON.parse` in try/catch on load. Validation helper `toUsageData(raw: unknown): UsageData` shared by both (checks `version === 1` and `skills` is an object; per-skill entries pass through as-is).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat: persistence stores with version guard"
```

---

### Task 3: Collection core (`src/tracker.ts`)

**Files:**
- Create: `src/tracker.ts`, `src/tracker.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 2); `UsageData`, `SkillStats`, `emptySkillStats()` (Task 1).
- Produces:

```ts
export interface SkillActivated { sessionID: string; id: string; text: string }
export interface StepEnded { sessionID: string; tokens: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }
export interface Tracker {
  handleSkillActivated(e: SkillActivated): Promise<void>
  handleStepEnded(e: StepEnded): Promise<void>
  reset(): Promise<void>
  data(): UsageData
}
export function createTracker(deps: {
  store: Store
  charsPerToken: number
  now?: () => Date            // default () => new Date(); injected for tests
  onChange?: () => void       // called after every successful flush (RPC hook, Task 6)
}): Promise<Tracker>          // async: loads initial data from store
```

Behavior: `handleSkillActivated` — `contentTokens += Math.round(text.length / charsPerToken)`, `loads += 1`, `lastUsed = now().toISOString()`, add id to the session's skill set, flush. `handleStepEnded` — if the session's skill set is empty, no-op (no flush); otherwise split every token field evenly across the set (floats are fine internally), accumulate, update `lastUsed`, flush. Missing token fields → `?? 0`. `reset` — replace with `emptyData()`, flush. `data()` returns the in-memory copy.

- [ ] **Step 1: Write the failing tests**

Store: in-memory fake (`createPluginStore` over a Map-backed object from Task 2). Fixed `now = () => new Date("2026-10-02T12:00:00Z")`. Tests:

```ts
it("estimates content tokens and counts loads", async () => {
  // charsPerToken 4, text of length 100 → contentTokens 25, loads 1, lastUsed "2026-10-02T12:00:00.000Z"
})
it("accumulates across loads and skills")
it("splits step usage evenly across the session's loaded skills", async () => {
  // skills a + b loaded in s1; stepEnded {input: 100, output: 10, cache: {read: 40}}
  // → a.spend = b.spend = {input: 50, output: 5, reasoning: 0, cacheRead: 20, cacheWrite: 0} (toBeCloseTo)
})
it("ignores step events for sessions with no skills", async () => { /* data unchanged */ })
it("treats missing token fields as zero")
it("persists across tracker instances (reload from store)")
it("two sequential step events both land (no lost update)")
it("reset clears and persists empty data")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tracker.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/tracker.ts`**

In-memory `UsageData` + `Map<string, Set<string>>` session index. Every mutation awaits `store.save(data)` before returning; `onChange?.()` after each save. No batching/debounce — correctness first.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tracker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tracker.ts src/tracker.test.ts
git commit -m "feat: usage collection core with even-split spend attribution"
```

---

### Task 4: Chart rendering (`src/chart.ts`)

**Files:**
- Create: `src/chart.ts`, `src/chart.test.ts`

**Interfaces:**
- Consumes: `UsageData`, `Metric`, `Row`, `Totals` (Task 1).
- Produces:

```ts
export function spendTotal(s: SkillStats["spend"]): number // input+output+reasoning+cacheRead+cacheWrite
export function toRows(data: UsageData, metric: Metric, limit: number): Row[]  // desc by metric value, ties → loads desc, then skillID asc; tokens Math.round'ed
export function totals(rows: Row[], data: UsageData, metric: Metric): Totals   // totals over ALL skills, not just the limited rows
export function barSegments(share: number, width: number): { filled: number; empty: number } // filled = Math.round(share * width) clamped 0..width
export function bar(share: number, width?: number): string // default width 20; "█"×filled + "░"×empty
export function formatTokens(n: number): string            // 1234 → "1.2k", 999 → "999", 1_250_000 → "1.3M"
export function renderMarkdown(rows: Row[], metric: Metric): string // table + total line + empty state
```

`renderMarkdown` columns: `| Skill | Loads | Tokens | Share |` with `bar(share)` + percentage (`Math.round(share*100)` + `%`). Header line above the table: `## Skill Token Usage — content (estimated from chars/4)` or `— session spend (approximate even-split attribution)`. Empty rows → `_No skill usage recorded yet._` (no table). Total line after table: `**Total:** {formatTokens(sum)} tokens · {loads} loads · {skills} skills`.

- [ ] **Step 1: Write the failing tests**

```ts
it("sorts descending by active metric and applies limit")
it("breaks ties by loads then skillID")
it("computes share against grand total so shares sum to ~1")
it("spend metric uses spendTotal")
it("formatTokens formats k and M")
it("barSegments clamps at 0 and width")
it("renderMarkdown shows empty state without a table")
it("renderMarkdown renders header, rows, and total line", () => {
  // snapshot-free: assert it contains "| brainstorming | 12 | 45.2k |" and "**Total:**"
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/chart.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/chart.ts`**

Pure functions only, no I/O. `toRows` maps skills → Row using `metric === "content" ? s.contentTokens : spendTotal(s.spend)`, share vs grand total (guard divide-by-zero → share 0).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/chart.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chart.ts src/chart.test.ts
git commit -m "feat: row derivation and markdown chart rendering"
```

---

### Task 5: Server plugin wiring (`src/command.ts`, `src/index.ts`) — Phase 1 end-to-end

**Files:**
- Create: `src/command.ts`, `src/command.test.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `parseOptions` (Task 1), `createPluginStore` + `createFileStore` (Task 2), `createTracker` (Task 3), `toRows` + `renderMarkdown` (Task 4).
- Produces:

```ts
// src/command.ts
export function createCommandHandler(deps: {
  tracker: Tracker
  options: Options
  synthetic: (msg: { sessionID: string; text: string; description?: string }) => Promise<unknown>
}): (invocation: { sessionID: string; prompt: string }) => Promise<void>
// metric override: invocation.prompt.trim() — "spend" → spend view, "content" → content view, anything else → options.defaultMetric

// src/index.ts — default export
export default Plugin.define({ id: "opencode-skill-usage", setup(ctx) { /* async wiring */ } })
```

`setup`: `const options = parseOptions(ctx.options)`; `const store = createPluginStore(ctx.storage)`; `const tracker = await createTracker({ store, charsPerToken: options.charsPerToken })`; consume `ctx.event.subscribe()` with `for await` (sequential — Review Focus #5), dispatching `session.skill.activated` → `tracker.handleSkillActivated({sessionID, id, text})` and `session.step.ended` → `tracker.handleStepEnded({sessionID, tokens})`; register the command via `ctx.command.transform(editor => editor.add({ name: "skill-usage", description: "Show per-skill token usage chart", execute: createCommandHandler({ tracker, options, synthetic: ctx.session.synthetic }) }))`. The event loop runs detached; catch and log per-event errors so one bad event can't kill the loop.

- [ ] **Step 1: Write the failing tests for the command handler**

```ts
it("renders default metric into a synthetic message", async () => {
  // fake tracker data with 2 skills; assert synthetic called once with sessionID
  // and text containing "| Skill | Loads | Tokens | Share |" and the top skill first
})
it("prompt arg 'spend' switches the metric header", async () => {
  // assert text contains "session spend"
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/command.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/command.ts` and `src/index.ts`**

- [ ] **Step 4: Run all tests + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/command.ts src/command.test.ts src/index.ts
git commit -m "feat: server plugin — event collection and /skill-usage command"
```

- [ ] **Step 6: Verify `ctx.storage` scope (Review Focus #1)**

Add `"plugins": ["file:///Users/rohit/Documents/opencode-skill-usage"]` to `~/.config/opencode/opencode.json` (if the server rejects a `file:` spec, run `npm link` in the project and reference `opencode-skill-usage` by name), then `opencode service restart`. In project dir A, start the TUI, get any skill loaded, run `/skill-usage` → note the numbers. Open a **different** project dir B, run `/skill-usage`. Expected: identical numbers. If B is empty, `ctx.storage` is per-location — change `src/index.ts` to `createFileStore("~/.local/share/opencode/skill-usage.json")` (expand `~` via `os.homedir()`), re-verify, and commit that switch. Check `~/.local/share/opencode/log/opencode.log` (`role=server`) for plugin errors throughout.

- [ ] **Step 7: Verify sub-file reads count (Review Focus #2)**

Have the agent read a skill sub-file (e.g. ask it to read a skill's reference doc). Run `/skill-usage` again. Expected: that skill's loads/tokens increased. If not, sub-file reads don't emit `session.skill.activated` — add a fallback: `ctx.tool.hook("execute.after", cb)` filtering `input.tool === "skill"`, reading `input.input.id`/`input.input.path` and measuring `input.result.content` (string or array of `{type:"text",text}` parts; ignore `{type:"file"}` parts), feeding the same tracker method — dedupe by skipping when `path` is absent (initial load already counted via the event). Commit with the test.

- [ ] **Step 8: Verify command output is visible and inert (Review Focus #3)**

After running `/skill-usage` in the TUI: the markdown table must render in the transcript, and **no model turn may start** (watch for a spinner/cost). If invisible or loop-triggering, switch `createCommandHandler` to send a prompt instead: text becomes a user-visible instruction telling the agent to print the pre-rendered table verbatim. Re-verify, commit.

- [ ] **Step 9: Verify persistence**

`opencode service restart`, reopen TUI, `/skill-usage`. Expected: numbers survive.

- [ ] **Step 10: Phase 1 done — commit any verification fixes**

---

## Phase 2 — RPC + TUI panel

### Task 6: RPC contract + server registration (`src/rpc.ts`)

**Files:**
- Create: `src/rpc.ts`, `src/rpc.test.ts`
- Modify: `src/index.ts` (register RPC, wire `onChange` → emit)

**Interfaces:**
- Consumes: `Tracker` (Task 3), `toRows`/`totals` (Task 4), `Metric`, `Row`, `Totals` (Task 1).
- Produces:

```ts
// src/rpc.ts — imported by BOTH server (index.ts) and TUI (tui.tsx)
export const SkillUsage: Rpc.Contract<…> // Rpc.define({
//   id: "skill-usage",
//   methods: {
//     stats: { input: z.object({ metric: z.enum(["content","spend"]).optional(), limit: z.number().int().positive().optional() }),
//              output: z.object({ rows: z.array(RowSchema), totals: TotalsSchema }) },
//     reset: { input: z.object({}), output: z.object({ ok: z.literal(true) }) },
//   },
//   events: { updated: { schema: z.object({}) } },
// })
```

Defaults when input fields omitted: metric `"content"`, limit from `options.topN` (handler closes over options). In `index.ts`: `ctx.rpc.register(SkillUsage, { stats: …, reset: … })`; `reset` calls `tracker.reset()` and returns `{ok: true}`; pass `onChange: () => registration.events.emit("updated", {})` into `createTracker`.

- [ ] **Step 1: Write the failing tests**

Register handlers against a fake `ctx.rpc.register` that captures them. Tests: `stats returns rows sorted desc with totals`; `stats respects metric and limit input`; `reset clears tracker and returns ok`; `tracker mutation emits "updated"` (capture the emit fn from the fake registration).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/rpc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/rpc.ts` and modify `src/index.ts`**

Zod schemas for `Row`/`Totals` mirroring Task 1 types (single source: define schemas in `src/rpc.ts`; the TS types in `types.ts` stay the canonical names).

- [ ] **Step 4: Run all tests + typecheck, verify pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rpc.ts src/rpc.test.ts src/index.ts
git commit -m "feat: skill-usage RPC contract with stats/reset and live updates"
```

---

### Task 7: Themed TUI panel (`src/tui.tsx`)

**Files:**
- Create: `src/tui.tsx`
- Consume: `barSegments`, `formatTokens` (Task 4), `SkillUsage` contract (Task 6)

**Interfaces:**
- Produces: `export default Plugin.define({ id: "opencode-skill-usage-tui", setup(ctx) {…} })` (from `@opencode/plugin/tui`).

Setup (check exact member names in `node_modules/@opencode/plugin/dist/tui.d.ts` — verified to exist: `ctx.keymap`, `ctx.ui.panel.open`, `ctx.ui.slot`, `ctx.client.rpc`, `ctx.theme`):

1. Slash command via `ctx.keymap` (command with `slash: { name: "skill-usage" }`) whose `run` calls `ctx.ui.panel.open("skill-usage")`.
2. `ctx.ui.slot({ append: "session.panel", render: (input) => input.name === "skill-usage" ? <SkillUsagePanel …/> : null })`.
3. `<SkillUsagePanel>` (solid-js): signals `rows`, `totals`, `metric` (init from `ctx.options.defaultMetric` via `parseOptions`); `onMount` fetch via `ctx.client.rpc(SkillUsage).stats({ metric, limit: options.topN })`; refresh on `rpcClient.events.on("updated", refetch)`.
4. Layout per spec mock: bordered box (`fg: theme.border.base`), title `Skill Token Usage — {metric} (desc)` + key hints (`text.muted`), header row, then per row: skill id (`theme.text.base`), loads + formatted tokens (`theme.text.muted`), bar as two `<text>` spans — `"█"×filled` in `theme.text.action.primary.base`, `"░"×empty` in `theme.text.muted` — and the percentage. Total line at the bottom.
5. Keys on the focused panel (OpenTUI key handler): `m` toggles metric + refetch, `f` → `input.toggleFullscreen()`, `esc` → `input.close()`.

- [ ] **Step 1: Add the pure helper test**

`barSegments`/`formatTokens` already tested in Task 4 — reuse. No JSX unit tests (component is thin); add one test only if non-trivial logic appears.

- [ ] **Step 2: Implement `src/tui.tsx`**

- [ ] **Step 3: Typecheck + full test run**

Run: `npx vitest run && npm run typecheck`
Expected: PASS (solid JSX types resolve via `jsxImportSource`).

- [ ] **Step 4: Commit**

```bash
git add src/tui.tsx
git commit -m "feat: themed TUI panel for /skill-usage"
```

- [ ] **Step 5: Manual verification — panel, theme, live updates**

`opencode service restart`; in the TUI run `/skill-usage`. Expected: the themed **panel** opens (not the markdown message — CLI command takes precedence; if the server command wins, re-check the keymap slash registration against the tui.d.ts API). Switch themes (Ctrl+P → theme) → panel colors follow. In another session, load a skill → open panel updates without restart. `m` toggles content/spend, `f` fullscreen, `esc` closes. Fix and commit anything that fails.

- [ ] **Step 6: Manual verification — non-TUI fallback**

`opencode run` (or web app) with `/skill-usage` → markdown table renders (server command still serves non-panel clients).

---

## Phase 3 — Publish

### Task 8: Package polish + publish prep

**Files:**
- Create: `README.md`, `LICENSE`
- Modify: `package.json`

- [ ] **Step 1: Write `README.md`**

Sections: what it does (one paragraph + both metric explanations with their estimate/approximation disclaimers), install (`"plugins": ["opencode-skill-usage"]` in `opencode.json`), usage (`/skill-usage`, panel keys, `spend`/`content` arg), options table (defaults from Global Constraints), privacy (all data local; storage location), screenshot placeholder note, license. No fabricated numbers in examples.

- [ ] **Step 2: `LICENSE` — MIT, `Copyright (c) 2026 Rohit`**

- [ ] **Step 3: Finish `package.json` metadata**

`description`, `keywords: ["opencode", "opencode-plugin", "skills", "token-usage"]`, `license: "MIT"`, `files: ["src"]`, `publishConfig: { "access": "public" }`, peerDeps `solid-js`, `@opentui/core`, `@opentui/solid`. Leave `repository` out until the repo URL exists (ask the user).

- [ ] **Step 4: Dry-run + final gates**

Run: `npm pack --dry-run && npx vitest run && npm run typecheck`
Expected: tarball lists `src/*`, README, LICENSE, package.json; all gates PASS.

- [ ] **Step 5: Final manual checklist (from spec)**

Fresh restart → use skills → `/skill-usage` numbers correct → persist across restart → panel matches theme → `reset` via panel/command path clears. Then report to the user: ready for `npm publish` (needs their npm login + repo URL decision). Do **not** publish without explicit user go-ahead.

- [ ] **Step 6: Commit**

```bash
git add README.md LICENSE package.json
git commit -m "docs: readme, license, and publish metadata"
```

---

## Self-Review Notes

- **Spec coverage:** metrics (T3), storage global + fallback (T2, T5.6), markdown table (T4–T5), server command + prompt arg (T5), synthetic fallback (T5.8), RPC contract + events (T6), TUI panel + theme + keys + live refresh (T7), options (T1, T5, T7), testing incl. manual checklist (T5.6–5.10, T7.5–7.6, T8.5), publish (T8). Sub-file reads: event-first with verified fallback (T5.7). Per-project stats, trends, web dashboard, V1: out of scope per spec.
- **Type consistency:** `Tracker`, `Store`, `Row`, `Totals`, `SkillUsage` defined once (Tasks 1–4, 6) and referenced by name in Tasks 5–7.
- **Review Focus mapping:** #1→T5.6, #2→T5.7, #3→T5.8, #4→T1 tests, #5→T3 test + T5 sequential loop.
