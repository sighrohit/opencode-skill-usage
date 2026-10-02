import { renderMarkdown, toRows, totals } from "./chart.js"
import type { Tracker } from "./tracker.js"
import type { Metric, Options } from "./types.js"

/**
 * Structural subset of the `skill-usage` command invocation. The installed
 * `CommandInvocation` types `prompt` as `PromptInput.Prompt` — an object whose
 * `text` is required — so the argument text lives at `prompt.text`.
 */
export interface SkillUsageInvocation {
  readonly sessionID: string
  readonly prompt: { readonly text: string }
}

export interface SyntheticMessage {
  sessionID: string
  text: string
  /**
   * The server wakes the session on a synthetic message unless this is `false`,
   * which would start a model turn. The chart is a read-only rendering, so it
   * must not.
   */
  resume?: boolean
}

function metricFor(arg: string, options: Options): Metric {
  if (arg === "spend") return "spend"
  if (arg === "content") return "content"
  return options.defaultMetric
}

export function createCommandHandler(deps: {
  tracker: Tracker
  options: Options
  synthetic: (msg: SyntheticMessage) => Promise<unknown>
}): (invocation: SkillUsageInvocation) => Promise<void> {
  const { tracker, options, synthetic } = deps

  return async (invocation) => {
    const { sessionID } = invocation
    const arg = invocation.prompt.text.trim()

    if (arg === "reset") {
      await tracker.reset()
      await synthetic({ sessionID, text: "Skill usage stats cleared.", resume: false })
      return
    }

    const metric = metricFor(arg, options)
    const data = tracker.data()
    const rows = toRows(data, metric, options.topN)
    // Totals are computed from every skill, so pass them explicitly rather than
    // letting renderMarkdown sum the rounded, limited rows. The qualifier then
    // reports the same divisor the tracker actually divided by.
    const text = renderMarkdown(rows, metric, totals(rows, data, metric), options.charsPerToken)
    await synthetic({ sessionID, text, resume: false })
  }
}
