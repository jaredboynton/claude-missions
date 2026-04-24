#!/bin/sh
# Session-id resolver sourced by every mission-executor command.
#
# Tier 1:  env var set by Claude Code itself (per-process, no race)
# Tier 1b: env var exported by THIS plugin's SessionStart hook via
#          $CLAUDE_ENV_FILE (persists across Bash tool calls; does NOT
#          reach slash-command `!cmd` template-expansion — see
#          anthropics/claude-code#49780 — which is why tiers 3a/3b
#          still exist).
# Tier 2:  stdin JSON payload from Claude Code hooks (per-process, no
#          race; only fires for real hook invocations, not slash-cmd
#          bash blocks which pipe nothing).
# Tier 3a: per-session file written by this plugin's SessionStart hook
#          into <layoutRoot>/state/sessions/<sid>.active. Scoped to the
#          current project by construction.
# Tier 3b: ~/.claude/projects/<this-project-slug>/*.jsonl filename
#          fallback. Covers the cold-start window before SessionStart
#          has fired in this project. **Restricted to the current
#          project's slug**; the pre-0.8.4 glob searched across ALL
#          projects, which (on multi-project machines) handed out a
#          SID from whichever project happened to have the newest
#          jsonl file — a nasty silent failure mode.
#
# If all tiers fail, this prints the empty string. Callers MUST check
# for an empty result and refuse to proceed — mission-cli's
# `--session-id=` handling already rejects missing/empty values with
# exit code 4. Never invent a SID.
#
# Output: prints the resolved session-id to stdout (possibly empty).

resolve_sid() {
  # Tier 1: native Claude Code env var. Present only in hook/tool
  # contexts where Claude Code exposes it directly; not in slash-cmd
  # `!cmd` blocks today (2.1.119+ as of 2026-04).
  SID="${CLAUDE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"

  # Tier 2: hook stdin JSON. `[ -t 0 ]` guards against hanging when
  # stdin is a tty (interactive shell); slash-cmd bash blocks pipe
  # nothing, so this is a no-op there, but it's free to attempt.
  if [ -z "$SID" ] && [ ! -t 0 ]; then
    if command -v jq >/dev/null 2>&1; then
      SID=$(jq -r '.session_id // empty' 2>/dev/null < /dev/stdin || true)
    fi
  fi

  # Tier 3a: per-session .active file written by SessionStart hook,
  # scoped to this project's layoutRoot. Pick the newest by mtime.
  if [ -z "$SID" ] && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    SID_DIR=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/_lib/state-path-cli.mjs" session-id-dir 2>/dev/null)
    if [ -n "$SID_DIR" ] && [ -d "$SID_DIR" ]; then
      SID=$(ls -t "$SID_DIR"/*.active 2>/dev/null | head -1 | xargs -r -n1 basename 2>/dev/null | sed 's/\.active$//')
    fi
  fi

  # Tier 3b: jsonl-filename fallback, PROJECT-SCOPED. Earlier versions
  # globbed ~/.claude/projects/*/*.jsonl across every project, which
  # silently handed out a SID from an unrelated project whenever the
  # current project hadn't had its .active file written yet. This
  # version asks state-path-cli for the current project's slug and
  # only looks inside that slug's directory.
  if [ -z "$SID" ] && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    SLUG=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/_lib/state-path-cli.mjs" project-slug 2>/dev/null)
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
