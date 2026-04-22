---
description: Drop the abort marker for the mission this session is attached to. Releases the Stop-hook lock; operator should confirm before running.
allowed-tools: Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(jq:*), Bash(basename:*), Bash(sed:*), Bash(xargs:*), Bash(head:*), Bash(.:*)
---

Abort is destructive-ish: it releases the Stop-hook lock and lets the assistant end its turn mid-mission. Confirm with the user before running.

!`. "${CLAUDE_PLUGIN_ROOT}/scripts/_lib/resolve-sid.sh"; SID=$(resolve_sid); node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" abort --session-id="${SID}"`

Abort marker dropped. The Stop hook will release on the next Stop event and allow the assistant to end its turn. The mission state file remains; to re-enter execution, run `/mission-executor:execute <mission-path-or-id>`.
