# mission-executor — agent notes

## Project Overview

`mission-executor` is a Claude Code plugin that runs Factory/droid missions on
autopilot. It reads `.factory/missions/<id>/` (mission.md, features.json,
state.json, validation-state.json, working_directory.txt), decomposes work into
parallel team batches, dispatches workers, re-validates every assertion
independently, and loops until a critic returns a 100% pass rate.

Primary users are Claude Code operators who have already written a Factory
mission spec and want the plugin to drive it to completion without manual
orchestration.

The plugin optimizes for:
- **Independent validation** — workers are assumed to lie; every assertion
  is re-executed against the tree at a recorded commit SHA
- **Hook-level enforcement** — mission boundaries (NEVER-rules, write guards,
  completion gates) are enforced at PreToolUse, never via prompt trust
- **State write-back** — `features.json` is re-synced from git HEAD after
  every batch; `validation-state.json` is mutated only via proof-gated scripts
- **External-work reconciliation** — features that landed in git HEAD before
  dispatch are scored and marked complete so the runner doesn't re-do them
- **Idempotent re-entry** — `/mission-executor:execute` on an active mission
  attaches the current session instead of starting a new run

Avoid introducing orchestration tiers beyond the three documented below
(sequential `Agent()`, native Agent Teams, OMC `/team`) without a CHANGELOG
design note.

## Tech Stack

- Node.js ES modules (`.mjs`), stdlib-only — no dependencies
- POSIX shell for slash-command entrypoints (`commands/*.md`) and the
  session-id resolver (`scripts/_lib/resolve-sid.sh`)
- Python 3 (stdlib) — optional second opinion in `validate-mission.mjs`
  when a Factory harness is reachable via walk-up
- Tests: `node:test` + `node:assert/strict`
- Runtime: Claude Code plugin loader (`plugin.json` + `hooks/hooks.json`)

Do not introduce:
- npm / yarn / pnpm dependencies
- TypeScript or any build step
- external schema validators (ajv, zod, yup) — use `scripts/_lib/schemas.mjs`
- external test runners (vitest, jest, mocha) — use `node --test`

## Architecture

```
plugins/mission-executor/
├── .claude-plugin/
│   └── plugin.json             Manifest + version. "hooks": "./hooks/hooks.json" declared.
├── commands/                   Slash-command markdown (execute, detach, status, abort)
├── hooks/
│   ├── hooks.json              Discovery path — MUST live here, not in .claude-plugin/
│   ├── _lib/
│   │   ├── paths.mjs           Single source of truth for on-disk layout
│   │   ├── mission-state.mjs   Attached-session gate, legacy-migration emitter
│   │   ├── audit.mjs           hook-audit.log append helper
│   │   └── ...
│   ├── worker-boundary-enforcer.mjs    PreToolUse Bash|Edit|Write
│   ├── commit-scope-guard.mjs          PreToolUse Bash
│   ├── assertion-proof-guard.mjs       PreToolUse Edit|Write (validation-state.json)
│   ├── features-json-guard.mjs         PreToolUse Edit|Write (features.json)
│   ├── no-ask-during-mission.mjs       PreToolUse AskUserQuestion
│   ├── build-discipline.mjs            PostToolUse Edit|Write
│   ├── validation-tracker.mjs          PostToolUse Bash|Read|Grep|Glob
│   ├── autopilot-lock.mjs              Stop
│   └── session-start-record.mjs        SessionStart
├── scripts/
│   ├── _lib/                   Shared helpers. progress-log, schemas, lockfile, etc.
│   ├── mission-cli.mjs         Lifecycle entrypoint (resolve/start/attach/detach/status/phase/complete/abort/event)
│   ├── mission-lifecycle.mjs   Thin back-compat delegator to mission-cli
│   ├── execute-assertion.mjs   End-to-end assertion runner with proof bundles
│   ├── record-assertion.mjs    Proof-gated validation-state.json mutator
│   ├── sync-features-state.mjs git-HEAD-driven features.json reconciler
│   ├── reconcile-external-work.mjs     Proof-gated features.json reconciler
│   ├── critic-evaluator.mjs    Two-stage verdict
│   ├── contract-lint.mjs       Contract vs AGENTS.md contradiction scanner
│   ├── invalidate-stale-evidence.mjs
│   ├── write-handoff.mjs       Schema-validated worker-return writer (v0.5.1+)
│   ├── selfcheck-hooks.mjs     Release gate — hook discovery + layout probe
│   └── validate-mission.mjs    JS + Python harness cross-check
├── skills/                     SKILL.md bundles loaded by slash-commands
└── tests/                      node:test files, one per module
```

