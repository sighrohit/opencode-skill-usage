/** @jsxImportSource @opentui/solid */
// Load-bearing, not decoration: OpenCode's Solid JSX transform skips anything
// inside `node_modules`, and this file always is once packaged. Without this
// pragma the transpiler falls back to React and the panel fails with
// `Cannot find package 'react'`. `tsconfig.json` cannot cover it — the runtime
// transpiler reads tsconfig from the process cwd, not the imported package.
// Keep this pragma on a single line: the parser captures to end-of-line and a
// trailing newline becomes part of the module specifier.
import { Plugin } from "@opencode/plugin/tui"
import type { Accessor } from "solid-js"
import { For, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { BAR_EMPTY, BAR_FILLED, barSegments, formatTokens, metricQualifier } from "./chart.js"
import { SkillUsage } from "./rpc.js"
import { parseOptions } from "./types.js"
import type { LocationRef } from "@opencode/client"
import type { Metric, Options, Row, Totals } from "./types.js"

/** Panel content name, guarded against in the `session.panel` slot render. */
const PANEL_NAME = "skill-usage"
const PANEL_SLOT = "session.panel"

/** One blank column between the skill name and the loads column, and after it. */
const GUTTER = 1
const PERCENT_WIDTH = 4
const MIN_SKILL_WIDTH = 10
const MAX_BAR_WIDTH = 24
const PADDING_LEFT = 2
const PADDING_TRAILING = 1
/** Left and right border (2), left padding, and one column of breathing room. */
const FRAME_COLUMNS = 2 + PADDING_LEFT + PADDING_TRAILING

const KEY_HINTS = "[m]etric [f]ullscreen [esc] close"

/** Matches `_No skill usage recorded yet._` in the markdown renderer, without the markup. */
const EMPTY_MESSAGE = "No skill usage recorded yet."

const ELLIPSIS = "…"

type PanelInput = Parameters<
  Extract<Parameters<Plugin.Context["ui"]["slot"]>[0], { append: typeof PANEL_SLOT }>["render"]
>[0]

type Theme = Plugin.Context["theme"]

export type PanelIntent =
  | { readonly kind: "open"; readonly metric?: Metric }
  | { readonly kind: "reset" }

/**
 * The first whitespace-separated token of the slash argument decides what
 * `/skill-usage <token>` does. Anything unrecognised — including an empty
 * argument — just opens the panel, which then falls back to the configured
 * default metric.
 */
export function parsePanelIntent(raw: string | undefined): PanelIntent {
  const token = (raw ?? "").trim().split(/\s+/)[0] ?? ""
  if (token === "reset") return { kind: "reset" }
  if (token === "content" || token === "spend") return { kind: "open", metric: token }
  return { kind: "open" }
}

export interface PanelColumns {
  /** Width of the skill-name column. */
  readonly skill: number
  /** Width of the right-aligned loads column. */
  readonly loads: number
  /** Width of the right-aligned formatted-token column. */
  readonly tokens: number
  /** Total bar width, split between the filled and empty runs. */
  readonly bar: number
  /** Width of the right-aligned percentage column. */
  readonly percent: number
}

function widest(header: string, values: readonly string[]): number {
  let width = header.length
  for (const value of values) if (value.length > width) width = value.length
  return width
}

/**
 * Columns are derived from the panel's live width, never hard-coded, so the
 * table survives a split/fullscreen switch. Fixed columns are sized to their
 * own content (never below their header), the bar takes what is left over once
 * the skill name keeps `MIN_SKILL_WIDTH`, and the skill name absorbs the rest.
 * The result always sums to `available` — `skill + loads + tokens + bar +
 * percent` plus the three gutters — so the row cannot reflow. When the panel is
 * too narrow to fit the fixed columns the bar collapses to zero rather than
 * pushing the percentage off the right edge.
 */
export function panelColumns(width: number, rows: readonly Row[]): PanelColumns {
  const available = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0
  const percent = Math.min(PERCENT_WIDTH, available)
  const loads = widest("Loads", rows.map((row) => String(row.loads)))
  const tokens = widest("Tokens", rows.map((row) => formatTokens(row.tokens)))
  const fixed = GUTTER + loads + GUTTER + tokens + GUTTER + percent
  const flexible = Math.max(0, available - fixed)
  const bar = Math.min(MAX_BAR_WIDTH, Math.max(0, flexible - MIN_SKILL_WIDTH))
  const skill = Math.max(0, flexible - bar)
  return { skill, loads, tokens, bar, percent }
}

/** The panel's outer width minus the border, padding and trailing column. */
export function panelContentWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.trunc(width) - FRAME_COLUMNS) : 0
}

