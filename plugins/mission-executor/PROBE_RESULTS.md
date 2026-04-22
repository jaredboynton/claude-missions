# Phase-A Probe Results — mission-executor 0.5.0

Status: **RESOLVED** — §0.1 Tiers 1/2/3a/3b all evidenced, §0.4 clear, §0.3 deferred (non-probeable, soft-gate). Slash-command probe ran 2026-04-22 in session `3e359511-edf4-47a3-8da3-2bed1777093d` against Claude Code 2.1.117 on AWS Bedrock. Session was restarted at 19:42 to exercise the SessionStart hook.

## §0.1 — Session-id exposure (definitive via slash-command bash)

Ran `/mission-executor:_probe` in live session. Raw output captured below.

### Raw probe output (2026-04-22)

```
--- env (Tier 1) ---
CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000
CLAUDE_CODE_SSE_PORT=61561
CLAUDE_CODE_ENTRYPOINT=cli
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_CODE_SIMULATE_PROXY_USAGE=1
CLAUDE_CODE_EFFORT_LEVEL=max
CLAUDECODE=1
CLAUDE_CODE_EXECPATH=/Users/jaredboynton/.local/share/claude/versions/2.1.117
ANTHROPIC_DEFAULT_OPUS_MODEL=us.anthropic.claude-opus-4-7[1m]
(no CLAUDE_SESSION_ID / CLAUDE_CODE_SESSION_ID)

--- stdin (Tier 2) ---
(empty)

--- CLAUDE_PROJECT_DIR ---
CLAUDE_PROJECT_DIR=(unset)
CLAUDE_PLUGIN_ROOT=(unset)

--- jsonl files (Tier 3b) ---
/Users/jaredboynton/.claude/projects/-Users-jaredboynton---devlocal-claude-missions/3e359511-edf4-47a3-8da3-2bed1777093d.jsonl
/Users/jaredboynton/.claude/projects/-Users-jaredboynton-mcp-images-mcp/4842a45a-...jsonl
/Users/jaredboynton/.claude/projects/-Users-jaredboynton---devlocal-claude-missions/37630db7-...jsonl
/Users/jaredboynton/.claude/projects/-Users-jaredboynton---devlocal-mek/a0d90a0c-...jsonl
/Users/jaredboynton/.claude/projects/-Users-jaredboynton---devlocal-mek-cse-tools/b685c83c-...jsonl

--- session-id files (Tier 3a) ---
(CLAUDE_PLUGIN_ROOT unset; skip)
```

### Results

| Tier | Result | Evidence |
|------|--------|----------|
| Tier 1 env (`$CLAUDE_SESSION_ID` / `$CLAUDE_CODE_SESSION_ID`) | **NOT SET in slash-command bash** | Live probe output above. Confirmed also unset at tool-level Bash. Claude Code 2.1.117 does not inject a session-id env var into slash-command bash. |
| Tier 2 stdin JSON | **NOT RECEIVED in slash-command bash** | Live probe output above. `cat /dev/stdin` returned empty. Claude Code 2.1.117 does not pipe JSON payload into slash-command bash. |
| Tier 3a per-session file (`<stateBase>/sessions/<sid>.active`) | **CONFIRMED post-restart** | Session restarted at 2026-04-22T23:42Z. SessionStart hook fired and wrote `.mission-executor/state/sessions/3e359511-edf4-47a3-8da3-2bed1777093d.active` (contents: ISO timestamp `2026-04-22T23:42:23.940Z`). Audit log at `.mission-executor/state/hook-audit.log` shows `{"hook":"session-start-record","session_id":"3e359511-...","action":"recorded"}`. Note: probe's in-command Tier 3a check still falls through because `CLAUDE_PLUGIN_ROOT` is unset in slash-command bash — but the hook writes the file fine because hooks DO get `CLAUDE_PLUGIN_ROOT`. Resolver's `ls -t ... *.active` path therefore works from any slash command as long as `stateBase()` can be resolved via other means (cwd-based default, env-var override, or plugin.json config when run under a process that has those). |
| Tier 3b jsonl filename (`~/.claude/projects/<slug>/<sid>.jsonl`) | **CONFIRMED in slash-command bash** | Current session `3e359511-...jsonl` appears as the most-recently-modified jsonl in the probe output. `basename` yields a valid session-id. |

### Checkboxes

