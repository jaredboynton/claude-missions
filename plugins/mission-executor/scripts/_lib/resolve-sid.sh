#!/bin/sh
# Session-id resolver sourced by every mission-executor command.
#
# Tier 1:  env var set by Claude Code (per-process, no file, no race)
# Tier 2:  stdin JSON payload from Claude Code (per-process, no race)
# Tier 3a: per-session file written by SessionStart hook (default safe)
# Tier 3b: ~/.claude/projects/<slug>/<sid>.jsonl filename fallback (covers
#          cold start before SessionStart has fired in this project)
#
# Output: prints the resolved session-id to stdout (may be empty if none found).

resolve_sid() {
  SID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
  # Tier 2: only read stdin if it's NOT a terminal (slash-command bash has a
  # piped stdin; an interactive shell does not). `[ -t 0 ]` tests whether FD 0
  # is connected to a tty. Skipping this check would hang waiting for user input.
  if [ -z "$SID" ] && [ ! -t 0 ]; then
    if command -v jq >/dev/null 2>&1; then
      SID=$(jq -r '.session_id // empty' 2>/dev/null < /dev/stdin || true)
    fi
  fi
  if [ -z "$SID" ] && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    SID_DIR=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/_lib/state-path-cli.mjs" session-id-dir 2>/dev/null)
    if [ -n "$SID_DIR" ] && [ -d "$SID_DIR" ]; then
      SID=$(ls -t "$SID_DIR"/*.active 2>/dev/null | head -1 | xargs -r -n1 basename 2>/dev/null | sed 's/\.active$//')
    fi
  fi
  if [ -z "$SID" ]; then
    JSONL=$(ls -t "${HOME}/.claude/projects/"*/*.jsonl 2>/dev/null | head -1)
    if [ -n "$JSONL" ]; then
      SID=$(basename "$JSONL" .jsonl)
    fi
  fi
  printf '%s' "$SID"
}
