import { describe, expect, it, vi } from "vitest"
import { emptySkillStats, type UsageData } from "./types.js"
import { createPluginStore, type Store } from "./store.js"
import { createTracker } from "./tracker.js"

// Mirrors the Map-backed fake from src/store.test.ts, but serializes on write so
// that a second tracker instance can only see data that was really persisted.
function createFakeStorage() {
  const map = new Map<string, string>()
  return {
    map,
    storage: {
      get: async (key: string): Promise<unknown> => {
        const raw = map.get(key)
        return raw === undefined ? undefined : JSON.parse(raw)
      },
      set: async (key: string, value: unknown): Promise<void> => {
        map.set(key, JSON.stringify(value))
      },
    },
  }
}

function fixedNow() {
  return new Date("2026-10-02T12:00:00Z")
}

async function createTestTracker(
  store: Store,
  overrides: { onChange?: () => void } = {},
) {
  return createTracker({ store, charsPerToken: 4, now: fixedNow, ...overrides })
}

function text(length: number) {
  return "x".repeat(length)
}

describe("emptySkillStats shape", () => {
  // The tracker reads spend keys by name; a typo in the factory would be silent.
  it("has exactly the five spend keys and a string lastUsed", () => {
    expect(emptySkillStats()).toEqual({
      loads: 0,
      contentTokens: 0,
      spend: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      lastUsed: expect.any(String),
    })
  })
})

