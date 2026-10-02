import { Plugin } from "@opencode/plugin"
import { createCommandHandler } from "./command.js"
import { createSkillUsageHandlers, SkillUsage } from "./rpc.js"
import { createPluginStore } from "./store.js"
import { createTracker } from "./tracker.js"
import { parseOptions } from "./types.js"

export default Plugin.define({
  id: "opencode-skill-usage",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    // ctx.storage is backed by the server's single global `kv` table, namespaced
    // per plugin id, so usage stats are shared across every project.
    const store = createPluginStore(ctx.storage)

    // `createTracker` needs `onChange` but the emitter it feeds comes back from
    // `register` below, so the tracker is wired to a late-bound slot. Nothing
    // can flush before registration resolves: the only mutation paths are the
    // command and the event loop, both started after it.
    let emitUpdated: () => void = () => {}
    const tracker = await createTracker({
      store,
      charsPerToken: options.charsPerToken,
      onChange: () => emitUpdated(),
    })

    const registration = await ctx.rpc.register(
      SkillUsage,
      createSkillUsageHandlers({ tracker, options }),
    )
    // `emit` is async and `onChange` is not, so the rejection is absorbed here
    // rather than surfacing as an unhandled promise from inside the tracker's
    // synchronous flush.
    emitUpdated = () => {
      void registration.events.emit("updated", {}).catch((error: unknown) => {
        console.error("opencode-skill-usage: failed to emit updated", error)
      })
    }

    await ctx.command.transform((editor) =>
      editor.add({
        name: "skill-usage",
        description: "Show per-skill token usage chart",
        // Wrapped rather than passed by reference so it never depends on `this`.
        execute: createCommandHandler({
          tracker,
          options,
          synthetic: (msg) => ctx.session.synthetic(msg),
        }),
      }),
    )

    // Detached: `setup` is awaited by the host, and the event stream never ends,
    // so awaiting it here would deadlock plugin load. Per-event errors are caught
    // so one malformed event cannot end collection.
    const abort = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        try {
          if (event.type === "session.skill.activated") {
            const { sessionID, id, text } = event.data
            await tracker.handleSkillActivated({ sessionID, id, text })
          } else if (event.type === "session.step.ended") {
            const { sessionID, tokens } = event.data
            await tracker.handleStepEnded({ sessionID, tokens })
          }
        } catch (error) {
          console.error(`opencode-skill-usage: failed to handle ${event.type}`, error)
        }
      }
    })().catch((error: unknown) => {
      console.error("opencode-skill-usage: event stream ended", error)
    })

    // Host-disposable: without this, a re-run of `setup` leaves the old loop
    // subscribed and writing through its own tracker into the same stored row.
    return () => {
      abort.abort()
      // Same reason: a stale registration would keep serving the previous
      // generation's handlers and emitting into it.
      emitUpdated = () => {}
      return registration.dispose()
    }
  },
})
