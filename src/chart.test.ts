import { describe, expect, it } from "vitest"
import { emptySkillStats, type Metric, type Row, type UsageData } from "./types.js"
import { bar, barSegments, formatTokens, renderMarkdown, spendTotal, toRows, totals } from "./chart.js"

function data(skills: Record<string, Partial<UsageData["skills"][string]>>): UsageData {
  const out: UsageData["skills"] = {}
  for (const [id, partial] of Object.entries(skills)) {
    out[id] = { ...emptySkillStats(), ...partial }
  }
  return { version: 1, skills: out }
}

function spend(fields: Partial<UsageData["skills"][string]["spend"]>) {
  return { ...emptySkillStats().spend, ...fields }
}

describe("spendTotal", () => {
  it("sums all five spend fields", () => {
    expect(
      spendTotal({ input: 1, output: 2, reasoning: 4, cacheRead: 8, cacheWrite: 16 }),
    ).toBe(31)
  })

  it("returns 0 for an all-zero spend", () => {
    expect(spendTotal(emptySkillStats().spend)).toBe(0)
  })
})

describe("toRows", () => {
  it("sorts descending by active metric and applies limit", () => {
    const rows = toRows(
      data({
        a: { contentTokens: 100, loads: 1 },
        b: { contentTokens: 300, loads: 1 },
        c: { contentTokens: 200, loads: 1 },
      }),
      "content",
      2,
    )
    expect(rows.map((r) => r.skillID)).toEqual(["b", "c"])
    expect(rows.map((r) => r.tokens)).toEqual([300, 200])
  })

  it("breaks ties by loads then skillID", () => {
    const rows = toRows(
      data({
        zeta: { contentTokens: 100, loads: 1 },
        alpha: { contentTokens: 100, loads: 9 },
        beta: { contentTokens: 100, loads: 9 },
      }),
      "content",
      10,
    )
    expect(rows.map((r) => r.skillID)).toEqual(["alpha", "beta", "zeta"])
  })

  it("computes share against grand total so shares sum to ~1", () => {
    // Fractional values: this is the shape the tracker's even split actually stores.
    const fractional = data({
      a: { contentTokens: 100 / 3 },
      b: { contentTokens: 200 / 3 },
      c: { contentTokens: 700 / 3 },
    })
    const all = toRows(fractional, "content", 3)
    expect(all.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1, 10)

    const limited = toRows(fractional, "content", 2)
    // limited[0] is c — 700/3 of the full 1000, not of the 900 shown in the two rows
    expect(limited[0]!.share).toBeCloseTo(0.7, 10)
    expect(limited.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(0.9, 10)
  })

  it("keeps share on the raw basis while rounding tokens", () => {
    const rows = toRows(data({ a: { contentTokens: 0.4 }, b: { contentTokens: 0.6 } }), "content", 2)
    // Both round to 0 tokens, but the proportions still reflect the real split.
    expect(rows.map((r) => r.tokens)).toEqual([1, 0])
    expect(rows[0]!.share).toBeCloseTo(0.6, 10)
    expect(rows[1]!.share).toBeCloseTo(0.4, 10)
  })

  it("yields share 0 instead of NaN when there are no skills", () => {
    expect(toRows(data({}), "content", 10)).toEqual([])
    const allZero = toRows(data({ a: { contentTokens: 0 }, b: {} }), "spend", 10)
    expect(allZero.every((r) => r.share === 0)).toBe(true)
    expect(allZero.every((r) => Number.isNaN(r.share))).toBe(false)
  })

  it("returns no rows for a limit of 0", () => {
    expect(toRows(data({ a: { contentTokens: 10 } }), "content", 0)).toEqual([])
  })

  it("gives a single skill a share of 1", () => {
    const rows = toRows(data({ solo: { contentTokens: 42 } }), "content", 10)
    expect(rows[0]!.share).toBe(1)
  })

  it("spend metric uses spendTotal", () => {
    const d = data({ a: { contentTokens: 9999, spend: spend({ input: 5, output: 5 }) } })
    const rows = toRows(d, "spend", 10)
    expect(rows[0]!.tokens).toBe(10)
  })

  it("rounds fractional spend into integer token counts", () => {
    const rows = toRows(data({ a: { spend: spend({ output: 1 / 3 }) } }), "spend", 10)
    expect(rows[0]!.tokens).toBe(0)
  })
})

describe("totals", () => {
  const d = data({
    a: { contentTokens: 100, loads: 2 },
    b: { contentTokens: 200, loads: 3 },
    c: { contentTokens: 700, loads: 5 },
  })

  it("totals over all skills, not just the limited rows", () => {
    const rows = toRows(d, "content", 1)
    expect(totals(rows, d, "content")).toEqual({ skills: 3, loads: 10, tokens: 1000 })
  })

  it("works with no rows at all", () => {
    expect(totals([], d, "content")).toEqual({ skills: 3, loads: 10, tokens: 1000 })
  })

  it("sums zero for empty data", () => {
    expect(totals([], data({}), "spend")).toEqual({ skills: 0, loads: 0, tokens: 0 })
  })

  it("switches metric with spendTotal", () => {
    const spendData = data({
      a: { contentTokens: 5, loads: 1, spend: spend({ input: 1, output: 2 }) },
      b: { contentTokens: 5, loads: 1, spend: spend({ reasoning: 3, cacheWrite: 4 }) },
    })
    expect(totals([], spendData, "spend")).toEqual({ skills: 2, loads: 2, tokens: 10 })
    expect(totals([], spendData, "content")).toEqual({ skills: 2, loads: 2, tokens: 10 })
  })
})

describe("barSegments", () => {
  it("fills proportionally to share", () => {
    expect(barSegments(0.5, 10)).toEqual({ filled: 5, empty: 5 })
    expect(barSegments(1, 10)).toEqual({ filled: 10, empty: 0 })
    expect(barSegments(0, 10)).toEqual({ filled: 0, empty: 10 })
  })

  it("clamps at 0 and width", () => {
    expect(barSegments(-5, 10)).toEqual({ filled: 0, empty: 10 })
    expect(barSegments(9, 10)).toEqual({ filled: 10, empty: 0 })
    expect(barSegments(1.5, 10)).toEqual({ filled: 10, empty: 0 })
    expect(barSegments(NaN, 10)).toEqual({ filled: 0, empty: 10 })
    expect(barSegments(0.5, 0)).toEqual({ filled: 0, empty: 0 })
  })
})

describe("bar", () => {
  it("uses block characters with a default width of 20", () => {
    expect(bar(0.5)).toBe("█".repeat(10) + "░".repeat(10))
    expect(bar(0.5, 4)).toBe("██░░")
    expect(bar(1)).toBe("█".repeat(20))
    expect(bar(0)).toBe("░".repeat(20))
  })
})

describe("formatTokens", () => {
  it("formats k and M", () => {
    expect(formatTokens(1234)).toBe("1.2k")
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1250000)).toBe("1.3M")
  })

  it("keeps raw counts below a thousand and large M values", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(1000)).toBe("1k")
    expect(formatTokens(45200)).toBe("45.2k")
    expect(formatTokens(1234567)).toBe("1.2M")
    expect(formatTokens(1500000)).toBe("1.5M")
  })
})

