---
name: Bug report
about: Something behaves differently than documented
title: ''
labels: bug
assignees: ''
---

<!--
Both metrics in this plugin are approximations by construction. Before filing, please read
the Limitations section of the README — it explains exactly how each number is derived, and
a surprising number is often documented behaviour rather than a defect.
-->

### What happened

<!-- What you saw. If it is a wrong number, paste the actual output so the columns can be compared. -->

### What you expected

### Steps to reproduce

1.
2.
3.

### Environment

| | |
| --- | --- |
| Plugin version | <!-- npm view opencode-skill-usage version --> |
| OpenCode version | |
| Surface | <!-- TUI panel, or `opencode run` / web app --> |
| Metric | <!-- content, spend, or both --> |
| Operating system | |

### Relevant config

<!-- Only the plugin entry from opencode.json. Please redact anything else. -->
```jsonc
{
  "plugins": [
    { "package": "opencode-skill-usage", "options": { "topN": 15, "charsPerToken": 4, "defaultMetric": "content" } }
  ]
}
```

### Anything else

<!-- Errors in the OpenCode log, a screen recording, or the exact key you pressed. -->