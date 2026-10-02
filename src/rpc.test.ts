import { describe, expect, it } from "vitest"
import { z } from "zod"
import plugin from "./index.js"
import { createSkillUsageHandlers, SkillUsage } from "./rpc.js"
import { createTracker } from "./tracker.js"
import type { Store } from "./store.js"
import { DEFAULT_OPTIONS, emptyData, type Options } from "./types.js"

type SetupContext = Parameters<(typeof plugin)["setup"]>[0]
type Handlers = ReturnType<typeof createSkillUsageHandlers>
type RegisterCapture = {
  definition: { id: string; events: Record<string, unknown> }
  handlers: Handlers
  emitted: Array<{ name: string; data: unknown }>
}

/** The handler context the host supplies; `error` is unreachable (no method declares errors). */
const CALL_CONTEXT = {
  signal: new AbortController().signal,
  error: (): never => {
    throw new Error("no method in SkillUsage declares errors")
  },
}

function memoryStore(): Store {
  let data = emptyData()
  return {
    load: async () => data,
    save: async (next) => {
      data = next
    },
  }
}

function text(length: number): string {
  return "x".repeat(length)
}

function options(overrides: Partial<Options> = {}): Options {
  return { ...DEFAULT_OPTIONS, ...overrides }
}

/**
 * Three skills whose content ranking and spend ranking are genuinely different
 * orders, so a handler that ignored `metric` would fail:
 *   content: alpha 300 > gamma 200 > beta 100
 *   spend:   beta 2000 > alpha 500 = gamma 500, and alpha wins that tie on skillID
 * Alpha and gamma share ses_1, so the tracker's even split gives them identical
 * spend and the tiebreak alone decides their order.
 */
async function rankedTracker() {
  const tracker = await createTracker({ store: memoryStore(), charsPerToken: 4 })
  await tracker.handleSkillActivated({ sessionID: "ses_1", id: "alpha", text: text(1200) })
  await tracker.handleSkillActivated({ sessionID: "ses_1", id: "gamma", text: text(800) })
  await tracker.handleSkillActivated({ sessionID: "ses_2", id: "beta", text: text(400) })
  await tracker.handleStepEnded({ sessionID: "ses_1", tokens: { input: 1000 } })
  await tracker.handleStepEnded({ sessionID: "ses_2", tokens: { input: 2000 } })
  return tracker
}

async function handlersFor(tracker: Awaited<ReturnType<typeof createTracker>>, opts = options()) {
  return createSkillUsageHandlers({ tracker, options: opts })
}

/**
 * A `Context` carrying only the fields `setup` reads, with `rpc.register`
 * capturing the definition, the handlers, and every emit.
 */
async function setupWithRpc() {
  const storage = new Map<string, unknown>()
  const captured: RegisterCapture[] = []

  const ctx = {
    options: {},
    storage: {
      get: async (key: string): Promise<unknown> => storage.get(key),
      set: async (key: string, value: unknown): Promise<void> => {
        storage.set(key, value)
      },
    },
    event: {
      subscribe: (): AsyncIterable<unknown> => ({
        async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
          await new Promise<void>(() => {})
        },
      }),
    },
    command: {
      transform: async (callback: (editor: { add: (definition: unknown) => void }) => void) => {
        callback({ add: () => {} })
        return { dispose: async () => {} }
      },
    },
    session: { synthetic: async () => undefined },
    rpc: {
      register: async (
        definition: RegisterCapture["definition"],
        registered: Handlers,
      ): Promise<{
        dispose: () => Promise<void>
        events: { emit: (...args: [string, unknown]) => Promise<void> }
      }> => {
        const record = captured.push({ definition, handlers: registered, emitted: [] }) - 1
        return {
          dispose: async () => {},
          events: {
            // `Rpc.EventInput` is a union of `[name, data]` tuples, so the real
            // emitter is called positionally — mirror that shape here.
            emit: async (...args: [string, unknown]): Promise<void> => {
              captured[record]!.emitted.push({ name: args[0], data: args[1] })
            },
          },
        }
      },
    },
  }

  // Context is a ~30-domain interface; setup reads six.
  await plugin.setup(ctx as unknown as SetupContext)
  const record = captured[0]
  if (!record) throw new Error("setup did not register the SkillUsage contract")
  return record
}