Data flow (happy path):

```
Operator runs /mission-executor:execute <path>
  → mission-cli.mjs resolve + start (or attach)
  → registers session in state.attachedSessions[]
  → writes mission_started event to <missionPath>/progress_log.jsonl
  → mission-execute skill takes over:
      Phase 0: selfcheck-hooks + validate-mission + contract-lint
      Phase 1: reconcile-external-work (git HEAD → features.json)
      Phase 2: decompose-features → batch plan
      Phase 3: dispatch batch (Tier 1/2/3 — see below)
      Phase 4: re-validate every assertion via execute-assertion
      Phase 4b: write-handoff per worker (schema-validated)
      Phase 5: sync-features-state
      Phase 6: critic-evaluator (two-stage)
      Phase 7: loop or complete
```

Rules:
- Every on-disk path goes through `hooks/_lib/paths.mjs`. No hardcoded
  `.mission-executor/` or `.omc/` literals outside that module.
- Plugin scripts ignore the git status of the host CWD; they read
  `working_directory.txt` from the mission dir to locate repo state.
- Hook enforcement > prompt trust. Every NEVER-rule is backed by a hook.
- The 8 enforcement hooks write to `hook-audit.log`; the progress-log
  (mission event stream) is a separate channel owned by `mission-cli.mjs`
  and `write-handoff.mjs`. Bright line — do not cross.

## Coding Conventions

- Node ES modules only. File extension `.mjs`. No CommonJS.
- `#!/usr/bin/env node` shebang on every script entrypoint.
- Use `node:`-prefixed imports exclusively (`node:fs`, `node:path`, `node:child_process`).
- Prefer sync I/O in short-lived script entrypoints; async only for real concurrency.
- Exit codes: `0` success; `1` error; `2` bad args; `3+` domain-specific
  (e.g. mission-cli `event` returns `3` for not-attached, `4` for bad input).
- Silent-swallow pattern for progress-log writes: a progress-log failure
  MUST NEVER fail the calling command. See `mission-cli.mjs > emitEvent`.
- All on-disk paths via `hooks/_lib/paths.mjs` helpers.
- Never hand-write `validation-state.json` — `assertion-proof-guard.mjs`
  blocks it at PreToolUse. Route through `record-assertion.mjs` via
  `execute-assertion.mjs`.
- Never hand-write `features.json` — `features-json-guard.mjs` blocks it.
  Use `sync-features-state.mjs` (git-HEAD-driven) or
  `reconcile-external-work.mjs --apply` (proof-gated).
- Schema validation is hand-rolled in `scripts/_lib/schemas.mjs`. Shape:
  `validate(schema, value) → { ok: true, value } | { ok: false, errors: string[] }`.
- Tests use `import { test } from "node:test"` + `assert from "node:assert/strict"`.
  Fixtures in `tests/_mission-fixture.mjs`, helpers in `tests/_helpers.mjs`.
- `CHANGELOG.md` is append-only, dated, per-version.

## Testing and Quality

Before considering a task complete:

```sh
cd plugins/mission-executor
node --test tests/
node scripts/selfcheck-hooks.mjs
```

Release gates:
- `node --test tests/` all green
- `node scripts/selfcheck-hooks.mjs` exits 0 (catches hook discovery + path regressions)
- Shadow harness against a real corpus mission when modifying
  `execute-assertion.mjs > dispatchShellGeneric` or any recognizer
  (see Appendix D "Regression-safety gates")

Testing rules:
- One test file per module under test
- Concurrency-sensitive code gets a multi-writer stress test
  (see `tests/progress-log.test.mjs` — 20 parallel writers, atomic-append check)
- Legacy-migration paths require a concurrent-migration test
  (see `tests/hooks.in-flight-migration.concurrent.test.mjs`)
- Contract-lint, critic-evaluator, and execute-assertion each carry a
  "defect N regression" test — preserve and extend these when refactoring

## File and Component Placement Rules