- [x] Tier 1 env confirmed NOT AVAILABLE in slash-command bash (evidence: probe output)
- [x] Tier 2 stdin JSON confirmed NOT AVAILABLE in slash-command bash (evidence: probe output)
- [x] Tier 3b jsonl filename fallback confirmed present in slash-command bash (evidence: probe output)
- [x] Tier 3a SessionStart-written per-session file confirmed post-restart (evidence: `.mission-executor/state/sessions/3e359511-....active` written 2026-04-22T23:42Z + audit log entry)

### Implementation consequences

1. **The resolver's Tier 1 and Tier 2 paths will never fire from slash-command bash in Claude Code 2.1.117.** They remain in `scripts/_lib/resolve-sid.sh` as zero-cost safety nets for (a) other Claude Code entrypoints (hooks, subagents) where env/stdin may be populated, and (b) future Claude Code versions that may inject them. No code change needed.
2. **Tier 3b is load-bearing for slash-command bash.** It's the only path that resolves the session-id in cold-start slash-command context without knowing the state-base location.
3. **Tier 3a works from hooks but is dead from slash-command bash as currently written.** Hooks DO receive `CLAUDE_PLUGIN_ROOT` (session-start-record.mjs wrote a file correctly). Slash-command bash does NOT receive `CLAUDE_PLUGIN_ROOT`, so `resolve-sid.sh` line 22's guard skips Tier 3a and falls through to Tier 3b. This is acceptable for correctness (Tier 3b handles it) but Tier 3a is wasted work from slash commands.

### Followups (non-blocking)

- **A. Cross-project globbing in Tier 3b.** `ls -t "${HOME}/.claude/projects/"*/*.jsonl` takes the newest across ALL projects. Probe output shows interleaved jsonl files from `mek`, `mek-cse-tools`, `mcp-images-mcp`. If another project writes more recently during parallel sessions, Tier 3b returns the wrong session-id. **Mitigation**: scope the glob to the `$PWD`-derived slug (slashes→dashes, underscores→dashes, leading dash).
- **B. Tier 3a from slash-command bash.** Hardcode `${HOME}/.claude/mission-executor/state/sessions/` as an additional fallback candidate in `resolve-sid.sh`, OR have it shell out to a small Node helper that can compute `stateBase()` from `cwd()` via `paths.mjs`. Current behavior (fall-through to Tier 3b) is correct for single-project use.
- **C. Two coexisting state trees.** This repo currently has both `.omc/state/` (from OMC tooling) and `.mission-executor/state/` (from mission-executor post-restart). `paths.mjs` only autodetects `.omc` if `<project>/.omc/state/mission-executor-state.json` exists (line 63). Neither tree contains that sentinel, so the resolver correctly picks `.mission-executor`. Worth documenting somewhere that the autodetect sentinel is a specific file, not the presence of `.omc/state/`.

---

## §0.3 — `disable-model-invocation` frontmatter

- [ ] **DEFERRED**. Not verifiable from a probe. Requires invoking `commands/status.md` mid-turn under circumstances that would otherwise trigger auto-invocation by Claude. `commands/status.md` ships both the `disable-model-invocation: true` frontmatter AND a prose deterrent, so runtime behavior is correct regardless of whether Claude Code 2.1.117 honors the frontmatter key.

---

## §0.4 — `~/.claude/mission-executor/` ownership

- [x] **CLEAR**. `ls ~/.claude/` shows no `mission-executor/` directory and `find ~/.claude -maxdepth 3 -type d -name mission-executor` returns nothing. Path is free to claim.

Evidence captured 2026-04-22.

---

## Summary

With the live slash-command probe + post-restart SessionStart verification captured:

- **§0.1**: 4 of 4 tiers resolved. Tiers 1 and 2 are not populated in slash-command bash (safety nets only). Tier 3b works from slash-command bash. Tier 3a works from hooks and populates the `.active` file that Tier 3b-less callers (hook subprocesses, other Claude entrypoints) can consume.
- **§0.3**: Still deferred. Prose deterrent in `commands/status.md` makes the frontmatter verification non-blocking for release; correctness does not depend on the frontmatter key being honored.
- **§0.4**: Resolved — `~/.claude/mission-executor/` is not claimed by any other tooling (only plugin-system dirs `plugins/cache/` and `plugins/data/` exist, which are standard Claude Code plugin paths).

`scripts/selfcheck-hooks.mjs` can stop gating on §0.1 entirely. §0.3 should become a soft warning (or be removed) since it is not verifiable without mid-turn auto-invocation conditions.

The `/mission-executor:_probe` command has served its purpose and is safe to delete per its own frontmatter instruction. The three followups (A/B/C above) are tracked as non-blocking improvements.
