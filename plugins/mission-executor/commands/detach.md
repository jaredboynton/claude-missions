---
description: Remove this session from its attached mission's enforcement scope (mission continues for other sessions)
allowed-tools: Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(jq:*), Bash(basename:*), Bash(sed:*), Bash(xargs:*), Bash(head:*), Bash(.:*)
---

!`SID=$("${CLAUDE_PLUGIN_ROOT}/scripts/_lib/resolve-sid.sh"); node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" detach --session-id="${SID}"`

Detach complete. Hooks will no-op for this session going forward.

If the JSON above shows `exit 7` / `driver-detach-blocked` or `last-session detach blocked`: the detach was refused. Run `/mission-executor:abort` or `/mission-executor:complete` to end the mission entirely, or open a second terminal and attach there before detaching this one.
