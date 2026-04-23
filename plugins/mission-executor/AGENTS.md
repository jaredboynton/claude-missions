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

- Phase 3 EXECUTE MUST evaluate the three-tier hierarchy before dispatch
  (v0.5.0 order — native-first, OMC-last):
  (1) **Tier 1** sequential `Agent()` — always available, zero deps, baseline;
  (2) **Tier 2** native Claude Code Agent Teams — `TeamCreate` + `Agent(team_name=...)`
  + `SendMessage` when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` exposes them
  in the tool catalog;
  (3) **Tier 3** `/oh-my-claudecode:team` — optional; used only when OMC is
  detected AND the batch has ≥3 parallel features that benefit from OMC's
  pane/handoff machinery.
  Tier detection is inspection-only — grep the session's system-reminder at
  Phase 3 start for the skill name and tool names. Tier 2 additionally REQUIRES
  a smoke-probe with fall-through to Tier 1 on internal error (upstream issue
  #40270): spawn one throwaway `Agent(team_name=..., name="probe")` call with
  a trivial no-op prompt and 60s timeout before any real batch dispatch; on
  internal-error or timeout, abort Tier 2 for the whole mission and fall
  through to Tier 1. See SKILL.md Phase 3 "Tier selection" for the decision
  tree and Tier 2 caveats table (issues #33764, #40270, #32110/#32987, #23506
  — each with mitigation). Never run mission-executor from `claude --agent <custom>`
  — upstream #23506 makes `Agent` with `team_name` unavailable there, and the
  Phase 3 degenerate-case abort fires if detected.
- Never hand-write `validation-state.json`. `assertion-proof-guard.mjs` blocks
  it at the PreToolUse layer. Use `record-assertion.mjs` via
  `execute-assertion.mjs`.
- Never hand-write `features.json`. `features-json-guard.mjs` blocks it at
  the PreToolUse layer. Use `sync-features-state.mjs` (git-HEAD-driven) or
  `reconcile-external-work.mjs --apply` (proof-gated).
- Worker claims in tool output (e.g. `VAL-XXX: PASS`) are audit-only and land
  in `claimsLogFile()` (`<layoutRoot>/validation/worker-claims.jsonl` —
  resolved via `hooks/_lib/paths.mjs`). They do NOT flip status.
- Plugin scripts ignore the git status of the host working directory; they
  read `working_directory.txt` from the mission dir to locate repo state.
- `mission-cli.mjs complete` is gated. It refuses to flip
  `state.active=false` unless completion criteria are met. Pass `--force`
  only when the spec itself is corrupt (logged). `mission-lifecycle.mjs complete`
  still works as a thin delegator for back-compat.
- Stop hooks in Claude Code are flaky (upstream #22925, #29881, #8615,
  #12436). This plugin layers enforcement at PreToolUse (reliable) +
  Stop (best-effort) + lifecycle-gate. When iterating on hooks, do NOT
  assume Stop alone will catch bypasses; always add PreToolUse-layer
  enforcement as well.
- Every hook logs to `auditLogFile()` (`<layoutRoot>/state/hook-audit.log` —
  resolved via `hooks/_lib/paths.mjs`) via `hooks/_lib/audit.mjs`. First
  diagnostic when enforcement appears to be bypassed: compare session tool
  calls against `hookInfos` entries in
  `~/.claude/projects/<cwd-encoded>/<session-id>.jsonl`. That is Claude
  Code's own record of which hook commands it dispatched for each event.
  If mission-executor hooks are absent from `hookInfos` (or the `command`
  field inside them doesn't mention our `.mjs` files), Claude Code never
  registered them. The audit log is only written when hooks actually run,
  so an empty log could mean either "hook ran but audit failed" or "hook
  never registered"; `hookInfos` disambiguates.
- Every on-disk path goes through `hooks/_lib/paths.mjs` — no hardcoded
  `.omc/...` or `.mission-executor/...` literals outside that module.
  Selfcheck (`scripts/selfcheck-hooks.mjs`) greps for `.omc/state/` and
  `.omc/validation/` literals and fails the release if any slip in. Legacy
  `.omc/` installs continue working via the autodetect branch in
  `paths.mjs > layoutRoot()` (triggered by the sentinel file
  `<project>/.omc/state/mission-executor-state.json`); removing that
  branch is a 1.0.0 candidate, not a 0.5.x change.
- **Progress log + worker-return contract (v0.5.1+)**: see `CHANGELOG.md`
  for the feature overview. Quick reference:
  `<missionPath>/progress_log.jsonl` is the per-mission event stream;
  write via `mission-cli.mjs event <type>` or let lifecycle subcommands
  auto-emit. `scripts/write-handoff.mjs` validates against
  `workerHandoffSchema` in `scripts/_lib/schemas.mjs`. The 8 enforcement
  hooks do NOT touch progress_log — they stay on `hook-audit.log`.
- **Hook registration**: `hooks/hooks.json` lives at the plugin root, NOT
  in `.claude-plugin/`. Claude Code's auto-discovery only scans
  `hooks/hooks.json`; `.claude-plugin/hooks.json` is silently ignored
  (0.4.5 shipped that way and every mission ran with zero enforcement).
  We also set `"hooks": "./hooks/hooks.json"` in `plugin.json` as a
  belt-and-braces explicit declaration. Run
  `node scripts/selfcheck-hooks.mjs` before any release to catch
  discovery-path regressions.
- `write-handoff.mjs` (v0.5.1+) validates input against `workerHandoffSchema`
  from `scripts/_lib/schemas.mjs`. Exit 0 -> file at
  `<missionPath>/handoffs/<ts>__<feat>__<worker>.json` + `handoff_written`
  event appended to `<missionPath>/progress_log.jsonl`. Exit 1 -> schema
  errors on stdout, no file, no log entry. Exit 2 -> bad args. Use
  `--force-skip-validation` only when recovering from a corrupt spec; the
  output gets tagged `_unverified: true` AND the progress_log entry carries
  `unverified: true` so post-mortems can spot them.
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

## Deferred: broadening `dispatchShellGeneric` evidence extraction (defect 1)

Status: deferred from 0.5.0. Background in
`/Users/jaredboynton/__devlocal/mek/.omc/state/HANDOFF-mission-executor-plugin-fixes.md`
section "Defect 1". `scripts/_lib/evidence-recognizers.mjs` carried a first
draft — removed in 0.5.0 after a design-review pass found three landable
flaws (below). The taxonomy and the redesign constraints are kept here so
the next attempt starts from a corrected base.

### Target patterns (five shapes the 0.4.6 dispatcher can't extract)

1. **Brace expansion** — `test ! -e cse-tools/deploy/{Dockerfile,entrypoint.sh,crontab}`.
   Today the basic dispatcher emits `bash -lc "test ! -e .../{...}"` verbatim
   and the shell glob fails. Expand the brace group pre-shell, run one
   command per token, AND-reduce exits. Repro: VAL-CLEANUP-001 in 038bc065.

2. **Compound-AND** — two+ backticked commands joined by `;`, `+`, `AND`.
   Today the dispatcher runs only the first backticked block. Repro:
   VAL-TF-009 (five independent greps).

3. **List-as-anchor** — backticked `a.sh, b.sh, c.sh` + prose "each under
   `deploy/packer/scripts/`" + "test -x". Today neither the filenames nor
   the prose hint is runnable. Emit `test -x <prefix><file>` per file,
   AND-reduce. Repro: VAL-PACKER-002.

4. **Alternation-as-grep** — backticked `cp -r|tar -xf|rsync` + prose
   "no cp/tar/rsync into /home/cse". Today the dispatcher runs the first
   token `cp -r`, which exits non-zero (no args). Emit
   `! grep -qE '...' <path>`. Repro: VAL-PACKER-019.

5. **Negation list** — backticked `AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY`
   + prose "contains no" / "absent". Emit negative grep. Repro: VAL-CI-004.

### Three flaws that killed the 0.5.0 draft

1. **Fall-through-on-blocked ordering is wrong.** Recognizers must run
   **before** `tryExtract`, not after. Only VAL-PACKER-002 and VAL-CI-004
   are reachable via fall-through; the other three targets (VAL-CLEANUP-001,
   VAL-PACKER-019, VAL-TF-009) get a runnable-looking command out of
   `tryExtract` first. The plan's "Refactor shape" mermaid (plan Phase 3)
   had this right: parse → plan → execute, with `parseEvidencePlanBasic`
   as the last fallback.

2. **`recognizeAlternation` kills its own target.** The draft rejects any
   backticked block matching `EXEC_PREFIX_RE` (`cp|tar|rsync|...`), but
   VAL-PACKER-019's evidence STARTS with `cp`. The alternation check must
   split on `|` first, then accept if every split piece is individually
   in `EXEC_PREFIX` — the concatenation is not a valid command, but each
   piece is a valid grep target.

3. **cwd inference is a prerequisite, not a nice-to-have.** In meta-repo
   missions (`.meta` at root, children with own `.git/`), contract
   evidence paths like `deploy/terraform/main.tf` live under `cse-tools/`.
   Without `resolveChildRepo`-based cwd inference (already landed in 0.5.0
   for HEAD SHA resolution), recognizer-emitted commands run with cwd =
   workspace root and false-fail. Land cwd inference in the same change.

### Regression-safety gates (non-negotiable for 0.5.1)

- **Shadow harness against a real mission.** The plan's AC3.2 required
  replaying every currently-`passed` shell-generic assertion in a corpus
  mission (`038bc065` is the canonical) through both the 0.4.6 and new
  dispatcher, with zero verdict divergences. A synthetic fixture is not
  a substitute.
- **Stage B interaction.** Today `execute-assertion` returns exit 2 on
  `blocked`, which `critic-evaluator.mjs:144-147` treats as non-regression.
  Any recognizer that flips exit 2 → exit 1 on a Path-2 (manually-recorded)
  assertion produces a Stage B divergence, which together with
  `critic-evaluator.mjs:118`'s `Math.random` sampling recreates
  defect-2-style flapping at the verdict layer. Treat "no new Stage B
  divergences on corpus" as a release gate, not an afterthought.

Recover the recognizer draft with
`git show HEAD:plugins/mission-executor/scripts/_lib/evidence-recognizers.mjs`
once 0.5.0 is tagged; the brace-expansion, compound-AND, list-anchor, and
negation-list recognizers are largely salvageable modulo the ordering fix.
