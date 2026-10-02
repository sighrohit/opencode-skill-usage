import { describe, expect, it } from "vitest"
import { createCommandHandler, type SyntheticMessage } from "./command.js"
import { createTracker } from "./tracker.js"
import type { Store } from "./store.js"
import { DEFAULT_OPTIONS, emptyData, type Options } from "./types.js"

function memoryStore(): Store {
  let data = emptyData()
  return {
    load: async () => data,
    save: async (next) => {
      data = next
    },
  }
}

async function fakeTracker() {
  return createTracker({ store: memoryStore(), charsPerToken: 4 })
}

function recorder() {
  const sent: SyntheticMessage[] = []
  return {
    sent,
    synthetic: async (msg: SyntheticMessage): Promise<unknown> => {
      sent.push(msg)
      return undefined
    },
  }
}

function text(length: number): string {
  return "x".repeat(length)
}

/** Two skills with distinct content totals so the descending order is observable. */
async function loadedTracker() {
  const tracker = await fakeTracker()
  await tracker.handleSkillActivated({ sessionID: "ses_1", id: "alpha", text: text(1200) })
  await tracker.handleSkillActivated({ sessionID: "ses_1", id: "beta", text: text(400) })
  return tracker
}

function invoke(prompt = "") {
  return { sessionID: "ses_1", prompt: { text: prompt } }
}

function options(overrides: Partial<Options> = {}): Options {
  return { ...DEFAULT_OPTIONS, ...overrides }
}

describe("createCommandHandler", () => {
  it("renders default metric into a synthetic message", async () => {
    const tracker = await loadedTracker()
    const { sent, synthetic } = recorder()
    const handler = createCommandHandler({ tracker, options: options(), synthetic })

    await handler(invoke())

    expect(sent).toHaveLength(1)
    const message = sent[0]!
    expect(message.sessionID).toBe("ses_1")
    expect(message.text).toContain("| Skill | Loads | Tokens | Share |")
    // Descending by the active metric: alpha has 300 content tokens, beta has 100.
    expect(message.text.indexOf("| alpha |")).toBeLessThan(message.text.indexOf("| beta |"))
    expect(message.text).toContain("content (estimated from chars/4)")
    expect(message.text).toContain("**Total:** 400 tokens")
    // The message must be delivered without waking the agent loop.
    expect(message.resume).toBe(false)
  })

  it("prompt arg 'spend' switches the metric header", async () => {
    const tracker = await loadedTracker()
    await tracker.handleStepEnded({
      sessionID: "ses_1",
      tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const { sent, synthetic } = recorder()
    const handler = createCommandHandler({ tracker, options: options(), synthetic })

    await handler(invoke("spend"))

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain("session spend")
    expect(sent[0]!.text).not.toContain("content (estimated from chars/4)")
  })

  it("falls through to defaultMetric for an unrecognised arg", async () => {
    const tracker = await loadedTracker()
    const { sent, synthetic } = recorder()
    const handler = createCommandHandler({
      tracker,
      options: options({ defaultMetric: "spend" }),
      synthetic,
    })

    await handler(invoke("nonsense"))

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain("session spend")
  })

  it("honours topN by limiting the rendered rows", async () => {
    const tracker = await loadedTracker()
    const { sent, synthetic } = recorder()
    const handler = createCommandHandler({ tracker, options: options({ topN: 1 }), synthetic })

    await handler(invoke())

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain("| alpha |")
    expect(sent[0]!.text).not.toContain("| beta |")
    // totals cover every skill, not just the limited rows.
    expect(sent[0]!.text).toContain("2 skills")
  })

  it("prompt arg 'reset' clears stats and confirms instead of charting", async () => {
    const tracker = await loadedTracker()
    const { sent, synthetic } = recorder()
    const handler = createCommandHandler({ tracker, options: options(), synthetic })

    await handler(invoke("reset"))

    expect(sent).toHaveLength(1)
    expect(sent[0]!.sessionID).toBe("ses_1")
    expect(sent[0]!.text).not.toContain("| Skill | Loads | Tokens | Share |")
    expect(Object.keys(tracker.data().skills)).toEqual([])

    await handler(invoke())
    expect(sent[1]!.text).toContain("_No skill usage recorded yet._")
  })
})
