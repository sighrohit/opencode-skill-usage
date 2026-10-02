import { Plugin } from "@opencode/plugin/tui"
import type { Accessor } from "solid-js"
import { For, createEffect, createMemo, createRoot, createSignal, onCleanup, onMount } from "solid-js"
import { barSegments, formatTokens } from "./chart.js"
import { SkillUsage } from "./rpc.js"
import { parseOptions } from "./types.js"
import type { Metric, Options, Row, Totals } from "./types.js"

/** Panel content name, guarded against in the `session.panel` slot render. */
const PANEL_NAME = "skill-usage"
const PANEL_SLOT = "session.panel"

/** The two bar glyphs. Fixed by the spec; `chart.ts` uses the same pair. */
const BAR_FILLED = "█"
const BAR_EMPTY = "░"

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

/** Same qualifiers `chart.ts` puts in its markdown headers, minus the parentheses. */
const METRIC_DESCRIPTION: Record<Metric, string> = {
  content: "estimated from chars/4",
  spend: "approximate even-split attribution",
}

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

export function panelTitle(metric: Metric): string {
  return `Skill Token Usage — ${metric} (${METRIC_DESCRIPTION[metric]})`
}

/** `Error` messages read better in a toast than `String(cause)`; anything else still has to render. */
export function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
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
      const result = await rpc.stats({ metric: active, limit: props.options.topN })
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
  const title = createMemo(() => panelTitle(props.metric()))
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

    // `keymap.layer` is a reactive primitive, so the plugin-wide slash command
    // layer is anchored in a root this plugin owns and disposes on cleanup.
    const disposeLayer = createRoot((dispose) => {
      ctx.keymap.layer(() => ({
        commands: [
          {
            id: "skill-usage.open",
            title: "Skill token usage",
            description: "Show per-skill token usage",
            // Keeps `/skill-usage` in the prompt and hands its raw input to run.
            slash: { name: PANEL_NAME, arguments: true },
            run: async (raw) => {
              const intent = parsePanelIntent(raw)
              if (intent.kind === "reset") {
                try {
                  await ctx.client.rpc(SkillUsage).reset({})
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
      return dispose
    })

    const disposeSlot = ctx.ui.slot({
      append: PANEL_SLOT,
      render: (input) =>
        input.name === PANEL_NAME ? (
          <SkillUsagePanel
            ctx={ctx}
            input={input}
            options={options}
            metric={metric}
            setMetric={setMetric}
          />
        ) : null,
    })

    const cleanup: Plugin.Cleanup = () => {
      disposeSlot()
      disposeLayer()
    }
    return cleanup
  },
})
