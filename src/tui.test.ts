import { describe, expect, it } from "vitest"
import type { Row } from "./types.js"
import {
  describeError,
  panelColumns,
  panelContentWidth,
  panelHeaderCells,
  panelRowCells,
  panelTitle,
  panelTotalLine,
  parsePanelIntent,
} from "./tui.js"

/** The three rows the spec mock shows, in the order the server returns them. */
function mockRows(): Row[] {
  return [
    { skillID: "brainstorming", loads: 12, tokens: 45_200, share: 0.37 },
    { skillID: "systematic-debugging", loads: 8, tokens: 28_100, share: 0.23 },
    { skillID: "frontend-design", loads: 5, tokens: 17_400, share: 0.14 },
  ]
}

/** `skill + loads + tokens + bar + percent` plus the three one-column gutters. */
function renderedWidth(columns: ReturnType<typeof panelColumns>): number {
  return columns.skill + columns.loads + columns.tokens + columns.bar + columns.percent + 3
}

describe("parsePanelIntent", () => {
  it("selects the metric named in the slash argument", () => {
    expect(parsePanelIntent("content")).toEqual({ kind: "open", metric: "content" })
    expect(parsePanelIntent("spend")).toEqual({ kind: "open", metric: "spend" })
  })

  it("routes reset to the RPC handler instead of opening the panel", () => {
    expect(parsePanelIntent("reset")).toEqual({ kind: "reset" })
  })

  it("reads only the first whitespace-separated token", () => {
    expect(parsePanelIntent("  spend   now ")).toEqual({ kind: "open", metric: "spend" })
    expect(parsePanelIntent("reset hard")).toEqual({ kind: "reset" })
    expect(parsePanelIntent("content\tall")).toEqual({ kind: "open", metric: "content" })
  })

  it("falls back to opening with the configured default for empty or unknown arguments", () => {
    expect(parsePanelIntent(undefined)).toEqual({ kind: "open" })
    expect(parsePanelIntent("")).toEqual({ kind: "open" })
    expect(parsePanelIntent("   ")).toEqual({ kind: "open" })
    expect(parsePanelIntent("tokens")).toEqual({ kind: "open" })
    expect(parsePanelIntent("CONTENT")).toEqual({ kind: "open" })
  })
})

describe("panelContentWidth", () => {
  it("subtracts the border, the left padding and the trailing column", () => {
    expect(panelContentWidth(80)).toBe(75)
    expect(panelContentWidth(6)).toBe(1)
  })

  it("never goes negative for a collapsed or nonsensical panel width", () => {
    expect(panelContentWidth(5)).toBe(0)
    expect(panelContentWidth(0)).toBe(0)
    expect(panelContentWidth(-40)).toBe(0)
    expect(panelContentWidth(Number.NaN)).toBe(0)
  })
})

describe("panelColumns", () => {
  it("sizes the mock table for a 75-column panel without wasting a column", () => {
    const columns = panelColumns(75, mockRows())
    expect(columns).toEqual({ skill: 33, loads: 5, tokens: 6, bar: 24, percent: 4 })
    expect(renderedWidth(columns)).toBe(75)
  })

  it("grows the bar with the panel up to its cap and gives the rest to the name", () => {
    const narrow = panelColumns(60, mockRows())
    const wide = panelColumns(200, mockRows())
    expect(narrow.bar).toBe(24)
    expect(wide.bar).toBe(narrow.bar)
    expect(wide.skill).toBeGreaterThan(narrow.skill)
    expect(renderedWidth(wide)).toBe(200)
  })

  it("drops the bar rather than pushing the percentage off a narrow panel", () => {
    const columns = panelColumns(20, mockRows())
    expect(columns).toEqual({ skill: 2, loads: 5, tokens: 6, bar: 0, percent: 4 })
    expect(renderedWidth(columns)).toBe(20)
  })

  it("keeps the bar as long as the name still fits its floor", () => {
    const withBar = panelColumns(29, mockRows())
    const withoutBar = panelColumns(28, mockRows())
    expect(withBar.bar).toBe(1)
    expect(withoutBar.bar).toBe(0)
    expect(renderedWidth(withBar)).toBe(29)
    expect(renderedWidth(withoutBar)).toBe(28)
  })

  it("widens the numeric columns to their widest value", () => {
    const columns = panelColumns(75, [{ skillID: "a", loads: 1_234_567, tokens: 5_000_000_000, share: 1 }])
    expect(columns.loads).toBe("1234567".length)
    expect(columns.tokens).toBe(Math.max("Tokens".length, "5000M".length))
  })

  it("never returns a negative column and fits the width at every size", () => {
    const rows = mockRows()
    for (const width of [18, 19, 20, 30, 45, 80, 137, 400]) {
      const columns = panelColumns(width, rows)
      for (const value of Object.values(columns)) expect(value).toBeGreaterThanOrEqual(0)
      expect(renderedWidth(columns)).toBeLessThanOrEqual(width)
    }
  })

  it("collapses to the header widths when there is no room for content", () => {
    const columns = panelColumns(0, [])
    expect(columns).toEqual({ skill: 0, loads: 5, tokens: 6, bar: 0, percent: 0 })
    expect(panelColumns(Number.NaN, mockRows()).percent).toBe(0)
  })
})