describe("SkillUsage contract", () => {
  it("declares the wire id the event type is derived from", () => {
    expect(SkillUsage.id).toBe("skill-usage")
    expect(Object.keys(SkillUsage.events)).toEqual(["updated"])
    expect(Object.keys(SkillUsage.methods)).toEqual(["stats", "reset"])
  })

  it("accepts the real handler payloads through the declared wire schemas", async () => {
    const handlers = await handlersFor(await rankedTracker())

    // The host validates handler output against these schemas. Parsing here
    // proves the contract and the handlers agree, which a type-level check
    // alone cannot: zod runs at runtime and could reject a value TS allows.
    const stats = await handlers.stats({ metric: "spend", limit: 2 }, CALL_CONTEXT)
    const parsed = await z.parse(SkillUsage.methods.stats.output, stats)
    expect(parsed.rows.map((row) => row.skillID)).toEqual(["beta", "alpha"])
    expect(parsed.totals).toEqual(stats.totals)

    expect(await z.parse(SkillUsage.methods.reset.output, await handlers.reset({}, CALL_CONTEXT))).toEqual({
      ok: true,
    })
    expect(await z.parse(SkillUsage.events.updated.schema, {})).toEqual({})
  })
})

describe("skill-usage stats handler", () => {
  it("returns rows sorted descending with global totals", async () => {
    const handlers = await handlersFor(await rankedTracker())

    const result = await handlers.stats({}, CALL_CONTEXT)

    expect(result.rows.map((row) => row.skillID)).toEqual(["alpha", "gamma", "beta"])
    expect(result.rows.map((row) => row.tokens)).toEqual([300, 200, 100])
    expect(result.totals).toEqual({ skills: 3, loads: 3, tokens: 600 })
    // Share is a raw proportion, so the three rows still add up to the total.
    expect(result.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1)
  })

  it("honours an explicit metric and limit, keeping totals global", async () => {
    const handlers = await handlersFor(await rankedTracker())

    const spend = await handlers.stats({ metric: "spend" }, CALL_CONTEXT)

    // A different order from the content ranking above, which a metric-blind
    // handler could not produce.
    expect(spend.rows.map((row) => row.skillID)).toEqual(["beta", "alpha", "gamma"])
    expect(spend.rows.map((row) => row.tokens)).toEqual([2000, 500, 500])
    expect(spend.totals).toEqual({ skills: 3, loads: 3, tokens: 3000 })

    const limited = await handlers.stats({ metric: "spend", limit: 2 }, CALL_CONTEXT)
    expect(limited.rows.map((row) => row.skillID)).toEqual(["beta", "alpha"])
    // Limited rows, global totals.
    expect(limited.totals).toEqual({ skills: 3, loads: 3, tokens: 3000 })
  })

  it("falls back to the parsed plugin options when input omits metric and limit", async () => {
    const handlers = await handlersFor(await rankedTracker(), options({ defaultMetric: "spend", topN: 1 }))

    const result = await handlers.stats({}, CALL_CONTEXT)

    expect(result.rows.map((row) => row.skillID)).toEqual(["beta"])
    expect(result.rows[0]!.tokens).toBe(2000)
    expect(result.totals.tokens).toBe(3000)
  })
})

describe("skill-usage reset handler", () => {
  it("clears the tracker and returns ok", async () => {
    const tracker = await rankedTracker()
    const handlers = await handlersFor(tracker)

    expect(tracker.data().skills).toHaveProperty("alpha")

    const result = await handlers.reset({}, CALL_CONTEXT)

    expect(result).toEqual({ ok: true })
    expect(Object.keys(tracker.data().skills)).toEqual([])

    const after = await handlers.stats({}, CALL_CONTEXT)
    expect(after.rows).toEqual([])
    expect(after.totals).toEqual({ skills: 0, loads: 0, tokens: 0 })
  })
})

describe("SkillUsage registration", () => {
  it("registers the shared contract and emits updated on every tracker flush", async () => {
    const { definition, handlers, emitted } = await setupWithRpc()
    expect(definition.id).toBe("skill-usage")
    expect(Object.keys(definition.events)).toEqual(["updated"])

    await handlers.reset({}, CALL_CONTEXT)
    expect(emitted).toEqual([{ name: "updated", data: {} }])

    // `handlers.reset` emits nothing itself: the single emit above came from
    // `tracker.reset()`'s flush, which is why exactly one is asserted. A
    // following stats call must not add another.
    const before = emitted.length
    await handlers.stats({}, CALL_CONTEXT)
    expect(emitted).toHaveLength(before)
  })
})
