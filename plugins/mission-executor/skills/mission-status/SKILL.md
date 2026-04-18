---
name: mission-status
description: Show current status of a Factory mission -- features, assertions, progress
argument-hint: "<mission-path>"
triggers:
  - mission status
  - mission progress
---

# Mission Status

Quick status check for a Factory mission. Shows feature completion, assertion pass rates, and current phase.

## Input

- `<mission-path>`: Path to `.factory/missions/<id>/` directory. Auto-discovers if omitted.

## Output

Reads features.json, validation-state.json, and state.json to produce:

```
Mission: <title> (<missionId>)
State: <state>
Working Directory: <path>

Features: N/M completed (X in_progress, Y pending)
  Milestone 1: N/M features
  Milestone 2: N/M features
  ...

Assertions: N/M passed (X failed, Y pending)
  VAL-ORCH:    N/M
  VAL-NAV:     N/M
  VAL-SHELL:   N/M
  VAL-HTTP:    N/M
  ...

Failed Assertions:
  VAL-XXX-NNN: <reason>
  ...
```
