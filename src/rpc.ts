import { Rpc } from "@opencode/plugin"
import type { RpcHandlers } from "@opencode/plugin/promise/rpc"
// One zod instance in the whole tree: `package.json` pins `zod` to exactly
// 4.1.8 and repeats it under `overrides`, matching `@opencode/plugin`'s own
// dependency. The schemas below cross the server/TUI boundary, where a second
// zod copy would fail the SDK's schema identity checks at runtime. Bump the pin
// in `dependencies` and `overrides` in lockstep with the SDK.
import { z } from "zod"
import { toRows, totals } from "./chart.js"
import type { Tracker } from "./tracker.js"
import type { Options, Row, Totals } from "./types.js"

// Wire mirror of `Row` / `Totals` from `types.ts`. Those interfaces stay
// canonical for the type names; these schemas only describe the same shapes on
// the wire. The `z.ZodType<T, T>` annotations make the two adjacent: a field
// added to either without the other fails to compile here rather than silently
// drifting at runtime. Both type parameters are pinned because `Rpc` derives a
// handler's return type from a schema's *input* side — leaving `Input` at its
// `unknown` default would erase the shape.
const RowSchema: z.ZodType<Row, Row> = z.object({
  skillID: z.string(),
  loads: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
})

const TotalsSchema: z.ZodType<Totals, Totals> = z.object({
  skills: z.number().int().nonnegative(),
  loads: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
})

const StatsInputSchema = z.object({
  metric: z.enum(["content", "spend"]).optional(),
  limit: z.number().int().positive().optional(),
})

const StatsOutputSchema = z.object({
  rows: z.array(RowSchema),
  totals: TotalsSchema,
})

const ResetOutputSchema = z.object({ ok: z.literal(true) })

/**
 * The single contract, imported by both `index.ts` (server) and `tui.tsx` (TUI).
 * `Rpc.define` rejects reserved `rpc.`-prefixed error names and returns the
 * definition unchanged; `ctx.rpc.register` and `client.rpc(…)` both consume it
 * as-is, so neither side can drift from the other.
 */
export const SkillUsage = Rpc.define({
  id: "skill-usage",
  methods: {
    stats: { input: StatsInputSchema, output: StatsOutputSchema },
    reset: { input: z.object({}), output: ResetOutputSchema },
  },
  events: { updated: { schema: z.object({}) } },
})

export type SkillUsageStatsInput = z.infer<typeof StatsInputSchema>
export type SkillUsageStatsOutput = z.infer<typeof StatsOutputSchema>

/**
 * Server-side handlers. Defaults come from the parsed plugin `options`, so
 * `parseOptions` stays the single source of truth — never re-derived here.
 */
export function createSkillUsageHandlers(deps: {
  tracker: Tracker
  options: Options
}): RpcHandlers<typeof SkillUsage> {
  const { tracker, options } = deps

  return {
    stats: async (input) => {
      const metric = input.metric ?? options.defaultMetric
      const limit = input.limit ?? options.topN
      const data = tracker.data()
      const rows = toRows(data, metric, limit)
      // Totals cover every skill, not just the limited rows.
      return { rows, totals: totals(rows, data, metric) }
    },

    reset: async () => {
      await tracker.reset()
      // `reset` flushes like any other mutation, so it broadcasts `updated` too.
      return { ok: true }
    },
  }
}