export interface PanelCells {
  readonly skill: string
  readonly loads: string
  readonly tokens: string
  readonly filled: string
  readonly empty: string
  readonly percent: string
}

function clip(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value
  if (width === 1) return value.slice(0, 1)
  return value.slice(0, width - 1) + ELLIPSIS
}

/** One data row, laid out in the columns `panelColumns` picked. */
export function panelRowCells(row: Row, columns: PanelColumns): PanelCells {
  const segments = barSegments(row.share, columns.bar)
  return {
    skill: clip(row.skillID, columns.skill),
    loads: String(row.loads).padStart(columns.loads),
    tokens: formatTokens(row.tokens).padStart(columns.tokens),
    filled: BAR_FILLED.repeat(segments.filled),
    empty: BAR_EMPTY.repeat(segments.empty),
    percent: `${Math.round(row.share * 100)}%`.padStart(columns.percent),
  }
}

/** The header row. `Share` labels the bar columns and the empty run is blank. */
export function panelHeaderCells(columns: PanelColumns): PanelCells {
  return {
    skill: "Skill".padEnd(columns.skill),
    loads: "Loads".padStart(columns.loads),
    tokens: "Tokens".padStart(columns.tokens),
    filled: columns.bar > 0 ? "Share" : "",
    empty: "",
    percent: "",
  }
}

/**
 * `totals.skills` counts every recorded skill while `rows` is capped at
 * `topN`, so the summary deliberately reports the server's totals rather than
 * the visible rows.
 */
export function panelTotalLine(totals: Totals): string {
  return `Total: ${formatTokens(totals.tokens)} tokens · ${totals.loads} loads · ${totals.skills} skills`
}

/** `charsPerToken` is deliberately required: the title must state the divisor the
 * numbers were actually computed with, so a call site that forgets to pass it
 * should fail the typecheck rather than silently fall back to 4. */
export function panelTitle(metric: Metric, charsPerToken: number): string {
  return `Skill Token Usage — ${metric} (${metricQualifier(metric, charsPerToken)})`
}

/** `Error` messages read better in a toast than `String(cause)`; anything else still has to render. */
export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof (cause as { message: unknown }).message === "string") {
    return (cause as { message: string }).message
  }
  return String(cause)
}

/** Returns the `location` query param required by the host's RPC route. Omitting it causes HTTP 400 before the handler runs. */
export function rpcLocation(ctx: Plugin.Context): { location: LocationRef } {
  return { location: ctx.location ?? ctx.data.location.default() }
}

interface Snapshot {
  readonly rows: readonly Row[]
  readonly totals: Totals
}

const EMPTY_SNAPSHOT: Snapshot = { rows: [], totals: { skills: 0, loads: 0, tokens: 0 } }

/**
 * One table line: skill name, loads, tokens, the two-tone bar and the
 * percentage. Each column carries an explicit width so the row occupies exactly
 * the columns `panelColumns` budgeted; the gutters are their own one-column
 * boxes, so nothing depends on how the renderer measures padded text.
 *
 * Props are read through `props`, never destructured: Solid exposes component
 * props as getters, and a destructured copy would freeze the row at whatever it
 * held when the row was created.
 */
function TableLine(props: {
  readonly cells: PanelCells
  readonly columns: PanelColumns
  readonly theme: Accessor<Theme>
}) {
  return (
    <box flexDirection="row">
      <text fg={props.theme().text.base} width={props.columns.skill} textAlign="left">
        {props.cells.skill}
      </text>
      <box flexShrink={0} width={GUTTER} />
      <text fg={props.theme().text.muted} width={props.columns.loads} textAlign="right">
        {props.cells.loads}
      </text>
      <box flexShrink={0} width={GUTTER} />
      <text fg={props.theme().text.muted} width={props.columns.tokens} textAlign="right">
        {props.cells.tokens}
      </text>
      <box flexShrink={0} width={GUTTER} />
      {/* The two runs are adjacent by construction, so they share one bar-wide
          box rather than sitting side by side as two bars. */}
      <box flexDirection="row" flexShrink={0} width={props.columns.bar}>
        <text fg={props.theme().text.action.primary.base} flexShrink={0}>
          {props.cells.filled}
        </text>
        <text fg={props.theme().text.muted} flexShrink={0}>
          {props.cells.empty}
        </text>
      </box>
      <text fg={props.theme().text.base} width={props.columns.percent} textAlign="right">
        {props.cells.percent}
      </text>
    </box>
  )
}

