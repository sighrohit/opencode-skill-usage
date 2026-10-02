# opencode-skill-usage — Design

**Date:** 2026-10-02
**Status:** Approved (conversational), pending written-spec review

## Purpose

A public npm plugin for OpenCode V2 that tracks per-skill token usage and
displays it as a chart sorted descending. It answers "which skills cost me the
most tokens?" so developers can trim, lazy-load, or optimize their skill
library. All data stays on the local machine — privacy is an explicit selling
point.

## Metrics

Two metrics, shown as separate views:

1. **Content tokens (exact attribution, estimated count).** Every time the
   `skill` tool injects content into context — the initial `SKILL.md` load and
   any sub-file reads via its `path` input — the injected size is recorded
   against that skill. Tokens are estimated as `chars / charsPerToken`
   (default divisor 4, configurable plugin option). Documented as an estimate.
2. **Session spend (approximate attribution, real counts).** Each completed
   assistant turn carries real provider token usage (input / output / cache).
   A turn's usage is split **evenly** across the set of skills loaded so far
   in that session. Documented as approximate: a skill loaded but barely
   relevant still receives a share.

## Architecture

Single npm package `opencode-skill-usage`, ESM, MIT license, OpenCode V2 only
(V1 support out of scope). One dependency: `@opencode/plugin`.

```jsonc
"exports": {
  ".": "./src/index.ts",    // server plugin: collection + storage + RPC impl
  "./rpc": "./src/rpc.ts",  // shared RPC contract imported by both sides
  "./tui": "./src/tui.tsx"  // CLI plugin: themed TUI rendering
}
```

Peer dependencies for the TUI side: `solid-js`, `@opentui/core`,
`@opentui/solid`.

### Server plugin modules

| Module | Responsibility |
|---|---|
| `src/index.ts` | `Plugin.define`, wires everything, reads plugin options |
| `src/tracker.ts` | Data collection: tool hook + event subscription, attribution |
| `src/store.ts` | Global persistence (ctx.storage or JSON file fallback) |
| `src/chart.ts` | Pure function: stats → markdown table string |
| `src/command.ts` | Server-side `/skill-usage` command (markdown output) |
| `src/rpc.ts` | Shared RPC contract |

### Data collection

- `ctx.tool.hook("execute.after")` filters for the `skill` tool. Input carries
  the skill `id`; result carries the injected content. Record
  `{ skillID, estTokens, timestamp, sessionID }` and increment the skill's
  `loads` and `contentTokens`.
- `ctx.event.subscribe()` watches for completed assistant messages (token
  usage). An in-memory `sessionID → Set<skillID>` tracks loaded skills per
  session; each turn's usage is split evenly across the set and accumulated
  into `spend`.

### Stored data (global across projects)

```json
{
  "version": 1,
  "skills": {
    "brainstorming": {
      "loads": 12,
      "contentTokens": 45230,
      "spend": { "input": 1200000, "output": 45000, "cacheRead": 800000 },
      "lastUsed": "2026-10-02T09:14:00Z"
    }
  }
}
```

Persistence: prefer `ctx.storage` if it proves server-global (verify); else a
JSON file at `~/.local/share/opencode/skill-usage.json`. Either way the store
module exposes the same get/set interface.

### RPC contract

`SkillUsage` RPC (id `skill-usage`):

- `stats({ metric?: "content" | "spend", limit?: number })` → rows sorted
  descending by the requested metric, plus totals.
- `reset()` → clears all stats.
- Event `updated` — emitted whenever stats change; the TUI panel subscribes
  for live refresh.

The TUI side calls it via `context.client.rpc(SkillUsage)`.

## Display

### Tier 1 — TUI panel (primary, themed)

`/skill-usage` in the TUI (CLI keymap slash command) opens a `session.panel`
rendered in OpenTUI JSX with `context.theme` semantic tokens, so colors
automatically follow the user's selected theme:

```
╭ Skill Token Usage — content (desc) ──── [m]etric [f]ullscreen [esc] close ╮
│  Skill                    Loads    Tokens   Share                         │
│  brainstorming              12     45.2k    ████████████████░░░░   37%    │
│  systematic-debugging        8     28.1k    ██████████░░░░░░░░░░   23%    │
│  frontend-design             5     17.4k    ██████░░░░░░░░░░░░░░   14%    │
│  Total: 120.4k tokens · 34 loads · 9 skills                               │
╰───────────────────────────────────────────────────────────────────────────╯
```

- Columns: Skill, Loads, Tokens (or spend), Share bar + percentage.
- Bar segments use theme accent color; secondary text uses muted tokens.
  Works with any built-in or custom theme, light or dark.
- Keys: `m` toggles content ↔ spend, `f` fullscreen, `esc` close.
- Always sorted descending by the active metric.
- Live-refreshes on the RPC `updated` event.

### Tier 2 — markdown table (baseline, all clients)

The server plugin also registers `/skill-usage`, which injects a markdown
table with the same data into the chat. Works in the web app, `opencode run`,
and any client without the TUI panel; the TUI's own markdown renderer styles
it with theme colors.

Verify at implementation: when both a CLI slash command and a server command
are named `skill-usage`, the CLI one takes precedence in the TUI (the server
one then serves non-TUI clients). Output injection uses
`ctx.session.synthetic`; if that proves to trigger the agent loop, fall back
to a prompt that makes the agent print the pre-rendered table.

## Plugin options

| Option | Default | Meaning |
|---|---|---|
| `topN` | 15 | Rows shown in chart/panel |
| `charsPerToken` | 4 | Divisor for content-token estimation |
| `defaultMetric` | `"content"` | Initial view: `content` or `spend` |

## Testing

- **Unit tests** (pure functions): markdown table renderer, even-split
  attribution, token estimation, store read/merge/version handling.
- **Manual verification checklist**: load plugin → invoke skills →
  `/skill-usage` shows correct descending numbers → restart OpenCode →
  numbers persisted → panel respects theme switch → `reset()` clears.

## Phased delivery

- **Phase 1 — server core.** Collection (both metrics), storage, markdown
  table command. End-to-end usable in every client.
- **Phase 2 — RPC + TUI panel.** Shared contract, themed panel, plugin
  options.
- **Phase 3 — publish polish.** README with screenshot, LICENSE, package
  metadata, manual verification, npm publish prep.

## Out of scope (YAGNI)

Web dashboard, historical trends / daily rollups, per-project breakdown
(stats are global by decision; RPC shape leaves room for a future filter),
V1 plugin support, exact tokenizer per model.

## Open verification items

- Is `ctx.storage` server-global or per-location?
- Effective name and result shape of the built-in `skill` tool.
- Exact assistant-message event shape carrying `TokenUsage` in
  `V2EventEncoded`.
- Theme token names available on `context.theme` (accent etc.).
- `ctx.session.synthetic` visibility / agent-loop behavior.
- CLI vs server slash command precedence in the TUI.

## Success criteria

- After using skills, `/skill-usage` shows a descending chart whose numbers
  match recorded loads within estimation tolerance.
- Stats persist across OpenCode restarts and accumulate across projects.
- The TUI panel renders in the user's selected theme colors.
- Package installs from npm via `plugins: ["opencode-skill-usage"]`.
