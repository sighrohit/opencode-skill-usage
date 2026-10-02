import { describe, expect, it } from "vitest"
import { DEFAULT_OPTIONS, emptyData, parseOptions } from "./types.js"

describe("parseOptions", () => {
  it("parses defaults from empty input", () => {
    expect(DEFAULT_OPTIONS).toEqual({ topN: 15, charsPerToken: 4, defaultMetric: "content" })
    expect(parseOptions(undefined)).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions({})).toEqual(DEFAULT_OPTIONS)
  })

  it("clamps and validates", () => {
    expect(parseOptions({ topN: 0, charsPerToken: -3, defaultMetric: "bogus" })).toEqual({
      topN: 1,
      charsPerToken: 1,
      defaultMetric: "content",
    })
    expect(parseOptions({ topN: 5, charsPerToken: 3.7, defaultMetric: "spend" })).toEqual({
      topN: 5,
      charsPerToken: 3.7,
      defaultMetric: "spend",
    })
  })
  it("rejects non-object and non-finite input", () => {
    expect(parseOptions(null)).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions("topN")).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions(42)).toEqual(DEFAULT_OPTIONS)
    expect(parseOptions({ topN: NaN, charsPerToken: Infinity })).toEqual(DEFAULT_OPTIONS)
  })
})

describe("emptyData", () => {
  it("emptyData has version 1 and no skills", () => {
    expect(emptyData()).toEqual({ version: 1, skills: {} })
  })
})
