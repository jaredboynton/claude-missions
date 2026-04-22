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

- Phase 3 EXECUTE MUST prefer `/oh-my-claudecode:team` when the runtime
  exposes it. Only hand-roll `TeamCreate` + `Agent()` as a fallback (plain
  Claude Code without OMC, or stripped environments). The `/team` skill
  already implements stage routing, shutdown protocol, handoff docs, and
  state files; hand-rolling duplicates that contract inline and drifts
  from the OMC team runtime as it evolves. Detect availability via the
  available-skills system-reminder at session start.
- Never hand-write `validation-state.json`. `assertion-proof-guard.mjs` blocks
  it at the PreToolUse layer. Use `record-assertion.mjs` via
  `execute-assertion.mjs`.
- Worker claims in tool output (e.g. `VAL-XXX: PASS`) are audit-only and land
  in `.omc/validation/worker-claims.jsonl`. They do NOT flip status.
- Plugin scripts ignore the git status of the host working directory; they
  read `working_directory.txt` from the mission dir to locate repo state.

## Tuning `contract-lint.mjs`

The Phase 0.5 contract lint has four filters layered to drop noise while
keeping real contradictions. When a mission surfaces unexpected false
positives or misses a known contradiction, tune in this order:

1. **`GENERIC_WORDS` stoplist** in `scripts/contract-lint.mjs`. Add
   domain-generic backtick tokens (new HTTP verbs, common type names) that
   match too many AGENTS.md entries. Also add any new tool-type tokens if
   the contract vocabulary grows.

2. **External-code directories** in `walkAgentsMd`'s skip set. Add
   directories that contain reference or mirror AGENTS.md files that do not
   govern the project under test (e.g. new `.discovery/<lib>/`,
   `research/`, `third_party/`).

3. **`SUSPECT_PHRASES`**. These are the negations / trust-model flags that
   signal "this behavior is intentionally excluded from the contract's
   apparent demand". Add more roots if the contract starts surfacing new
   patterns (`opt-out`, `declined`, `deferred`, etc.).

4. **`ALIGN_ROOTS`** in `findContradictions`. When the assertion body
   contains any of these roots, the assertion is affirming (not
   contradicting) the AGENTS.md. Widen when assertions start using new
   synonymous phrasing.

Cross-paragraph filter (`\n\s*\n` between keyword and phrase) and
sentence-window (±150 chars) are structural and should not need tuning.

When rebuilding after tuning: bump `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` to the next patch version, commit, push,
then update via the TUI plugin menu as described above.
