export type Metric = "content" | "spend"

export interface SkillStats {
  loads: number
  contentTokens: number
  spend: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  lastUsed: string // ISO 8601
}

export interface UsageData {
  version: 1
  skills: Record<string, SkillStats>
}

export interface Options {
  topN: number
  charsPerToken: number
  defaultMetric: Metric
}

export const DEFAULT_OPTIONS: Options = {
  topN: 15,
  charsPerToken: 4,
  defaultMetric: "content",
}

export interface Row {
  skillID: string
  loads: number
  tokens: number
  share: number
}

export interface Totals {
  skills: number
  loads: number
  tokens: number
}

export function emptySkillStats(): SkillStats {
  return {
    loads: 0,
    contentTokens: 0,
    spend: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    lastUsed: new Date(0).toISOString(),
  }
}

export function emptyData(): UsageData {
  return { version: 1, skills: {} }
}

function coerceClamped(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, n)
}

export function parseOptions(raw: unknown): Options {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_OPTIONS }
  const record = raw as Record<string, unknown>
  const defaultMetric: Metric =
    record["defaultMetric"] === "content" || record["defaultMetric"] === "spend"
      ? record["defaultMetric"]
      : "content"
  return {
    // `topN` is a row count, so it is integer by construction: the TUI always
    // sends it as an explicit `limit`, and the RPC contract requires a positive
    // integer there. `charsPerToken` stays fractional — it is a divisor.
    topN: Math.trunc(coerceClamped(record["topN"], DEFAULT_OPTIONS.topN)),
    charsPerToken: coerceClamped(record["charsPerToken"], DEFAULT_OPTIONS.charsPerToken),
    defaultMetric,
  }
}
