---
description: PHASE-A PROBE — verify what session-id sources are available in slash-command bash. Delete after §0.1/§0.3/§0.4 are resolved in PROBE_RESULTS.md.
allowed-tools: Bash(env:*), Bash(ls:*), Bash(cat:*), Bash(grep:*), Bash(find:*), Bash(head:*), Bash(echo:*), Bash(node:*)
---

This command is TEMPORARY. Its purpose is to resolve the Phase-A probe gates in `PROBE_RESULTS.md`. After probes are captured and the gates are checked, DELETE this file.

Expected outputs per tier (see spec §0.1):

- **Tier 1** (env var): look for `CLAUDE_SESSION_ID` or `CLAUDE_CODE_SESSION_ID` in the `env` grep output.
- **Tier 2** (stdin JSON): look for a `session_id` field in the `stdin` output. Empty stdin = Tier 2 not available.
- **Tier 3a** (per-session file): look for a recent `*.active` file in the session-id dir. Only present after the SessionStart hook has fired at least once in this project.
- **Tier 3b** (jsonl filename): look for a `<sid>.jsonl` under `~/.claude/projects/<slug>/`. The filename is the session-id.

After running, paste all four output sections into `plugins/mission-executor/PROBE_RESULTS.md` under §0.1 and check/uncheck the boxes based on evidence.

!`echo "--- env (Tier 1) ---"; env | grep -Ei 'claude|session' || echo "(nothing)"; echo; echo "--- stdin (Tier 2) ---"; cat /dev/stdin 2>/dev/null | head -c 600 || echo "(empty)"; echo; echo "--- CLAUDE_PROJECT_DIR ---"; echo "CLAUDE_PROJECT_DIR=${CLAUDE_PROJECT_DIR:-(unset)}"; echo "CLAUDE_PLUGIN_ROOT=${CLAUDE_PLUGIN_ROOT:-(unset)}"; echo; echo "--- jsonl files (Tier 3b) ---"; ls -t "${HOME}/.claude/projects/"*/*.jsonl 2>/dev/null | head -5 || echo "(none)"; echo; echo "--- session-id files (Tier 3a) ---"; if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then SID_DIR=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/_lib/state-path-cli.mjs" session-id-dir 2>/dev/null); echo "session-id-dir=$SID_DIR"; ls -la "$SID_DIR" 2>/dev/null || echo "(dir does not exist yet)"; else echo "(CLAUDE_PLUGIN_ROOT unset; skip)"; fi`

Capture the four sections above into PROBE_RESULTS.md and resolve the §0.1 checkboxes.
