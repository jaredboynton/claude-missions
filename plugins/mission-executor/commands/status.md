---
description: Print mission state, attached sessions, and completion-gate status. Read-only.
argument-hint: [mission-id]
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(cat:*), Bash(ls:*), Bash(jq:*), Bash(basename:*), Bash(sed:*), Bash(xargs:*), Bash(head:*), Bash(.:*)
---

This command is read-only and should only be invoked when the user explicitly asks for mission status. Do NOT auto-run between turns to check state — use the mission data already in the conversation instead. (If the `disable-model-invocation` frontmatter key is honored by this version of Claude Code, auto-invocation is blocked mechanically; if not, this sentence is the only deterrent.)

!`. "${CLAUDE_PLUGIN_ROOT}/scripts/_lib/resolve-sid.sh"; SID=$(resolve_sid); node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" status "$ARGUMENTS" --session-id="${SID}"`