function SkillUsagePanel(props: {
  readonly ctx: Plugin.Context
  readonly input: PanelInput
  readonly options: Options
  readonly metric: Accessor<Metric>
  readonly setMetric: (metric: Metric) => void
}) {
  // `Context.theme` is a live getter over the host's theme store, so it is read
  // inside a memo: switching themes repaints the panel without a remount.
  const theme = createMemo(() => props.ctx.theme)
  const rpc = props.ctx.client.rpc(SkillUsage)
  const [snapshot, setSnapshot] = createSignal<Snapshot>(EMPTY_SNAPSHOT)
  const [failure, setFailure] = createSignal<string | undefined>(undefined)

  // A metric toggle can leave two `stats` calls in flight; only the newest
  // answer is allowed to paint, so the panel never shows the other metric.
  let latest = 0

  async function load(active: Metric): Promise<void> {
    const ticket = ++latest
    try {
      const result = await rpc.stats(
        { metric: active, limit: props.options.topN },
        rpcLocation(props.ctx),
      )
      if (ticket !== latest) return
      setSnapshot({ rows: result.rows, totals: result.totals })
      setFailure(undefined)
    } catch (cause) {
      if (ticket !== latest) return
      setFailure(describeError(cause))
    }
  }

  // The only fetcher: runs on mount and again on every metric change.
  createEffect(() => void load(props.metric()))

  let unsubscribe: (() => void) | undefined
  onMount(() => {
    unsubscribe = rpc.events.on("updated", () => void load(props.metric()))
  })
  onCleanup(() => unsubscribe?.())

  // Owned by this component, so the layer is dropped with the panel, and scoped
  // to the panel's focus so `m`/`f`/`escape` never reach another surface.
  props.ctx.keymap.layer(() => ({
    enabled: () => props.input.focused,
    commands: [
      {
        id: "skill-usage.toggle-metric",
        title: "Toggle metric",
        description: "Switch between estimated content tokens and attributed session spend",
        bind: "m",
        run: () => props.setMetric(props.metric() === "content" ? "spend" : "content"),
      },
      {
        id: "skill-usage.fullscreen",
        title: "Toggle fullscreen",
        description: "Show the skill usage panel fullscreen",
        bind: "f",
        run: () => props.input.toggleFullscreen(),
      },
      {
        id: "skill-usage.close",
        title: "Close panel",
        description: "Close the skill usage panel",
        bind: "escape",
        run: () => props.input.close(),
      },
    ],
  }))

  const rows = createMemo(() => snapshot().rows)
  const columns = createMemo(() => panelColumns(panelContentWidth(props.input.width), rows()))
  const header = createMemo(() => panelHeaderCells(columns()))
  const lines = createMemo(() => rows().map((row) => panelRowCells(row, columns())))
  const title = createMemo(() => panelTitle(props.metric(), props.options.charsPerToken))
  const total = createMemo(() => panelTotalLine(snapshot().totals))

  function body() {
    const problem = failure()
    if (problem !== undefined) {
      return <text fg={theme().text.muted}>Unable to load skill usage: {problem}</text>
    }
    if (rows().length === 0) {
      return <text fg={theme().text.muted}>{EMPTY_MESSAGE}</text>
    }
    return (
      <For each={lines()}>
        {(cells) => <TableLine cells={cells} columns={columns()} theme={theme} />}
      </For>
    )
  }

  return (
    <box
      flexDirection="column"
      border
      borderColor={theme().border.base}
      paddingLeft={PADDING_LEFT}
      paddingRight={PADDING_TRAILING}
      width={props.input.width}
      focused={props.input.focused}
    >
      {/* `BoxOptions.title` supports one alignment only, so the spec's two-sided
          top line is an inner flex row instead. It also keeps the metric name
          reactive, which a border title cannot guarantee. */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.base}>{title()}</text>
        <text fg={theme().text.muted}>{KEY_HINTS}</text>
      </box>
      {/* The header is a legend for the table, so it goes away with the table
          rather than sitting above the empty state. */}
      {rows().length > 0 ? <TableLine cells={header()} columns={columns()} theme={theme} /> : null}
      {body()}
      <text fg={theme().text.muted}>{total()}</text>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-skill-usage-tui",
  setup(ctx) {
    const options = parseOptions(ctx.options)
    // Shared with the panel so `/skill-usage spend` also re-targets a panel that
    // is already open, and so `m` survives the panel closing and reopening.
    const [metric, setMetric] = createSignal<Metric>(options.defaultMetric)

    // `keymap.layer` must be created inside the host's `Keymap.Provider`, which
    // only exists within its Solid tree. Two places look available and neither is:
    // `setup()` runs outside the tree and throws "Keymap.Provider is missing", and
    // the `session.panel` slot renders only while the panel is ALREADY open, which
    // would put the command that opens the panel inside the panel it opens.
    // The `app` slot is always mounted, so it is the one registration point that is
    // in the tree from startup. This mirrors the documented session-panel pattern.
    const openCommand = () => {
      ctx.keymap.layer(() => ({
        // Without this the layer defaults to mode "base" and is scoped to that
        // input mode only, which is not where the palette dispatches from. The
        // documented session-panel example registers "global" for the same reason.
        mode: "global",
        commands: [
          {
            id: "skill-usage.open",
            title: "Skill token usage",
            description: "Show per-skill token usage",
            palette: true,
            // Host does not arbitrate between namespaces — it lists both in `/`
            // completion. The earlier fix (round 5) declined the name here, but
            // the target UX is a single `/skill-usage` like `/skills`: one keymap
            // command with `palette: true` and `slash` that opens the panel.
            // The server editor command is deleted (see index.ts). This mirrors
            // the binary's built-in `skills` command shape exactly.
            slash: { name: PANEL_NAME, arguments: true },
            run: async (raw) => {
              const intent = parsePanelIntent(raw)
              if (intent.kind === "reset") {
                try {
                  await ctx.client.rpc(SkillUsage).reset({}, rpcLocation(ctx))
                  ctx.ui.toast.show({
                    title: "Skill usage",
                    message: "Recorded skill usage cleared.",
                    variant: "success",
                  })
                } catch (cause) {
                  ctx.ui.toast.show({
                    title: "Skill usage",
                    message: `Could not reset skill usage: ${describeError(cause)}`,
                    variant: "error",
                  })
                }
                return
              }
              setMetric(intent.metric ?? options.defaultMetric)
              if (!ctx.ui.panel.open(PANEL_NAME)) {
                ctx.ui.toast.show({
                  title: "Skill usage",
                  message: "Open a session to see the skill usage panel.",
                  variant: "error",
                })
              }
            },
          },
        ],
      }))
    }

    // Always mounted, so this is where the open command gets registered. No
    // mount guard: the layer belongs to the slot component's lifetime, so it must
    // be re-created if that component ever remounts.
    //
    // Registration is inline in `render`, matching the documented session-panel
    // recipe and the working `@tarquinen/opencode-dcp` plugin. A previous version
    // deferred it into a child component's `onMount`; that layer never reached the
    // keymap, so the command was absent from the command palette and `/skill-usage`
    // silently resolved to the server's editor command instead.
    //
    // What must stay out of `render` is any *reactive read* of keymap state. A debug
    // pass that called `keymap.commands()` here read a signal that `layer()` then
    // invalidated, self-invalidating without bound: two toasts a pass flooded the
    // queue and opencode hung, and the re-entrant renders tripped OpenCode's own
    // `Stale read from <Show>` assert. Registering here is fine; reading is not.
    // See plugin-registration.test.ts.
    const disposeAppSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        openCommand()
        return null
      },
    })

    const disposePanelSlot = ctx.ui.slot({
      append: PANEL_SLOT,
      render: (input) => {
        return input.name === PANEL_NAME ? (
          <SkillUsagePanel
            ctx={ctx}
            input={input}
            options={options}
            metric={metric}
            setMetric={setMetric}
          />
        ) : null
      },
    })

    const cleanup: Plugin.Cleanup = () => {
      disposeAppSlot()
      disposePanelSlot()
    }
    return cleanup
  },
})
