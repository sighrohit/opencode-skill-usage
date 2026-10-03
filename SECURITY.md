# Security Policy

## Scope

This plugin runs inside your OpenCode client. It reads OpenCode events, writes a single
row to OpenCode's local key-value store, and renders text. It makes **no network requests**,
ships **no telemetry**, and reads **no files outside your OpenCode data directory**.

The realistic threat surface is therefore small: a malicious skill or plugin in the same
OpenCode installation could write to the shared store, and a crafted config could set
extreme option values. Neither grants new capability beyond what the user has already
installed.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Instead, use GitHub's private reporting on this repository:
[Report a vulnerability](https://github.com/sighrohit/opencode-skill-usage/security/advisories/new).

Include:

- what the issue is and what an attacker gains,
- the plugin version and your OpenCode version,
- a minimal reproduction if you have one.

You can expect an acknowledgement within a few days. Fixes ship as a patch release, and the
advisory is published after the fix is available — tell us if you would rather it stayed
draft until then.

## What is not a vulnerability

- Numbers that disagree with your provider's own usage dashboard. Both metrics are
  approximations by design; see the [Limitations](./README.md#limitations) section for
  exactly how.
- A skill's share of session spend looking too large. Attribution is an even split across
  skills loaded in a session, not a relevance judgement.
- Anything reachable only by a config value the user wrote themselves.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |