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

- Phase 3 EXECUTE MUST evaluate the three-tier hierarchy before
  dispatch: (1) `/oh-my-claudecode:team` if the skill is loaded; (2)
  native Claude Code Agent Teams via `TeamCreate` + `Agent(team_name=...)`
  + `SendMessage` when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` exposes
  them in the tool catalog; (3) sequential `Agent()` fallback otherwise.
  Tier 1 and Tier 2 detection is inspection-only — grep the session's
  system-reminder at Phase 3 start for the skill name and tool names.
  Tier 2 additionally REQUIRES a smoke-probe with fall-through to
  Tier 3 on internal error (upstream issue #40270): spawn one
  throwaway `Agent(team_name=..., name="probe")` call with a trivial
  no-op prompt and 60s timeout before any real batch dispatch; on
  internal-error or timeout, abort Tier 2 for the whole mission and
  fall through to Tier 3. See SKILL.md Phase 3 "Tier selection" for
  the decision tree and Tier 2 caveats table (issues #33764, #40270,
  #32110/#32987, #23506 — each with mitigation). Never run
  mission-executor from `claude --agent <custom>` — upstream #23506
  makes `Agent` with `team_name` unavailable there, and the Phase 3
  degenerate-case abort fires if detected.
- Never hand-write `validation-state.json`. `assertion-proof-guard.mjs` blocks
  it at the PreToolUse layer. Use `record-assertion.mjs` via
  `execute-assertion.mjs`.
- Never hand-write `features.json`. `features-json-guard.mjs` blocks it at
  the PreToolUse layer. Use `sync-features-state.mjs` (git-HEAD-driven) or
  `reconcile-external-work.mjs --apply` (proof-gated).
- Worker claims in tool output (e.g. `VAL-XXX: PASS`) are audit-only and land
  in `.omc/validation/worker-claims.jsonl`. They do NOT flip status.
- Plugin scripts ignore the git status of the host working directory; they
  read `working_directory.txt` from the mission dir to locate repo state.
- `mission-lifecycle.mjs complete` is gated. It refuses to flip
  `state.active=false` unless completion criteria are met. Pass `--force`
  only when the spec itself is corrupt (logged).
- Stop hooks in Claude Code are flaky (upstream #22925, #29881, #8615,
  #12436). This plugin layers enforcement at PreToolUse (reliable) +
  Stop (best-effort) + lifecycle-gate. When iterating on hooks, do NOT
  assume Stop alone will catch bypasses; always add PreToolUse-layer
  enforcement as well.
- Every hook logs to `<wd>/.omc/state/hook-audit.log` via
  `hooks/_lib/audit.mjs`. First diagnostic when enforcement appears to
  be bypassed: `tail .omc/state/hook-audit.log` to verify the hook fired
  at all. If it didn't, check plugin enablement and Claude Code version
  compatibility with the `hookSpecificOutput.permissionDecision` schema.
- `write-handoff.mjs` is a STUB. Worker-return contract (workers writing
  `.omc/handoffs-inbox/<worker-id>.json` before shutdown) isn't implemented;
  under `--force` the script writes an advisory handoff marked `_unverified`.
  Sealed-milestone audits that require verified handoffs should use the
  droid CLI runtime, not Claude Code.
- `milestone-seal.mjs` is a STUB. `scrutiny-validator` and
  `user-testing-validator` are Factory-droid-runtime scripts. The stub
  probes for them via `DROID_SCRUTINY_BIN` / `DROID_USER_TESTING_BIN`
  env vars and common install paths; if absent it exits 2 loudly. The
  droid CLI lane is the canonical place to seal milestones.

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