describe("renderMarkdown", () => {
  const rows: Row[] = [
    { skillID: "brainstorming", loads: 12, tokens: 45200, share: 0.42 },
    { skillID: "writing", loads: 3, tokens: 9000, share: 0.08 },
  ]

  it("shows empty state without a table", () => {
    const out = renderMarkdown([], "content")
    expect(out).toContain("_No skill usage recorded yet._")
    expect(out).not.toContain("| Skill |")
  })

  it("renders header, rows, and total line", () => {
    const out = renderMarkdown(rows, "content")
    expect(out).toContain("## Skill Token Usage — content (estimated from chars/4)")
    expect(out).toContain("| brainstorming | 12 | 45.2k |")
    expect(out).toContain("| writing | 3 | 9k |")
    expect(out).toContain("**Total:**")
  })

  it("labels the spend header with its approximation caveat", () => {
    const out = renderMarkdown(rows, "spend")
    expect(out).toContain(
      "## Skill Token Usage — session spend (approximate even-split attribution)",
    )
  })

  it("prints bar and rounded percentage in the Share column", () => {
    const out = renderMarkdown([rows[0]!], "content")
    expect(out).toContain("█".repeat(8) + "░".repeat(12))
    expect(out).toContain("42%")
  })

  it("derives totals from rows when totals is omitted", () => {
    const out = renderMarkdown(rows, "content")
    expect(out).toContain("**Total:** 54.2k tokens · 15 loads · 2 skills")
  })

  it("uses supplied totals so the skill count stays global", () => {
    const out = renderMarkdown([rows[0]!], "content", {
      skills: 40,
      loads: 500,
      tokens: 1000000,
    })
    expect(out).toContain("**Total:** 1M tokens · 500 loads · 40 skills")
  })

  // The shape the tracker's even split really produces: 1 token of output split
  // three ways stores 1/3 per skill, so every skill rounds to 0 display tokens.
  const split = data({
    a: { loads: 1, spend: spend({ output: 1 / 3 }) },
    b: { loads: 1, spend: spend({ output: 1 / 3 }) },
    c: { loads: 1, spend: spend({ output: 1 / 3 }) },
  })

  it("does not contradict itself on sub-token even-split spend", () => {
    const splitRows = toRows(split, "spend", 10)
    const t = totals(splitRows, split, "spend")
    expect(t).toEqual({ skills: 3, loads: 3, tokens: 1 })

    // Display rounding hides the sub-token amount, but the share stays truthful.
    expect(splitRows.every((r) => r.tokens === 0)).toBe(true)
    for (const r of splitRows) expect(r.share).toBeCloseTo(1 / 3, 10)

    const md = renderMarkdown(splitRows, "spend", t)
    // The spend is visible: real percentages and filled bars, not silent zeros.
    expect(md).toContain("33%")
    expect(md).toContain("████")
    expect(md).not.toMatch(/\|\s*0\s*\|\s*░+\s*0%/)
    // And the total line is the same number `totals` reports, from the same sum.
    expect(md).toContain(
      `**Total:** ${formatTokens(t.tokens)} tokens · ${t.loads} loads · ${t.skills} skills`,
    )
  })

  it("keeps the total global when sub-token rows are truncated", () => {
    const one = toRows(split, "spend", 1)
    const t = totals(one, split, "spend")
    // Summing the visible rows would give 1/3 -> 0 and contradict the row's 33% share.
    expect(t.tokens).toBe(1)
    expect(one[0]!.share).toBeCloseTo(1 / 3, 10)
    expect(renderMarkdown(one, "spend", t)).toContain(
      `**Total:** ${formatTokens(t.tokens)} tokens · ${t.loads} loads · ${t.skills} skills`,
    )
  })
})

describe("metric coverage", () => {
  it("handles both metrics end to end", () => {
    const metrics: Metric[] = ["content", "spend"]
    const d = data({
      a: { contentTokens: 10, loads: 1, spend: spend({ output: 30 }) },
      b: { contentTokens: 20, loads: 1, spend: spend({ output: 10 }) },
    })
    for (const metric of metrics) {
      const rows = toRows(d, metric, 10)
      expect(rows.map((r) => r.skillID)).toEqual(metric === "content" ? ["b", "a"] : ["a", "b"])
      expect(renderMarkdown(rows, metric)).toContain("## Skill Token Usage")
    }
  })
})