describe("createTracker", () => {
  it("estimates content tokens and counts loads", async () => {
    const { storage } = createFakeStorage()
    const tracker = await createTestTracker(createPluginStore(storage))

    await tracker.handleSkillActivated({ sessionID: "s1", id: "alpha", text: text(100) })

    expect(tracker.data().skills["alpha"]).toEqual({
      loads: 1,
      contentTokens: 25,
      spend: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      lastUsed: "2026-10-02T12:00:00.000Z",
    })
  })

  it("accumulates across loads and skills", async () => {
    const { storage } = createFakeStorage()
    const tracker = await createTestTracker(createPluginStore(storage))

    await tracker.handleSkillActivated({ sessionID: "s1", id: "alpha", text: text(100) })
    await tracker.handleSkillActivated({ sessionID: "s1", id: "alpha", text: text(40) })
    await tracker.handleSkillActivated({ sessionID: "s2", id: "beta", text: text(200) })

    const data = tracker.data()
    expect(data.skills["alpha"].loads).toBe(2)
    expect(data.skills["alpha"].contentTokens).toBe(35)
    expect(data.skills["beta"].loads).toBe(1)
    expect(data.skills["beta"].contentTokens).toBe(50)
    expect(Object.keys(data.skills).sort()).toEqual(["alpha", "beta"])
  })

  it("splits step usage evenly across the session's loaded skills", async () => {
    const { storage } = createFakeStorage()
    const tracker = await createTestTracker(createPluginStore(storage))

    await tracker.handleSkillActivated({ sessionID: "s1", id: "a", text: text(40) })
    await tracker.handleSkillActivated({ sessionID: "s1", id: "b", text: text(40) })
    await tracker.handleStepEnded({
      sessionID: "s1",
      tokens: { input: 100, output: 10, cache: { read: 40 } },
    })

    const expected = { input: 50, output: 5, reasoning: 0, cacheRead: 20, cacheWrite: 0 }
    for (const id of ["a", "b"]) {
      const spend = tracker.data().skills[id].spend
      expect(spend.input).toBeCloseTo(expected.input)
      expect(spend.output).toBeCloseTo(expected.output)
      expect(spend.reasoning).toBeCloseTo(expected.reasoning)
      expect(spend.cacheRead).toBeCloseTo(expected.cacheRead)
      expect(spend.cacheWrite).toBeCloseTo(expected.cacheWrite)
    }
  })

  it("only charges the session that loaded the skills", async () => {
    const { storage } = createFakeStorage()
    const tracker = await createTestTracker(createPluginStore(storage))

    await tracker.handleSkillActivated({ sessionID: "s1", id: "a", text: text(40) })
    await tracker.handleSkillActivated({ sessionID: "s2", id: "b", text: text(40) })
    await tracker.handleStepEnded({ sessionID: "s1", tokens: { input: 100 } })

    expect(tracker.data().skills["a"].spend.input).toBeCloseTo(100)
    expect(tracker.data().skills["b"].spend.input).toBeCloseTo(0)
  })

  it("ignores step events for sessions with no skills", async () => {
    const { storage } = createFakeStorage()
    const tracker = await createTestTracker(createPluginStore(storage))
    const before = tracker.data()

    await tracker.handleStepEnded({ sessionID: "unknown", tokens: { input: 500, output: 50 } })

    expect(tracker.data()).toBe(before)
    expect(tracker.data()).toEqual({ version: 1, skills: {} })
  })

  it("treats missing token fields as zero", async () => {
    const { storage } = createFakeStorage()
    const tracker = await createTestTracker(createPluginStore(storage))

    await tracker.handleSkillActivated({ sessionID: "s1", id: "a", text: text(40) })
    await tracker.handleStepEnded({ sessionID: "s1", tokens: {} })

    expect(tracker.data().skills["a"].spend).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it("does not flush or fire onChange when a step event is ignored", async () => {
    const { storage } = createFakeStorage()
    const store = createPluginStore(storage)
    const onChange = vi.fn()
    const saveSpy = vi.spyOn(store, "save")
    const tracker = await createTestTracker(store, { onChange })

    await tracker.handleStepEnded({ sessionID: "ghost", tokens: { input: 1 } })

    expect(saveSpy).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it("calls onChange after every successful flush", async () => {
    const { storage } = createFakeStorage()
    const onChange = vi.fn()
    const tracker = await createTestTracker(createPluginStore(storage), { onChange })

    await tracker.handleSkillActivated({ sessionID: "s1", id: "a", text: text(40) })
    expect(onChange).toHaveBeenCalledTimes(1)

    await tracker.handleStepEnded({ sessionID: "s1", tokens: { input: 10 } })
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("updates lastUsed on step events", async () => {
    const { storage } = createFakeStorage()
    let current = new Date("2026-01-01T00:00:00Z")
    const tracker = await createTracker({
      store: createPluginStore(storage),
      charsPerToken: 4,
      now: () => current,
    })

    await tracker.handleSkillActivated({ sessionID: "s1", id: "a", text: text(40) })
    expect(tracker.data().skills["a"].lastUsed).toBe("2026-01-01T00:00:00.000Z")

    current = new Date("2026-10-02T12:00:00Z")
    await tracker.handleStepEnded({ sessionID: "s1", tokens: { input: 10 } })
    expect(tracker.data().skills["a"].lastUsed).toBe("2026-10-02T12:00:00.000Z")
  })

  it("persists across tracker instances (reload from store)", async () => {
    const { storage } = createFakeStorage()
    const first = await createTestTracker(createPluginStore(storage))
    await first.handleSkillActivated({ sessionID: "s1", id: "alpha", text: text(100) })
    await first.handleStepEnded({ sessionID: "s1", tokens: { input: 60, cache: { write: 8 } } })

    const second = await createTestTracker(createPluginStore(storage))
    expect(second.data()).toEqual(first.data())
    expect(second.data().skills["alpha"].spend.input).toBeCloseTo(60)
    expect(second.data().skills["alpha"].spend.cacheWrite).toBeCloseTo(8)
  })

  it("two sequential step events both land (no lost update)", async () => {
    const { storage } = createFakeStorage()
    const store = createPluginStore(storage)
    const tracker = await createTestTracker(store)

    await tracker.handleSkillActivated({ sessionID: "s1", id: "a", text: text(40) })
    await tracker.handleStepEnded({ sessionID: "s1", tokens: { input: 100 } })
    await tracker.handleStepEnded({ sessionID: "s1", tokens: { output: 50 } })

    expect(tracker.data().skills["a"].spend.input).toBeCloseTo(100)
    expect(tracker.data().skills["a"].spend.output).toBeCloseTo(50)

    // A fresh instance proves both writes reached the store, not just memory.
    const reloaded = await createTestTracker(createPluginStore(storage))
    expect(reloaded.data().skills["a"].spend.input).toBeCloseTo(100)
    expect(reloaded.data().skills["a"].spend.output).toBeCloseTo(50)
  })

  it("reset clears and persists empty data", async () => {
    const { storage } = createFakeStorage()
    const tracker = await createTestTracker(createPluginStore(storage))
    await tracker.handleSkillActivated({ sessionID: "s1", id: "alpha", text: text(100) })

    await tracker.reset()

    expect(tracker.data()).toEqual({ version: 1, skills: {} })
    const reloaded = await createTestTracker(createPluginStore(storage))
    expect(reloaded.data()).toEqual({ version: 1, skills: {} })
  })

  it("data() is synchronous and returns the in-memory copy", async () => {
    const { storage } = createFakeStorage()
    const tracker = await createTestTracker(createPluginStore(storage))
    await tracker.handleSkillActivated({ sessionID: "s1", id: "alpha", text: text(40) })

    const first = tracker.data()
    expect(first).not.toBeInstanceOf(Promise)
    expect(tracker.data()).toBe(first)
  })

  it("round-trips through JSON without losing fields", async () => {
    const { storage } = createFakeStorage()
    const tracker = await createTestTracker(createPluginStore(storage))
    await tracker.handleSkillActivated({ sessionID: "s1", id: "alpha", text: text(100) })
    await tracker.handleStepEnded({ sessionID: "s1", tokens: { reasoning: 7, cache: { read: 3 } } })

    const asJson = JSON.parse(JSON.stringify(tracker.data())) as UsageData
    expect(asJson).toEqual(tracker.data())
  })
})