describe("panelRowCells", () => {
  it("lays the mock's first row out cell by cell", () => {
    const columns = panelColumns(75, mockRows())
    expect(panelRowCells(mockRows()[0]!, columns)).toEqual({
      skill: "brainstorming",
      loads: "   12",
      tokens: " 45.2k",
      filled: "█".repeat(9),
      empty: "░".repeat(15),
      percent: " 37%",
    })
  })

  it("always fills the whole bar column", () => {
    const columns = panelColumns(75, mockRows())
    for (const row of mockRows()) {
      const cells = panelRowCells(row, columns)
      expect(cells.filled.length + cells.empty.length).toBe(columns.bar)
      expect(cells.filled.length).toBe(Math.round(row.share * columns.bar))
    }
  })

  it("renders an empty bar when the panel is too narrow for one", () => {
    const cells = panelRowCells(mockRows()[0]!, panelColumns(20, mockRows()))
    expect(cells.filled).toBe("")
    expect(cells.empty).toBe("")
    expect(cells.percent).toBe(" 37%")
  })

  it("clips a skill name that overflows its column instead of reflowing the row", () => {
    const columns = panelColumns(29, mockRows())
    expect(columns.skill).toBe(10)
    const cells = panelRowCells(mockRows()[1]!, columns)
    expect(cells.skill).toBe("systemati…")
    expect(cells.skill).toHaveLength(10)
  })

  it("right-aligns single-digit percentages inside the percent column", () => {
    const cells = panelRowCells({ skillID: "a", loads: 1, tokens: 1, share: 0.05 }, panelColumns(75, []))
    expect(cells.percent).toBe("  5%")
    expect(cells.percent).toHaveLength(4)
  })

  it("drops the name entirely when the column collapses to zero", () => {
    const cells = panelRowCells(mockRows()[0]!, panelColumns(0, []))
    expect(cells.skill).toBe("")
    expect(cells.tokens).toBe(" 45.2k")
  })
})

describe("panelHeaderCells", () => {
  it("labels the bar column only when there is a bar", () => {
    expect(panelHeaderCells(panelColumns(75, mockRows()))).toEqual({
      skill: "Skill".padEnd(33),
      loads: "Loads",
      tokens: "Tokens",
      filled: "Share",
      empty: "",
      percent: "",
    })
    expect(panelHeaderCells(panelColumns(20, mockRows())).filled).toBe("")
  })
})

describe("panelTotalLine", () => {
  it("formats the totals the server sent", () => {
    expect(panelTotalLine({ skills: 9, loads: 34, tokens: 120_400 })).toBe(
      "Total: 120.4k tokens · 34 loads · 9 skills",
    )
  })

  it("reports every skill, not only the rows the panel is showing", () => {
    // `topN` caps the rows; the summary must still say 9 skills.
    expect(panelTotalLine({ skills: 9, loads: 34, tokens: 120_400 })).toContain("9 skills")
    expect(mockRows()).toHaveLength(3)
  })
})

describe("panelTitle", () => {
  it("names the live metric and how it was derived", () => {
    expect(panelTitle("content")).toBe("Skill Token Usage — content (estimated from chars/4)")
    expect(panelTitle("spend")).toBe("Skill Token Usage — spend (approximate even-split attribution)")
  })
})

describe("describeError", () => {
  it("prefers an Error's message and falls back to the value's text", () => {
    expect(describeError(new Error("rpc.internal"))).toBe("rpc.internal")
    expect(describeError("plain")).toBe("plain")
  })
})