- New enforcement hook → `hooks/<name>.mjs` + add entry to `hooks/hooks.json`
- New orchestration script → `scripts/<verb>-<noun>.mjs`
- Shared helper used by ≥2 scripts → `scripts/_lib/<name>.mjs`
- New on-disk path → add helper to `hooks/_lib/paths.mjs`, never inline
- New slash command → `commands/<name>.md` (namespaced `/mission-executor:<name>`)
- New skill → `skills/<name>/SKILL.md`
- Tests → `tests/<module>.test.mjs`
- Design notes / deferred work → CHANGELOG "Deferred" section or Appendix here

Do not:
- Create duplicate helpers between `scripts/_lib/` and `hooks/_lib/`
  (progress-log lives in `scripts/_lib/`, paths live in `hooks/_lib/` —
  scripts import from hooks/_lib, not the other way)
- Invent a new abstraction for one-off usage (inline in the caller)
- Add orchestration tiers beyond the three documented in Appendix A

## Safe-Change Rules

- Do not bump `plugin.json` / `marketplace.json` version without a matching
  `CHANGELOG.md` entry in the same commit
- Do not rename or delete exports from `hooks/_lib/paths.mjs` — 1.0.0 candidate
- Do not remove the `.omc/` autodetect branch in `paths.mjs > layoutRoot()`
  without a documented migration for 0.4.x missions — 1.0.0 candidate
- Do not move `hooks/hooks.json` into `.claude-plugin/` — Claude Code's
  auto-discovery only scans `hooks/hooks.json`; `.claude-plugin/hooks.json`
  is silently ignored. 0.4.5 shipped that way and every mission ran with
  zero enforcement. `plugin.json` also declares `"hooks": "./hooks/hooks.json"`
  as belt-and-braces.
