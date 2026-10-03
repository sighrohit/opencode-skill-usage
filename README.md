# opencode-skill-usage

[![npm](https://img.shields.io/npm/v/opencode-skill-usage?style=flat)](https://www.npmjs.com/package/opencode-skill-usage)
[![license](https://img.shields.io/github/license/sighrohit/opencode-skill-usage?style=flat)](./LICENSE)

**Which skills are burning your token budget?**

An OpenCode plugin that records every skill loaded in your sessions and renders per-skill
token usage as a chart sorted in descending order — as an interactive panel inside the TUI,
and as a markdown table for non-TUI clients (`opencode run`, the web app).

> [!IMPORTANT]
> Both metrics carry an accuracy caveat. Content tokens are an **estimate**, and session
> spend is attributed **evenly** across loaded skills. Both are approximations by
> construction, not provider measurements. See [Limitations](#limitations) before you
> quote a number from this plugin.

Built against the OpenCode V2 plugin API (`@opencode/plugin` 2.0.22). No telemetry, no
network calls, no data leaves your machine.

## Metrics

The plugin tracks two metrics. `/skill-usage content` and `/skill-usage spend` open the panel with the
selected metric; in the TUI panel, `m` toggles between them at any time. Rows are always
sorted in descending order by the active metric.

- **content tokens** — the estimated size of the skill content injected into context
  (loads × content, estimated at `chars / charsPerToken`). This is an **estimate**, not a
  provider measurement: it approximates tokenizer behavior with a flat character divisor,
  so treat the number as approximate.
- **session spend** — real provider token counts (input / output / reasoning / cache read /
  cache write) attributed back to skills. Attribution is **approximate**: each completed
  assistant turn's token counts are split **evenly** across every skill loaded so far in
  that session, so a skill that was loaded but barely relevant still receives a share.

## Install

```sh
npm install opencode-skill-usage
```

Then add the plugin to `opencode.json`:

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
    {
      "package": "opencode-skill-usage",
      "options": { "topN": 15, "charsPerToken": 4, "defaultMetric": "content" }
    }
  ]
}
```

`opencode.json`'s `plugins` field accepts either a bare package-name string or an object
with `package` and `options` keys.

> [!TIP]
> One entry is enough. The host auto-probes a package's `tui` subpath as well as its main
> entry, so this single `plugins` entry loads both the server command and the TUI panel.

## Usage

| Command                 | Effect                                                     |
| ----------------------- | ---------------------------------------------------------- |
| `/skill-usage`          | Opens the skill usage panel in the TUI                     |
| `/skill-usage content`  | Opens panel with content metric selected                   |
| `/skill-usage spend`    | Opens panel with spend metric selected                     |
| `/skill-usage reset`    | Clears all recorded stats (and posts confirmation)         |

> [!NOTE]
> Single name, single command — mirrors the built-in `/skills` behaviour. `/skill-usage` opens the panel in the TUI; the server editor command that previously posted markdown tables was removed. Metric arguments (`content`/`spend`/`reset`) arrive via `arguments: true` and are handled by `parsePanelIntent`; `m` still toggles content ↔ spend inside the panel.

Panel keys (active while the panel is focused):

| Key   | Action                        |
| ----- | ----------------------------- |
| `m`   | Toggle content ↔ spend metric |
| `f`   | Toggle fullscreen             |
| `esc` | Close the panel               |

When nothing has been recorded yet, both surfaces report that there is no skill usage
recorded yet instead of rendering an empty chart.

## Options

| Option          | Type                    | Default     | Description                            |
| --------------- | ----------------------- | ----------- | -------------------------------------- |
| `topN`          | number                  | `15`        | Rows shown in the chart/panel          |
| `charsPerToken` | number                  | `4`         | Divisor for the content-token estimate |
| `defaultMetric` | `"content" \| "spend"` | `"content"` | Initial view                           |

Both numbers are clamped to a minimum of `1`. A value that cannot be read as a finite number
falls back to the default; a readable value below `1` is clamped to `1` instead (so e.g.
`null`, `""` and `[]`, which coerce to `0`, all yield `1`). `topN` is a row count, so a
fractional value is truncated after clamping — `15.9` gives `15` and `1.9` gives `1`.
`charsPerToken` is a divisor, so it keeps its fractional part (`3.7` is used as `3.7`).

## Privacy and storage

Everything is local. No telemetry, no network calls.

Stats live in OpenCode's own key-value store under the key `skill-usage:stats`, in a
per-plugin namespaced row. That store is global across projects: the plugin's data is **not**
per-project and **does** accumulate across every project you use OpenCode in. A user who
wants per-project numbers will not get them from this version. Clearing the data is only
possible via `/skill-usage reset` (destructive, no undo).

## Exports

| Subpath | Contents                |
| ------- | ----------------------- |
| `.`     | The server plugin       |
| `./rpc` | The shared RPC contract |
| `./tui` | The TUI panel           |

## Screenshot

> Screenshot placeholder — none captured yet. The panel is a themed table of skill names,
> load counts, token counts, bar charts, and shares, with a totals line and the
> `[m]etric [f]ullscreen [esc] close` key hints.

## Limitations

- **Content tokens are an estimate.** They are computed as `chars / charsPerToken` over the
  text delivered with each skill-activation event, so the number is approximate by
  construction. Adjust `charsPerToken` if the estimates look systematically high or low for
  your provider.
- **Session spend attribution is approximate.** Each completed assistant turn's real provider
  token counts are split evenly across every skill loaded so far in that session. A skill
  that was loaded but barely relevant to a turn still receives an equal share of that turn's
  tokens.
- **Content tokens count only initial `SKILL.md` loads.** In OpenCode V2 the built-in `skill`
  tool accepts `{ id }` only — there is no `path` input — so sub-file reads inside a skill
  (reference docs and the like) inject content that this plugin never sees. If your numbers
  look lower than expected, this is the most likely reason.
- **Single `/skill-usage` command.** The server editor command that previously posted markdown tables was deleted. The TUI keymap command now owns the name with both `palette: true` and `slash: { name: "skill-usage", arguments: true }` — exactly mirroring the built-in `/skills` command. `/skill-usage` opens the panel; metric arguments (`content`/`spend`/`reset`) arrive via `arguments: true` and are handled by `parsePanelIntent`. The earlier assumption that the host would arbitrate namespaces was incorrect — it lists both, causing duplicates.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the
workflow, the checks that must pass, and how to run the test suite locally.

To report a bug, open an issue using the [bug report
template](https://github.com/sighrohit/opencode-skill-usage/issues/new?template=bug_report.md).
Feature ideas go through the [feature request
template](https://github.com/sighrohit/opencode-skill-usage/issues/new?template=feature_request.md).

Please report security issues privately rather than in a public issue — see
[SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Rohit