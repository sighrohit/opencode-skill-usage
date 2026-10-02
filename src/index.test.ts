import { describe, expect, it } from "vitest"
import plugin from "./index.js"
import { STORAGE_KEY } from "./store.js"

type SetupContext = Parameters<(typeof plugin)["setup"]>[0]
type Cleanup = ReturnType<(typeof plugin)["setup"]>
type SubscribeFn = (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>

/** The five fields `setup` actually reads off `Context`. The interface carries ~30. */
function createCtx(overrides: { subscribe: SubscribeFn }): {
  ctx: SetupContext
  storage: Map<string, unknown>
} {
  const storage = new Map<string, unknown>()
  const ctx = {
    options: {},
    storage: {
      get: async (key: string): Promise<unknown> => storage.get(key),
      set: async (key: string, value: unknown): Promise<void> => {
        storage.set(key, value)
      },
    },
    event: {
      // Synchronous, like the real `subscribe`, which returns the iterable itself.
      subscribe: (options?: unknown): AsyncIterable<unknown> =>
        overrides.subscribe(options as { signal?: AbortSignal } | undefined),
    },
    command: {
      transform: async (callback: (editor: { add: (definition: unknown) => void }) => void) => {
        callback({ add: () => {} })
        return { dispose: async () => {} }
      },
    },
    session: { synthetic: async () => undefined },
  }
  return {
    // Context is a ~30-domain interface; setup reads five. Casting the double is
    // cheaper than restating domains the plugin never touches.
    ctx: ctx as unknown as SetupContext,
    storage,
  }
}

/**
 * Models the SDK's stream contract: `subscribe` returns an async iterable whose
 * `return()` ends the consumer's `for await`, and an abort signal triggers it.
 */
function controllableEvents() {
  const queue: unknown[] = []
  const state = {
    subscribed: false,
    closed: false,
    returned: false,
    signal: undefined as AbortSignal | undefined,
  }
  let wake: (() => void) | undefined

  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (state.closed) return { done: true, value: undefined }
          if (queue.length > 0) return { done: false, value: queue.shift() }
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          if (state.closed) return { done: true, value: undefined }
          return { done: false, value: queue.shift() }
        },
        async return() {
          state.returned = true
          state.closed = true
          wake?.()
          return { done: true, value: undefined }
        },
      }
    },
  }

  return {
    state,
    // Mirrors the SDK's own makeStreams: an abort signal closes the iterator,
    // which is what ends the consumer's `for await`.
    subscribe: (options?: { signal?: AbortSignal }): AsyncIterable<unknown> => {
      state.subscribed = true
      state.signal = options?.signal
      const close = () => {
        state.returned = true
        state.closed = true
        wake?.()
        wake = undefined
      }
      options?.signal?.addEventListener("abort", close, { once: true })
      return iterable
    },
    push(value: unknown): void {
      queue.push(value)
      wake?.()
      wake = undefined
    },
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function skillActivated(sessionID: string, id: string, text: string) {
  return { type: "session.skill.activated", data: { sessionID, id, name: id, text } }
}

function recordedSkills(storage: Map<string, unknown>): string[] {
  const raw = storage.get(STORAGE_KEY)
  if (typeof raw !== "object" || raw === null) return []
  return Object.keys((raw as { skills?: object }).skills ?? {})
}

describe("setup teardown", () => {
  it("aborts the event loop on cleanup and stops recording", async () => {
    const events = controllableEvents()
    const { ctx, storage } = createCtx({ subscribe: events.subscribe })

    const cleanup = (await plugin.setup(ctx)) as Cleanup
    expect(typeof cleanup).toBe("function")

    events.push(skillActivated("ses_1", "alpha", "x".repeat(400)))
    await waitFor(() => recordedSkills(storage).length === 1, "first event to be recorded")
    expect(recordedSkills(storage)).toEqual(["alpha"])

    await (cleanup as () => void | Promise<void>)()

    // The signal handed to subscribe is the one the cleanup aborts.
    expect(events.state.closed).toBe(true)
    await waitFor(() => events.state.returned, "iterator return() after abort")

    events.push(skillActivated("ses_1", "beta", "y".repeat(400)))
    // Give the loop every chance to pick the event up.
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(recordedSkills(storage)).toEqual(["alpha"])
  })

  it("passes a live abort signal into subscribe and aborts it on cleanup", async () => {
    const events = controllableEvents()
    const { ctx } = createCtx({ subscribe: events.subscribe })

    const cleanup = (await plugin.setup(ctx)) as Cleanup
    await waitFor(() => events.state.subscribed, "subscribe to be called")

    // The plugin's own signal, live at subscription time — not a pre-aborted one.
    expect(events.state.signal).toBeInstanceOf(AbortSignal)
    expect(events.state.signal?.aborted).toBe(false)

    await (cleanup as () => void | Promise<void>)()

    expect(events.state.signal?.aborted).toBe(true)
    await waitFor(() => events.state.closed, "abort to close the stream")
    expect(events.state.returned).toBe(true)
  })
})
