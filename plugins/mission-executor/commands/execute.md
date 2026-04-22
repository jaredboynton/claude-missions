---
description: Execute a Factory mission with full autopilot (idempotent - starts new or attaches to existing)
argument-hint: [mission-path-or-id]
allowed-tools: Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(jq:*), Bash(basename:*), Bash(sed:*), Bash(xargs:*), Bash(head:*), Bash(.:*), Read, Skill
---

!`. "${CLAUDE_PLUGIN_ROOT}/scripts/_lib/resolve-sid.sh"; SID=$(resolve_sid); node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" start "$1" --session-id="${SID}"`

The session is now attached (see `action` in the JSON above: `started` or `attached-to-existing`).

Invoke the `mission-executor:mission-execute` skill with the `missionPath` from the output. Do NOT re-run `mission-lifecycle.mjs start` — the CLI above already handled it.

If `action` is `attached-to-existing`, the mission was already running when this session fired `/execute`. Continue the mission-execute pipeline from wherever it left off (resume behavior is idempotent — re-invoking the skill on an already-running mission picks up state from `validation-state.json` / `features.json`).
