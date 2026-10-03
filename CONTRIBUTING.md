# Contributing to opencode-skill-usage

Thanks for looking at this. It is a small plugin with a deliberately narrow surface, so
most changes are small too. This guide covers the local setup, the checks, and a few
invariants that reviewers hold the line on — the last section explains why they exist.

## Getting set up

```sh
git clone https://github.com/sighrohit/opencode-skill-usage.git
cd opencode-skill-usage
npm install
```

Node.js 20 or newer is required.

## Running the checks

```sh
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

Both must pass before a pull request is merged. There is no build step — TypeScript is
published uncompiled, so `typecheck` is the only thing standing between you and a broken
release.

Run a single test file while iterating:

```sh
npx vitest run src/chart.test.ts
```

## Trying your change against a real OpenCode

Point a local `opencode.json` at the checkout rather than the published package:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-skill-usage"]
}
```

You do not need to `npm link`, and you should not — it rewrites your global install.

## Project layout

| File             | Responsibility                                              |
| ---------------- | ----------------------------------------------------------- |
| `src/types.ts`   | Shared types, option parsing and clamping                    |
| `src/store.ts`   | Persistence over OpenCode's key-value store                  |
| `src/tracker.ts` | Turns events into per-skill aggregates                       |
| `src/chart.ts`   | Sorting, share math, markdown rendering — no I/O             |
| `src/command.ts` | The `/skill-usage` server command                            |
| `src/index.ts`   | Server plugin entrypoint and event wiring                    |
| `src/rpc.ts`     | The RPC contract shared by the server and the TUI            |
| `src/tui.tsx`    | The interactive TUI panel                                    |

Every file has a colocated `*.test.ts`. `src/chart.ts` and `src/tui.tsx` hold shared
formatting strings and bar glyphs; export them rather than re-declaring them, so the
markdown and panel surfaces cannot drift apart.

## Invariants

These are load-bearing. Please do not "clean them up".

- **No `any`, no `@ts-ignore`, no `@ts-expect-error`, no hand-written SDK shims** anywhere in
  `src/`. If the real SDK types do not describe what you need, the fix is to correct our
  usage — not to cast around it.
- **`zod` is pinned to exactly one version**, in both `dependencies` and `overrides`. The
  RPC schemas cross the server/TUI boundary; two zod instances in one process means schema
  identity checks fail at runtime in a way no type checker catches. Do not widen the range.
- **The `z.ZodType<Row, Row>` annotation in `src/rpc.ts` must stay as written.** Simplifying
  it to `z.ZodType<Row>` compiles differently and breaks `Rpc.HandlerOutput`, which is
  derived from the schema's *input* side. It will produce nine type errors.
- **`topN` is truncated, `charsPerToken` is not.** They are both clamped to a minimum of `1`,
  but `topN` is a row count that crosses an `int()`-validated RPC boundary, while
  `charsPerToken` is a divisor where the fractional part is meaningful.
- **Share is computed raw-over-raw** (`raw / grandTotal`), with rounding applied only at
  display time. Rounding the denominator first produces nonsense for small totals.
- **Rows sort by the raw metric value**, not the rounded token count. Sorting on the rounded
  value lets a 46%-share row appear above a 54%-share row, which contradicts the chart's own
  "descending" title.
- **No network calls, no telemetry.** Ever. The storage key `skill-usage:stats` and the
  global (cross-project) scope are load-bearing; changing either is a breaking change for
  existing users.

## Writing tests

A test that cannot fail is worse than no test, because it reports safety that is not there.
For any fix, confirm the test actually catches the bug before you open the pull request —
reintroduce the bug, watch it go red, then put the fix back:

```sh
# apply your change, run the suite, confirm red
# revert the fix, run the suite, confirm green
npx vitest run
```

Suites should assert on observable output, not on implementation details. Prefer proving a
value reaches a user-facing surface (the markdown table, the panel title) over asserting on
an internal helper.

## Submitting a pull request

1. Branch off `main`.
2. Make the change, with tests that fail without it.
3. Run `npm test` and `npm run typecheck`.
4. Open a pull request describing what changed and why. If it fixes an issue, reference it
   with `Closes #123`.

Bug reports belong in [issues](https://github.com/sighrohit/opencode-skill-usage/issues) —
please use the template, because the version numbers and the metric you were looking at are
usually what makes a report actionable.