# opencode-skill-usage

An OpenCode plugin that answers one question: **which skills cost me the most tokens?**
It records every skill loaded in your sessions and renders per-skill token usage as a
chart sorted in descending order — as an interactive panel inside the TUI, and as a
markdown table for non-TUI clients (`opencode run`, the web app).

## Metrics

The plugin tracks two metrics. `/skill-usage content` and `/skill-usage spend` select
the initial view; in the TUI panel, `m` toggles between them at any time. Rows are
always sorted in descending order by the active metric.

- **content tokens** — the estimated size of the skill content injected into context
  (loads × content, estimated at `chars / charsPerToken`). This is an **estimate**, not
  a provider measurement: it approximates tokenizer behavior with a flat character
  divisor, so treat the number as approximate.
- **session spend** — real provider token counts (input / output / reasoning / cache
  read / cache write) attributed back to skills. Attribution is **approximate**: each
  completed assistant turn's token counts are split **evenly** across every skill
  loaded so far in that session, so a skill that was loaded but barely relevant still
  receives a share.

## Install

Add the plugin to `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-skill-usage"]
}
```

With options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "opencode-skill-usage", "options": { "topN": 15, "charsPerToken": 4, "defaultMetric": "content" } }
  ]
}
```

`opencode.json`'s `plugins` field accepts either a bare package-name string or an
object with `package` and `options` keys.

One entry is enough: the host auto-probes a package's `tui` subpath as well as its main
entry, so this single `plugins` entry loads both the server command and the TUI panel.

## Usage

- `/skill-usage` — opens the panel in the TUI; posts a markdown table into the chat
  elsewhere. (See the note under Limitations about which surface wins.)
- `/skill-usage content` / `/skill-usage spend` — open with that metric selected.
- `/skill-usage reset` — clears all recorded stats in both surfaces. **Reset is
  destructive and there is no undo.**

Panel keys (active while the panel is focused):

| Key   | Action                        |
| ----- | ----------------------------- |
| `m`   | Toggle content ↔ spend metric |
| `f`   | Toggle fullscreen             |
| `esc` | Close the panel               |

When nothing has been recorded yet, both surfaces report that there is no skill usage
recorded yet instead of rendering an empty chart.

## Options

| Option           | Type                 | Default     | Description                                    |
| ---------------- | -------------------- | ----------- | ---------------------------------------------- |
| `topN`           | number               | `15`        | Rows shown in the chart/panel                  |
| `charsPerToken`  | number               | `4`         | Divisor for the content-token estimate         |
| `defaultMetric`  | `"content" \| "spend"` | `"content"` | Initial view                                   |

Both numbers are clamped to a minimum of `1`. A value that cannot be read as a finite
number falls back to the default; a readable value below `1` is clamped to `1` instead
(so e.g. `null`, `""` and `[]`, which coerce to `0`, all yield `1`). `topN` is a row
count, so a fractional value is truncated after clamping — `15.9` gives `15` and `1.9`
gives `1`. `charsPerToken` is a divisor, so it keeps its fractional part (`3.7` is
used as `3.7`).

## Privacy and storage

Everything is local. No telemetry, no network calls.

Stats live in OpenCode's own key-value store under the key `skill-usage:stats`, in a
per-plugin namespaced row. That store is global across projects: the plugin's data is
**not** per-project and **does** accumulate across every project you use OpenCode in.
A user who wants per-project numbers will not get them from this version. Clearing the
data is only possible via `/skill-usage reset` (destructive, no undo).

## Exports

| Subpath | Contents                      |
| ------- | ----------------------------- |
| `.`     | The server plugin             |
| `./rpc` | The shared RPC contract       |
| `./tui` | The TUI panel                 |

## Screenshot

> [Screenshot placeholder — no screenshot has been captured yet. The panel is a
> themed table of skill names, load counts, token counts, bar charts, and shares,
> with a totals line and the `[m]etric [f]ullscreen [esc] close` key hints.]

## Limitations

- **Content tokens are an estimate.** They are computed as `chars / charsPerToken`
  over the text delivered with each skill-activation event, so the number is
  approximate by construction. Adjust `charsPerToken` if the estimates look
  systematically high or low for your provider.
- **Session spend attribution is approximate.** Each completed assistant turn's real
  provider token counts are split evenly across every skill loaded so far in that
  session. A skill that was loaded but barely relevant to a turn still receives an
  equal share of that turn's tokens.
- **Content tokens count only initial `SKILL.md` loads.** In OpenCode V2 the built-in
  `skill` tool accepts `{ id }` only — there is no `path` input — so sub-file reads
  inside a skill (reference docs and the like) inject content that this plugin never
  sees. If your numbers look lower than expected, this is the most likely reason.
- **TUI-vs-server command precedence is an assumption, not a verified fact.** The TUI
  plugin registers a `/skill-usage` slash command that opens the panel; the server
  plugin registers a `/skill-usage` command that posts a markdown table into the chat.
  The intent is that the TUI one wins inside the TUI (so non-TUI clients — `opencode
  run`, the web app — still get the markdown table). This was never executed against
  a live TUI, so if both surfaces fire or the wrong one wins, the keys above
  (`skill-usage.open` / `skill-usage.toggle-metric` / `skill-usage.fullscreen` /
  `skill-usage.close`) are where to start looking.

## License

MIT — see [LICENSE](./LICENSE).

Copyright (c) 2026 Rohit.
