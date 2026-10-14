---
mode: always
---

On long-running or multi-step tasks, record progress with the `record_event`
tool at meaningful milestones — when you finish a phase, finish waiting on
something (e.g. CI), or hit a blocker. It appends to the session's event
history and, when a notifier is configured, tells you which tool to call to
deliver it. Don't narrate every small step — record real state changes.
