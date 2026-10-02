import type { Metric, Row, SkillStats, Totals, UsageData } from "./types.js"

/** The two bar glyphs. `tui.tsx` imports these so the pair has one owner. */
export const BAR_FILLED = "█"
export const BAR_EMPTY = "░"
const DEFAULT_BAR_WIDTH = 20

export function spendTotal(s: SkillStats["spend"]): number {
  return s.input + s.output + s.reasoning + s.cacheRead + s.cacheWrite
}

function metricValue(s: SkillStats, metric: Metric): number {
  return metric === "content" ? s.contentTokens : spendTotal(s.spend)
}

/** Grand total across every skill, so `toRows` and `totals` can never disagree. */
function grandTotal(data: UsageData, metric: Metric): number {
  let sum = 0
  for (const id of Object.keys(data.skills)) {
    sum += metricValue(data.skills[id]!, metric)
  }
  return sum
}

export function toRows(data: UsageData, metric: Metric, limit: number): Row[] {
  const total = grandTotal(data, metric)
  const rows: Row[] = Object.keys(data.skills).map((skillID) => {
    const stats = data.skills[skillID]!
    // `tokens` is a display value and is rounded; `share` is a proportion and stays on the
    // raw basis so it sums to 1 and never contradicts `totals`. Sub-token attribution
    // (the tracker's even split) legitimately rounds to 0 tokens with a non-zero share.
    const raw = metricValue(stats, metric)
    return {
      skillID,
      loads: stats.loads,
      tokens: Math.round(raw),
      share: total > 0 ? raw / total : 0,
    }
  })
  rows.sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens
    if (b.loads !== a.loads) return b.loads - a.loads
    return a.skillID < b.skillID ? -1 : a.skillID > b.skillID ? 1 : 0
  })
  return rows.slice(0, Math.max(0, limit))
}

export function totals(rows: Row[], data: UsageData, metric: Metric): Totals {
  // `rows` is retained for call-site compatibility; totals must cover every skill,
  // not just the limited rows, so it is intentionally unused in the computation.
  void rows
  let loads = 0
  for (const id of Object.keys(data.skills)) {
    loads += data.skills[id]!.loads
  }
  // Same helper `toRows` divides by, so the two can never disagree.
  return {
    skills: Object.keys(data.skills).length,
    loads,
    tokens: Math.round(grandTotal(data, metric)),
  }
}

export function barSegments(share: number, width: number): { filled: number; empty: number } {
  const w = Math.max(0, Math.round(width))
  const raw = Math.round(share * w)
  const filled = Number.isFinite(raw) ? Math.min(w, Math.max(0, raw)) : 0
  return { filled, empty: w - filled }
}

export function bar(share: number, width: number = DEFAULT_BAR_WIDTH): string {
  const { filled, empty } = barSegments(share, width)
  return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(empty)
}

/** One decimal via Math.round on a scaled integer, so `.x5` ties round half up. */
function oneDecimal(n: number): string {
  return String(Math.round(n * 10) / 10)
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${oneDecimal(n / 1_000_000)}M`
  if (n >= 1_000) return `${oneDecimal(n / 1_000)}k`
  return String(Math.round(n))
}

/**
 * The parenthetical that says how the active metric was derived. It is the one
 * owner of the qualifier strings: `tui.tsx` renders the same qualifier in its
 * panel title, so both surfaces must stay in lockstep.
 */
export function metricQualifier(metric: Metric, charsPerToken: number): string {
  return metric === "content"
    ? `estimated from chars/${charsPerToken}`
    : "approximate even-split attribution"
}

const HEADERS: Record<Metric, string> = {
  content: "## Skill Token Usage — content",
  spend: "## Skill Token Usage — session spend",
}

export function renderMarkdown(
  rows: Row[],
  metric: Metric,
  totalsOverride?: Totals,
  charsPerToken = 4,
): string {
  const lines: string[] = [`${HEADERS[metric]} (${metricQualifier(metric, charsPerToken)})`]
  if (rows.length === 0) {
    lines.push("", "_No skill usage recorded yet._")
    return lines.join("\n")
  }

  const t =
    totalsOverride ??
    ({
      skills: rows.length,
      loads: rows.reduce((sum, r) => sum + r.loads, 0),
      tokens: rows.reduce((sum, r) => sum + r.tokens, 0),
    } satisfies Totals)

  lines.push("", "| Skill | Loads | Tokens | Share |", "| --- | --- | --- | --- |")
  for (const row of rows) {
    lines.push(
      `| ${row.skillID} | ${row.loads} | ${formatTokens(row.tokens)} | ${bar(row.share)} ${Math.round(row.share * 100)}% |`,
    )
  }
  lines.push("", `**Total:** ${formatTokens(t.tokens)} tokens · ${t.loads} loads · ${t.skills} skills`)
  return lines.join("\n")
}
