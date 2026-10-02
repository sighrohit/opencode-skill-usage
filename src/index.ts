import { Plugin } from "@opencode/plugin"
import { createCommandHandler } from "./command.js"
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
    const tracker = await createTracker({ store, charsPerToken: options.charsPerToken })

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
    void (async () => {
      for await (const event of ctx.event.subscribe()) {
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
  },
})
