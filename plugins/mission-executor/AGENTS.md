# mission-executor — agent notes

## Updating the installed plugin in an active Claude Code TUI

`claude plugin update mission-executor@claude-missions` from a shell does NOT
refresh an already-running session (it also prints "already at latest version"
when the session's cached manifest matches, even after a marketplace push).

From inside the Claude Code TUI, update via the menu:

1. `/plugin`
2. Tab to **Installed**
3. Filter: `missions`
4. Select **mission-executor**
5. Arrow down to **Update now**, press Enter
6. `/reload-plugins`

Bump `plugin.json` and `marketplace.json` versions before pushing; the update
menu only surfaces "Update now" when the marketplace version is newer than
the installed version.

## Canonical commands for agents

- Validate mission schema + Factory harness: `node scripts/validate-mission.mjs <mission-path>`
- Execute one assertion end-to-end with proof: `MISSION_EXECUTOR_WRITER=1 node scripts/execute-assertion.mjs <mission-path> --id=VAL-XXX-NNN`
- Invalidate stale proofs: `node scripts/invalidate-stale-evidence.mjs <mission-path>`
- Contract vs AGENTS.md contradictions: `node scripts/contract-lint.mjs <mission-path>`
- Two-stage critic: `node scripts/critic-evaluator.mjs <mission-path>`
- Reconcile feature state from proofs + commits: `node scripts/reconcile-external-work.mjs <mission-path> --apply`

## Rules specific to this plugin

- Never hand-write `validation-state.json`. `assertion-proof-guard.mjs` blocks
  it at the PreToolUse layer. Use `record-assertion.mjs` via
  `execute-assertion.mjs`.
- Worker claims in tool output (e.g. `VAL-XXX: PASS`) are audit-only and land
  in `.omc/validation/worker-claims.jsonl`. They do NOT flip status.
- Plugin scripts ignore the git status of the host working directory; they
  read `working_directory.txt` from the mission dir to locate repo state.
