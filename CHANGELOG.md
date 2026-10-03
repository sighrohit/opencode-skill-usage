# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0]

Initial release.

### Added

- Per-skill token usage tracking, persisted in OpenCode's key-value store under
  `skill-usage:stats`. The store is global across projects, not per-project.
- Two metrics: **content tokens** (an estimate of injected skill content, computed as
  `chars / charsPerToken`) and **session spend** (real provider token counts — input, output,
  reasoning, cache read, cache write — attributed back to skills).
- An interactive TUI panel with a descending chart, a totals line, fullscreen toggle, and a
  metric toggle bound to `m`, `f`, and `esc`.
- A markdown table fallback for non-TUI clients such as `opencode run` and the web app.
- The `/skill-usage` command, with optional `content`, `spend`, and `reset` arguments.
  `reset` is destructive and has no undo.
- Options `topN` (default `15`), `charsPerToken` (default `4`) and `defaultMetric` (default
  `"content"`). Both numbers are clamped to a minimum of `1`; `topN` is truncated, since it
  is a row count, while `charsPerToken` keeps its fractional part.
- A shared RPC contract exported at `./rpc` so the server plugin and the TUI panel share one
  schema.

### Notes

- Both metrics are approximations by construction, and the limitations are documented rather
  than hidden: content tokens count only initial `SKILL.md` loads, because OpenCode V2's
  built-in `skill` tool accepts `{ id }` and has no `path` input for sub-file reads; and
  session spend is split evenly across the skills loaded in a session rather than attributed
  by relevance.
- No telemetry and no network calls.