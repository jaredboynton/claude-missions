#!/bin/sh
# Session-id resolver. STANDALONE SCRIPT — do NOT source it.
#
#   usage: SID=$("$CLAUDE_PLUGIN_ROOT/scripts/_lib/resolve-sid.sh")
#
# Historical note (v0.5.0-0.8.4): this file was sourced by command
# backtick-blocks (`. resolve-sid.sh; SID=$(resolve_sid)`). That worked
# as long as `$CLAUDE_PLUGIN_ROOT` was available as a shell env var in
# the block. Per anthropics/claude-code#42564, #48230, #24529 the
# variable is NOT exported to the spawned process — Claude Code only
# text-substitutes `${CLAUDE_PLUGIN_ROOT}` in the markdown source before
# running the block. So `resolve-sid.sh`'s internal
# `[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]` guards always failed and both
# tier-3 lookups were skipped. From 0.8.5 this script self-locates via
# `$0` (the path Claude Code already resolved when it invoked us) and
# passes the plugin root to `state-path-cli.mjs` explicitly, so it no
# longer depends on an env var the harness doesn't set.
#
# Tiers (first non-empty wins):
#   1.   env var CLAUDE_SESSION_ID / CLAUDE_CODE_SESSION_ID (only in
#        hook/tool contexts that Claude Code currently populates).
#   2.   stdin JSON payload (hooks only; `[ -t 0 ]` skip guards the
#        interactive-shell hang case).
#   3a.  <layoutRoot>/state/sessions/<sid>.active — written by THIS
#        plugin's SessionStart hook. Scoped to the current project.
#   3b.  ~/.claude/projects/<current-project-slug>/*.jsonl — scoped to
#        the current project, never cross-project (cross-project glob
#        was the 0.8.3 silent-failure mode).
#
# Prints the resolved session-id to stdout. Empty string if all tiers
# miss; callers MUST refuse to proceed on empty (mission-cli rejects
# empty `--session-id=` with exit 4).

# Self-locate so we don't need $CLAUDE_PLUGIN_ROOT in the env.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PATH_CLI="$SCRIPT_DIR/state-path-cli.mjs"

resolve_sid() {
  # Tier 1
  SID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"

  # Tier 2 — only attempt if stdin is piped
  if [ -z "$SID" ] && [ ! -t 0 ]; then
    if command -v jq >/dev/null 2>&1; then
      SID=$(jq -r '.session_id // empty' 2>/dev/null < /dev/stdin || true)
    fi
  fi

  # Tier 3a — per-session .active file in layoutRoot/state/sessions.
  # state-path-cli.mjs resolves that path from paths.mjs, which reads
  # CLAUDE_PROJECT_DIR || CLAUDE_WORKING_DIR || process.cwd() — and
  # cwd is set correctly to the project root by Claude Code for
  # slash-command subprocesses.
  if [ -z "$SID" ]; then
    SID_DIR=$(node "$PATH_CLI" session-id-dir 2>/dev/null)
    if [ -n "$SID_DIR" ] && [ -d "$SID_DIR" ]; then
      SID=$(ls -t "$SID_DIR"/*.active 2>/dev/null | head -1 | xargs -r -n1 basename 2>/dev/null | sed 's/\.active$//')
    fi
  fi

  # Tier 3b — PROJECT-SCOPED jsonl fallback. The current project's
  # slug directory only; the cross-project glob from 0.8.3 is gone.
  if [ -z "$SID" ]; then
    SLUG=$(node "$PATH_CLI" project-slug 2>/dev/null)
    if [ -n "$SLUG" ]; then
      PROJ_DIR="${HOME}/.claude/projects/${SLUG}"
      if [ -d "$PROJ_DIR" ]; then
        JSONL=$(ls -t "$PROJ_DIR"/*.jsonl 2>/dev/null | head -1)
        if [ -n "$JSONL" ]; then
          SID=$(basename "$JSONL" .jsonl)
        fi
      fi
    fi
  fi

  printf '%s' "$SID"
}

resolve_sid
