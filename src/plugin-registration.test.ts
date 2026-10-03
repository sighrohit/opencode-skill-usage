import { createRenderEffect, createRoot, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import plugin, { rpcLocation, describeError } from "./tui.js"

type SetupContext = Parameters<(typeof plugin)["setup"]>[0]
type Cleanup = ReturnType<(typeof plugin)["setup"]>
type SlotClaim = Parameters<SetupContext["ui"]["slot"]>[0]

/**
 * The fields the TUI plugin's `setup` reads off the host context. A real
 * `Keymap` layer list is a Solid signal, so `layer()` writes it and
 * `commands()` reads it — that reactivity is the whole point of these tests.
 *
 * `layerCalls` is capped: a regression that re-registers on every invalidation
 * would otherwise spin forever and hang the suite instead of failing.
 */
function createCtx() {
  const slotClaims: SlotClaim[] = []
  const disposed: SlotClaim[] = []
  const layerCalls: Array<() => unknown> = []
  const toasts: unknown[] = []
  const [keymapTick, setKeymapTick] = createSignal(0)

  const ctx = {
    options: {},
    keymap: {
      layer: (input: () => unknown): void => {
        if (layerCalls.length > 50) throw new Error("runaway: keymap layer re-registered")
        layerCalls.push(input)
        setKeymapTick((tick) => tick + 1)
      },
      commands: (): unknown[] => {
        keymapTick()
        return []
      },
    },
    ui: {
      slot: (claim: SlotClaim): (() => void) => {
        slotClaims.push(claim)
        return () => void disposed.push(claim)
      },
      toast: { show: (options: unknown): void => void toasts.push(options) },
      panel: { open: (): boolean => true },
    },
    client: { rpc: (): unknown => ({ reset: async (): Promise<unknown> => ({}) }) },
  }

  return {
    // Context carries ~12 domains; setup reads six. Casting the double is cheaper
    // than restating domains the plugin never touches.
    ctx: ctx as unknown as SetupContext,
    slotClaims,
    disposed,
    layerCalls,
    toasts,
    /** Simulates any other part of the host touching its keymap state. */
    touchKeymap: (): void => {
      setKeymapTick((tick) => tick + 1)
    },
  }
}

/** The `app` slot claim, which is where the open command gets registered. */
function appSlot(h: ReturnType<typeof createCtx>): SlotClaim {
  const claim = h.slotClaims.find((claim) => (claim as { append?: string }).append === "app")
  if (!claim) throw new Error("setup did not claim the app slot")
  return claim
}

interface LayerCommand {
  id: string
  palette?: boolean
  title?: string
  slash?: { name: string; arguments?: boolean }
}

interface LayerConfig {
  mode: string
  commands: LayerCommand[]
}

/** Renders the app slot the way the host does: inside a reactive computation. */
function renderAppSlot(h: ReturnType<typeof createCtx>): number {
  let callsDuringRender = -1
  createRoot(() => {
    createRenderEffect(() => {
      appSlot(h).render({} as never)
      callsDuringRender = h.layerCalls.length
    })
  })
  return callsDuringRender
}

describe("keymap layer registration", () => {
  it("registers the layer during the app slot render", async () => {
    const h = createCtx()
    await plugin.setup(h.ctx)

    const callsDuringRender = renderAppSlot(h)

    // Registration is inline in `render`, matching the documented session-panel
    // recipe and the working `@tarquinen/opencode-dcp` plugin. Deferring it into
    // a child component's `onMount` produced a layer that never reached the
    // keymap: the command was missing from the command palette, so `/skill-usage`
    // silently resolved to the server's editor command and nothing opened.
    expect(callsDuringRender).toBe(1)
    expect(h.layerCalls).toHaveLength(1)
  })

  it("registers a global layer whose command opens the panel", async () => {
    const h = createCtx()
    await plugin.setup(h.ctx)

    renderAppSlot(h)

    const layer = h.layerCalls[0]!() as LayerConfig
    // Without "global" the layer defaults to mode "base" and is scoped to that
    // input mode, which is not where the palette dispatches from.
    expect(layer.mode).toBe("global")
    expect(layer.commands.map((command) => command.id)).toEqual(["skill-usage.open"])
    const command = layer.commands[0]!
    // `palette: true` AND `slash` together mirror the built-in `skills` command.
    expect(command.palette).toBe(true)
    expect(command.title).toBe("Skill token usage")
  })

  it("registers the slash name like the built-in /skills command", async () => {
    const h = createCtx()
    await plugin.setup(h.ctx)

    renderAppSlot(h)

    const layer = h.layerCalls[0]!() as LayerConfig
    // Mirrors the binary's built-in `skills` command: one keymap command with
    // `palette: true` AND `slash: { name: "skills", arguments: true }`. The server
    // editor command was deleted (see index.ts) so there is no collision.
    // `arguments: true` passes the raw prompt text to `run`; `parsePanelIntent`
    // handles empty / "content" / "spend" / "reset" tokens.
    expect(layer.commands[0]!.slash).toEqual({ name: "skill-usage", arguments: true })
  })

  it("does not re-register the layer when reactive keymap state changes", async () => {
    const h = createCtx()
    await plugin.setup(h.ctx)
    const app = appSlot(h)

    createRoot(() => {
      createRenderEffect(() => void app.render({} as never))
      h.touchKeymap()
    })

    // The invariant that matters: `render` registers a layer but must never *read*
    // reactive keymap state. A debug pass called `keymap.commands()` here, read
    // the signal `layer()` then writes, and self-invalidated without bound —
    // flooding the toast queue and tripping `Stale read from <Show>`.
    expect(h.layerCalls).toHaveLength(1)
  })

  it("shows no toast while rendering a slot", async () => {
    const h = createCtx()
    await plugin.setup(h.ctx)

    renderAppSlot(h)

    // Side effects in the slot render are what flooded the toast queue.
    expect(h.toasts).toEqual([])
  })

  it("disposes both slot claims on cleanup", async () => {
    const h = createCtx()
    const cleanup = (await plugin.setup(h.ctx)) as Cleanup

    expect(h.slotClaims).toHaveLength(2)
    expect(h.disposed).toEqual([])

    await (cleanup as () => void | Promise<void>)()

    expect(h.disposed).toEqual(h.slotClaims)
  })
})

describe("rpcLocation", () => {
  it("uses ctx.location when present", () => {
    const ctx = {
      location: "test-location-ref" as any,
      data: { location: { default: () => "fallback" } },
    } as any

    const result = rpcLocation(ctx)
    expect(result).toEqual({ location: "test-location-ref" })
  })

  it("falls back to ctx.data.location.default() when ctx.location is undefined", () => {
    const ctx = {
      location: undefined,
      data: { location: { default: () => "fallback-location" } },
    } as any

    const result = rpcLocation(ctx)
    expect(result).toEqual({ location: "fallback-location" })
  })
})

describe("describeError", () => {
  it("returns Error.message for Error instances", () => {
    expect(describeError(new Error("boom"))).toBe("boom")
  })

  it("unwraps message from plain objects (RPC Failure shape)", () => {
    expect(describeError({ type: "rpc.invalid_input", message: "bad arg", data: {} })).toBe("bad arg")
    expect(describeError({ message: "server said no" })).toBe("server said no")
  })

  it("falls back to String for other values", () => {
    expect(describeError("raw string")).toBe("raw string")
    expect(describeError(42)).toBe("42")
    expect(describeError(null)).toBe("null")
    expect(describeError(undefined)).toBe("undefined")
    // This is the bug that hid the real 400:
    expect(describeError({})).toBe("[object Object]")
  })
})
