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

**v0.5.0**: prefer `/mission-executor:status` (read-only slash command, runs
`mission-cli.mjs status` and prints a single JSON object) over invoking this
skill for routine status checks. This skill remains useful for producing the
human-readable report format below via `mission-query.mjs`, but for just
"what phase is the mission in / who is attached / is it complete?" the
slash command is faster and doesn't require skill-invocation context.

**v0.5.1**: `mission-cli status` now also includes derived worker states and
active-worker session-ids computed from `<missionPath>/progress_log.jsonl`
(see [skills/mission-execute/SKILL.md](../mission-execute/SKILL.md)'s
"Progress log" section for the event vocabulary). Output shape gains two
optional fields:
```
"workers": { "<workerSessionId>": { "startedAt", "completedAt?", "exitCode?", "failed?" } }
"activeWorkers": [ "<workerSessionId>", ... ]
```
These are populated whenever progress_log exists for the mission; absent
otherwise.

## Input

- `<mission-path>`: Path to `.factory/missions/<id>/` directory. Auto-discovers if omitted.

## Implementation

Use `scripts/mission-query.mjs` for all JSON reads. The script avoids the two
jq shape gotchas the mission artifacts expose:

- `features.json` is `{ features: [...] }` — array under a key, not an array at
  root. `jq '.features | length'` is fine; `jq 'length'` is wrong.
- `validation-state.json` is `{ assertions: { "VAL-X": {status}, ... } }` — an
  OBJECT keyed by id, not an array. `jq '.assertions | group_by(.status)'` errors
  because group_by wants arrays. The correct path is
  `jq '.assertions | to_entries[] | .value.status'`.

Commands (all emit JSON on stdout):

```
# Everything in one shot (default): state + features + assertions + tree HEADs
node .../scripts/mission-query.mjs <missionPath>
node .../scripts/mission-query.mjs <missionPath> summary

# Features only — byStatus, byMilestone, id lists
node .../scripts/mission-query.mjs <missionPath> features

# Assertions only — byStatus, pending/stale/failed/blocked id lists,
# passedWithoutProof[] (passed entries missing a proof block)
node .../scripts/mission-query.mjs <missionPath> assertions
```

Exit 0 on success, 1 on shape error, 2 on missing artifact. Reshape with jq
downstream when you want the human-readable layout below.

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