- Do not assume Stop hooks alone catch bypasses — they are flaky in Claude
  Code (upstream #22925, #29881, #8615, #12436). Always layer PreToolUse
  enforcement alongside Stop.
- Do not change the worker-return schema (`workerHandoffSchema`) without
  coordinating with droid — we track a subset of droid's shapes and
  re-review every major droid release
- Do not change tier order (native `Agent()` Tier 1, native Teams Tier 2,
  OMC `/team` Tier 3) without a design note

## Commands

Development:

```sh
# Run full test suite
node --test tests/

# Release-gate checks
node scripts/selfcheck-hooks.mjs

# Validate a mission spec (JS + optional Python harness)
node scripts/validate-mission.mjs <mission-path>

# Execute one assertion end-to-end with proof
MISSION_EXECUTOR_WRITER=1 node scripts/execute-assertion.mjs <mission-path> --id=VAL-XXX-NNN

# Invalidate stale proofs when HEAD moves
node scripts/invalidate-stale-evidence.mjs <mission-path>

# Contract vs AGENTS.md contradictions
node scripts/contract-lint.mjs <mission-path>

# Two-stage critic
node scripts/critic-evaluator.mjs <mission-path>

# Reconcile feature state from proofs + commits
node scripts/reconcile-external-work.mjs <mission-path> --apply
```

Update the installed plugin in an active Claude Code TUI
(`claude plugin update` from the shell does NOT refresh a running session):

```
/plugin  →  Installed  →  filter: missions  →  mission-executor  →  Update now
/reload-plugins
```

Bump both `plugin.json` and `marketplace.json` before pushing; the update
menu only surfaces "Update now" when the marketplace version is newer than
the installed version.

---

## Appendix A — Tier hierarchy (Phase 3 dispatch)

Phase 3 EXECUTE MUST evaluate this three-tier hierarchy before dispatch
(v0.5.0 order — native-first, OMC-last):

1. **Tier 1** — sequential `Agent()`. Always available, zero deps, baseline.
2. **Tier 2** — native Claude Code Agent Teams. `TeamCreate` +
   `Agent(team_name=...)` + `SendMessage` when
   `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` exposes them in the tool catalog.
3. **Tier 3** — `/oh-my-claudecode:team`. Optional; used only when OMC is
   detected AND the batch has ≥3 parallel features that benefit from OMC's
   pane/handoff machinery.

Tier detection is inspection-only — grep the session's system-reminder at
Phase 3 start for the skill name and tool names.

Tier 2 additionally REQUIRES a smoke-probe with fall-through to Tier 1 on
internal error (upstream issue #40270): spawn one throwaway
`Agent(team_name=..., name="probe")` call with a trivial no-op prompt and
60s timeout before any real batch dispatch; on internal-error or timeout,
abort Tier 2 for the whole mission and fall through to Tier 1.

Never run mission-executor from `claude --agent <custom>` — upstream #23506
makes `Agent` with `team_name` unavailable there, and the Phase 3
degenerate-case abort fires if detected.

See `skills/mission-execute/SKILL.md` Phase 3 "Tier selection" for the
decision tree and Tier 2 caveats table (issues #33764, #40270,
#32110/#32987, #23506 — each with mitigation).

## Appendix B — Hook diagnostic protocol

Every hook logs to `auditLogFile()` (`<layoutRoot>/state/hook-audit.log` —
resolved via `hooks/_lib/paths.mjs`) via `hooks/_lib/audit.mjs`.

First diagnostic when enforcement appears to be bypassed: compare session
tool calls against `hookInfos` entries in
`~/.claude/projects/<cwd-encoded>/<session-id>.jsonl`. That is Claude Code's
own record of which hook commands it dispatched for each event.

- If mission-executor hooks are absent from `hookInfos` (or the `command`
  field inside them doesn't mention our `.mjs` files), Claude Code never
  registered them.
- The audit log is only written when hooks actually run, so an empty log
  could mean either "hook ran but audit failed" or "hook never registered".
  `hookInfos` disambiguates.

Run `node scripts/selfcheck-hooks.mjs` before any release to catch
discovery-path regressions.

## Appendix C — Tuning `contract-lint.mjs`

The Phase 0.5 contract lint has four filters layered to drop noise while
keeping real contradictions. When a mission surfaces unexpected false
positives or misses a known contradiction, tune in this order:

1. **`GENERIC_WORDS` stoplist** in `scripts/contract-lint.mjs`. Add
   domain-generic backtick tokens (new HTTP verbs, common type names) that
   match too many AGENTS.md entries. Also add new tool-type tokens if the
   contract vocabulary grows.
2. **External-code directories** in `walkAgentsMd`'s skip set. Add
   directories that contain reference or mirror AGENTS.md files that do not
   govern the project under test (e.g. `.discovery/<lib>/`, `research/`,
   `third_party/`).
3. **`SUSPECT_PHRASES`**. Negations / trust-model flags that signal "this
   behavior is intentionally excluded from the contract's apparent demand."
   Add more roots if the contract surfaces new patterns (`opt-out`,
   `declined`, `deferred`).
4. **`ALIGN_ROOTS`** in `findContradictions`. When the assertion body
   contains any of these roots, the assertion is affirming (not
   contradicting) the AGENTS.md. Widen when assertions start using new
   synonymous phrasing.

Cross-paragraph filter (`\n\s*\n` between keyword and phrase) and
sentence-window (±150 chars) are structural and should not need tuning.

## Appendix D — Deferred: broader `dispatchShellGeneric` evidence extraction

Status: deferred from 0.5.0. Five evidence shapes the 0.4.6 dispatcher
can't extract, three flaws that killed the 0.5.0 draft.

**Target patterns:**

1. **Brace expansion** — `test ! -e cse-tools/deploy/{Dockerfile,entrypoint.sh,crontab}`.
   Expand pre-shell, run one command per token, AND-reduce. Repro: VAL-CLEANUP-001 in 038bc065.
2. **Compound-AND** — two+ backticked commands joined by `;`, `+`, `AND`.
   Today only the first runs. Repro: VAL-TF-009.
3. **List-as-anchor** — backticked `a.sh, b.sh, c.sh` + prose "each under
   `deploy/packer/scripts/`" + "test -x". Emit `test -x <prefix><file>`
   per file, AND-reduce. Repro: VAL-PACKER-002.
4. **Alternation-as-grep** — backticked `cp -r|tar -xf|rsync` + prose
   "no cp/tar/rsync into /home/cse". Emit `! grep -qE '...' <path>`. Repro: VAL-PACKER-019.
5. **Negation list** — backticked `AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY`
   + prose "contains no" / "absent". Emit negative grep. Repro: VAL-CI-004.

**Three flaws that killed the 0.5.0 draft:**

1. **Fall-through ordering is wrong.** Recognizers must run BEFORE
   `tryExtract`, not after. Only VAL-PACKER-002 and VAL-CI-004 are reachable
   via fall-through; the other three get a runnable-looking command out of
   `tryExtract` first. Plan Phase 3 "Refactor shape" mermaid had this right:
   parse → plan → execute, with `parseEvidencePlanBasic` as last fallback.
2. **`recognizeAlternation` kills its own target.** The draft rejected any
   backticked block matching `EXEC_PREFIX_RE` (`cp|tar|rsync|...`), but
   VAL-PACKER-019 starts with `cp`. Split on `|` first, then accept if every
   piece is individually in `EXEC_PREFIX`.
3. **cwd inference is a prerequisite.** Meta-repo missions (`.meta` at root,
   children with own `.git/`) need `resolveChildRepo`-based cwd inference
   or recognizer-emitted commands false-fail. Land cwd inference in the
   same change.

**Regression-safety gates (non-negotiable):**

- **Shadow harness against a real mission.** Plan AC3.2 required replaying
  every currently-`passed` shell-generic assertion in `038bc065` through
  both the 0.4.6 and new dispatcher with zero verdict divergences. A
  synthetic fixture is not a substitute.
- **Stage B interaction.** `execute-assertion` returns exit 2 on `blocked`,
  which `critic-evaluator.mjs:144-147` treats as non-regression. Any
  recognizer that flips exit 2 → exit 1 on a Path-2 (manually-recorded)
  assertion produces a Stage B divergence. Treat "no new Stage B
  divergences on corpus" as a release gate.

Recover the recognizer draft with
`git show HEAD:plugins/mission-executor/scripts/_lib/evidence-recognizers.mjs`
once 0.5.0 is tagged; brace-expansion, compound-AND, list-anchor, and
negation-list recognizers are largely salvageable modulo the ordering fix.

## Appendix E — State-file guards

- Never hand-write `validation-state.json`. `assertion-proof-guard.mjs`
  blocks it at PreToolUse. Use `record-assertion.mjs` via `execute-assertion.mjs`.
- Never hand-write `features.json`. `features-json-guard.mjs` blocks it.
  Use `sync-features-state.mjs` (git-HEAD-driven) or
  `reconcile-external-work.mjs --apply` (proof-gated).
- Worker claims in tool output (e.g. `VAL-XXX: PASS`) are audit-only and
  land in `claimsLogFile()` (`<layoutRoot>/validation/worker-claims.jsonl`).
  They do NOT flip status.
- `mission-cli.mjs complete` is gated. It refuses to flip
  `state.active=false` unless completion criteria are met. Pass `--force`
  only when the spec itself is corrupt (logged). `mission-lifecycle.mjs
  complete` still works as a thin delegator for back-compat.
- `write-handoff.mjs` (v0.5.1+) validates input against `workerHandoffSchema`
  from `scripts/_lib/schemas.mjs`. Exit 0 → file at
  `<missionPath>/handoffs/<ts>__<feat>__<worker>.json` + `handoff_written`
  event. Exit 1 → schema errors, no file, no log. Exit 2 → bad args. Use
  `--force-skip-validation` only when recovering from a corrupt spec; the
  output gets tagged `_unverified: true` AND the progress_log entry carries
  `unverified: true`.
- `milestone-seal.mjs` is a STUB. `scrutiny-validator` and
  `user-testing-validator` are Factory-droid-runtime scripts. The stub
  probes via `DROID_SCRUTINY_BIN` / `DROID_USER_TESTING_BIN` env vars and
  common install paths; if absent it exits 2 loudly. The droid CLI lane is
  the canonical place to seal milestones.

## Appendix F — Progress log + worker-return contract (v0.5.1+)

See `CHANGELOG.md` for the feature overview. Quick reference:

- `<missionPath>/progress_log.jsonl` is the per-mission event stream
- Write via `mission-cli.mjs event <type>` or let lifecycle subcommands auto-emit
- `scripts/write-handoff.mjs` validates against `workerHandoffSchema` in
  `scripts/_lib/schemas.mjs`
- The 8 enforcement hooks do NOT touch progress_log — they stay on
  `hook-audit.log`. Bright line.
