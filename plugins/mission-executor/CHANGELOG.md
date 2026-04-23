# mission-executor changelog

All notable changes per release. Dates are the commit date of the version
bump in [.claude-plugin/plugin.json](.claude-plugin/plugin.json).

## 0.8.0 — 2026-04-22

Project-scoped state relocates from the working directory to the user
home. Before 0.8.0, every Claude Code session in every repo where the
plugin was enabled created `<cwd>/.mission-executor/state/`, even when
no mission was ever attached — four hooks logged to `hook-audit.log` on
every Bash/Edit/Write call, and `session-start-record.mjs` wrote a
session marker regardless. The result was `.mission-executor/` showing
up in unrelated repos and staying there.

### Changed

- **Default `layoutRoot()` moved to user-global**: now
  `~/.claude/mission-executor/projects/<slug>/` where `<slug>` matches
  Claude Code's project-slug scheme used at `~/.claude/projects/<slug>/`
  (absolute path with `/` and `_` collapsed to `-`). The `.omc/state/`
  autodetect branch in `paths.mjs > layoutRoot()` was deleted — it was
  the v0.5.x back-compat path that produced the pollution. Env-var
  escape hatches (`MISSION_EXECUTOR_LAYOUT_ROOT`,
  `MISSION_EXECUTOR_STATE_DIR`) and `plugin.json config.layoutRoot`
  still override and take priority.
- **`audit()` honors `opts.skipIfNoMission`** in
  `hooks/_lib/audit.mjs`. When the caller passes `{ skipIfNoMission: true }`
  AND no `mission-executor-state.json` exists for the project, the
  audit line is suppressed. The four hooks that used to log
  unconditionally — `worker-boundary-enforcer` (no-mission early
  return), `assertion-proof-guard` (wrong-tool/wrong-file/error paths),
  `features-json-guard` (same), `session-start-record` (per-session
  marker) — now pass the flag on their no-op paths. Deny-path audits
  (actual blocks) remain unconditional. Result: projects that have
  never started a mission get zero audit writes.
- **`registryFile()` anchored to `userBase()`** in `paths.mjs` (was a
  manually built `$HOME/.claude/mission-executor/registry.json`). The
  path is identical to pre-0.8.0; only the composition changed.

### Added

- **`userBase()` and `projectSlug(absPath)`** helpers in
  `hooks/_lib/paths.mjs`. `userBase()` returns
  `~/.claude/mission-executor/`. `projectSlug()` converts an absolute
  project path to the filesystem-safe slug used for directory naming;
  rejects relative or empty input.
- **`migrateProjectStateToUserGlobal(workingDir)`** in
  `scripts/_lib/migrate.mjs`. Probes `<workingDir>/.mission-executor/state/`
  and `<workingDir>/.omc/state/`; if `mission-executor-state.json` is
  present, recursively copies the state directory to the user-global
  location. Idempotent: if the target already has state, both sides
  are left alone with a stderr warning. Honors the env-var escape
  hatches by bailing with `skipped: "env-override-active"`. Originals
  are never deleted — operators clean up manually after verifying.
  Called from `mission-cli.mjs > cmdStart` and `cmdAttach` on entry.
- **`tests/paths.v080.test.mjs`** (7 tests): default layout, `.omc`
  regression guard, slug rules, `$HOME` override, `registryFile`
  location, env override still wins.
- **`tests/migrate.project-state.test.mjs`** (7 tests):
  `.mission-executor/` migration, `.omc/` migration, no-legacy,
  target-exists conflict, idempotence, env-override suppression,
  arg validation.

### Removed

- **`.omc/state/mission-executor-state.json` autodetect branch** in
  `paths.mjs > layoutRoot()`. In-flight 0.5.x installs migrate via
  `migrateProjectStateToUserGlobal()` on next mission start/attach.
- **Two obsolete tests in `tests/paths.test.mjs`**
  ("Legacy autodetect: .omc/state/..." and "Default: ... -> .mission-executor").
  Both asserted pre-0.8.0 behaviors that no longer exist. Replaced by
  `tests/paths.v080.test.mjs`.

### Migration notes

- No operator action required. First mission start or attach in a
  project that has legacy state under `<cwd>/.mission-executor/state/`
  or `<cwd>/.omc/state/` copies it into the user-global location and
  emits one stderr line: `mission-executor: migrated project state
  from <old> to <new>`. Subsequent runs no-op. Legacy directories are
  preserved so operators can diff before deleting.
- Projects with the env overrides (`MISSION_EXECUTOR_LAYOUT_ROOT` or
  `MISSION_EXECUTOR_STATE_DIR`) are unaffected; migration bails with
  `skipped: "env-override-active"`.
- The cross-project `registry.json` lives at the same path as before
  (`~/.claude/mission-executor/registry.json`); no migration needed.
- `selfcheck-hooks.mjs` allowlist: `scripts/_lib/migrate.mjs` added,
  since the migrator legitimately references `.omc/state/` when
  probing legacy layouts.

## 0.7.0 — 2026-04-22

Close-the-loop release. Ships the deferred `dispatchShellGeneric`
broadening (five evidence-pattern recognizers) behind a
`CRITIC_SPOT_CHECK` gate that mechanically eliminates Stage B verdict
flicker, and removes the last bits of 0.6.0-obsolete text and dead code.
Zero "deferred" items post-landing.

### Added

- **`scripts/_lib/evidence-recognizers.mjs`** — five recognizers for
  evidence shapes the 0.4.6 basic dispatcher couldn't extract:
  - `recognizeCompoundAnd` — two+ backticked runnable commands joined by
    `;`, `+`, or `AND`. AND-reduces exits.
  - `recognizeBraceExpansion` — single backticked command with a
    `{a,b,c}` group, expanded into N per-token commands.
  - `recognizeListAnchor` — comma-separated filenames + exec/existence
    check prose + path prefix. Emits `<check> <prefix><file>` per file.
  - `recognizeAlternation` — `a|b|c` pattern + negation prose + path
    hint. Emits `! grep -qE 'a|b|c' <path>`. Splits on `|` first
    (flaw #2 fix from the 0.5.x draft: concatenations starting with an
    exec token like `cp -r|tar -xf|rsync` now match).
  - `recognizeNegationList` — comma-separated identifier list + negation
    prose + path hint. Emits negative grep with dots regex-escaped.
  - `recognizeEvidencePlan` — priority dispatcher (compound-AND > brace
    > list-anchor > alternation-grep > negation-list; first match wins).
- **`scripts/execute-assertion.mjs > executePlan`** — runs each command
  in an `ExecutionPlan`, AND-reduces exit codes, preserves 0.6.0 proof
  shape (`toolType: "cli-binary"`, command record tagged with the
  recognizer kind for audit).
- **Recognizer path in `dispatchShellGeneric`** — recognizers are tried
  BEFORE the basic `tryExtract` path (flaw #1 fix from the 0.5.x draft).
  Unmatched evidence falls through to `tryExtract`, preserving 0.6.0
  behavior for every shape the old dispatcher already handled.
- **`CRITIC_SPOT_CHECK` gate on recognizers** — the critic's Stage B
  sets `CRITIC_SPOT_CHECK=1` when spot-checking. The dispatcher skips
  recognizers under that env var so existing passes are verified using
  the same logic that produced them. Mechanically eliminates the Stage B
  verdict-flicker path the 0.5.x draft's prior critic-review flagged as
  a release-blocker.
- **`tests/dispatcher-patterns.test.mjs`** — 30 unit tests (positive +
  negative) across the five recognizers plus the priority dispatcher.
- **`tests/dispatcher-broadening.test.mjs`** — 10 end-to-end integration
  tests. Each of the five patterns has a passing-case fixture and a
  failing-case fixture (where applicable). Plus a fall-through test that
  verifies single-command evidence still routes through `tryExtract`.
- **`tests/dispatcher-stage-b-safety.test.mjs`** — 3 tests proving the
  `CRITIC_SPOT_CHECK` gate holds: gated critic runs don't flip verdicts
  on recognizer-parseable manually-recorded assertions; two consecutive
  runs produce identical counts (no `Math.random` flicker); and a
  control test that confirms removing the gate WOULD produce a failure
  (proves the fixture meaningfully exercises the gate rather than
  passing trivially).

### Removed

- **`handoffsInboxDir()`** export in `hooks/_lib/paths.mjs` — dead code
  since 0.5.1. Zero production callers. Its self-reference in
  `tests/paths.test.mjs` is gone too.

### Changed

- **AGENTS.md Appendix D** — rewritten from "Deferred" to "Shipped in
  0.7.0". Drops the obsolete flaw #3 (meta-repo cwd inference — 0.6.0
  already killed the meta-repo concept). Fixes "0.5.0 draft" phrase to
  "0.5.x draft" throughout. New section body documents the final
  architecture: priority order, gate semantics, conservative-matching
  discipline.

### Migration notes

- No operator action required. 0.7.0 is purely additive over 0.6.0 for
  existing missions: a mission whose assertions already pass via basic
  `tryExtract` continues to pass via that same path (recognizers return
  `null` when their structural guards don't match). Fresh Phase 4b runs
  on assertions whose evidence fits one of the five patterns now
  produce proofs tagged with `# evidence-recognizer: <kind>` in the
  proof's `command` field.

## 0.6.0 — 2026-04-22

Droid alignment: pure-droid staleness model, mission-centric proof
storage, single-repo-per-mission assumption. Meta-repo machinery deleted;
the problem class goes away by architecture rather than helpers.

### Changed

- **Proof bundles move to missionDir**: proofs now land at
  `<missionPath>/validation/proofs/<id>/{stdout.txt,stderr.txt,meta.json}`
  (was `<workingDir>/.mission-executor/validation/proofs/<id>/` in 0.5.x).
  Stored paths in `validation-state.json` are missionPath-relative, so
  missions remain portable if the directory moves. Matches droid's
  `MissionFileService` layout at `organized/core-services/0806.js`.
- **Staleness is contract-driven, not git-driven**.
  `invalidate-stale-evidence.mjs` rewritten as a contract-change detector:
  compares each passed assertion's `proof.contractSha256` against the
  current assertion block in `validation-contract.md`. Drift = stale.
  Force-push, rebase, branch-switch no longer auto-invalidate proofs.
  Matches droid's orchestrator-driven invalidation at
  `organized/uncategorized/0801.js:1649`.
- **Critic Stage A simplified**: no more `git merge-base --is-ancestor`
  call. Stage A verifies proof block present + content-integrity hashes.
  `critic-evaluator.mjs` imports `spawnSync` only (no `execSync`).

### Added

- `scripts/_lib/mission-paths.mjs` — mission-scoped path helpers
  (`proofsDir(missionPath, id)`, `validationDir(missionPath)`,
  `handoffsDir(missionPath)`, `progressLogPath(missionPath)`,
  `workingDirectoryPath(missionPath)`, plus feature/state/contract paths).
  Pure functions of `missionPath` — never consult `layoutRoot()`.
- `scripts/_lib/migrate.mjs > upgradeLegacy052Proofs(missionPath)` —
  one-shot transparent migration. Runs at top of `executeAssertion` and
  `evaluateMission`. Strips `commitSha`/`childRepo`, moves proof bundles
  from legacy paths into `<missionPath>/validation/proofs/`, rewrites
  stored paths to missionPath-relative. Idempotent.
- `proof.contractSha256` — new field, sha256 of the assertion's block in
  `validation-contract.md` at execution time. Staleness signal.
- Tests: `tests/mission-paths.test.mjs` (11 assertions on the helper
  module), `tests/invalidate-stale-evidence.test.mjs` (7 tests covering
  contract drift, contract deletion, legacy fallback, dry-run),
  `tests/upgrade-legacy-052-proofs.test.mjs` (6 migration scenarios
  including OMC legacy + missing bundle files), and
  `tests/single-repo-assumption.test.mjs` (structural invariants pinning
  that mission-executor scripts never import meta-repo or run
  `git merge-base`).

### Removed

- `scripts/_lib/meta-repo.mjs` — deleted. Cross-repo proof-tagging was
  0.5.1's fix for the meta-repo staleness problem; 0.6.0 eliminates the
  problem entirely by dropping git ancestry.
- `tests/cross-repo-head.test.mjs` — deleted. All 6 scenarios
  (child-repo routing, prefix-collision, missing-meta, invalidate-
  respects-childRepo) are structurally impossible in the 0.6.0 model.
- `proof.commitSha` — no longer written, no longer required. Legacy
  proofs are rewritten on first touch via migration.
- `proof.childRepo` — no longer written. Never part of the public
  schema outside 0.5.1; removed for consistency.
- `--commit-sha` flag on `record-assertion.mjs` — still accepted for
  back-compat (silently ignored); explicitly no longer required.

### Migration notes

- Legacy 0.5.x missions load transparently. First run emits a single
  stderr line per mission: `mission-executor: upgraded N 0.5.x proof(s)
  to 0.6.0 schema`. No operator action required.
- Missions whose proof bundle files are missing on disk (force-push
  dropped them, workingDir wiped) flip affected assertions to
  `status: pending` — the next `execute-assertion` run regenerates.
- Operators relying on "force-push invalidates the validation pile" must
  now manually flip affected assertions to `pending`, or edit the
  contract to trigger hash drift.

## 0.5.1 — 2026-04-22

Two features on top of the 0.5.0 command surface: mission-scoped progress
logging and schema-validated worker-return handoffs. Coordinator daemon
explicitly deferred.

### Added

- **Progress log infrastructure** (`scripts/_lib/progress-log.mjs`,
  `hooks/_lib/paths.mjs > progressLogFile(missionPath)`): per-mission
  append-only event stream at `<missionPath>/progress_log.jsonl`. Matches
  droid's `MissionFileService.progressLogPath` location so dual-runtime
  workflows can share the file.
  - Event shape: `{ timestamp, type, sessionId?, featureId?, workerSessionId?,
    milestone?, exitCode?, reason?, spawnId?, ...extra }`.
  - Vocabulary (use verbatim): `mission_started`, `mission_paused`,
    `mission_resumed`, `mission_completed`, `mission_aborted`,
    `session_attached`, `session_detached`, `legacy_migration_completed`,
    `phase_transition`, `worker_started`, `worker_completed`,
    `worker_failed`, `worker_paused`, `worker_stranded`,
    `milestone_validation_triggered`, `assertion_executed`, `handoff_written`.
  - Derived state via `deriveWorkerStates(events)` →
    `{ [workerSessionId]: { startedAt, completedAt?, exitCode?, failed?, reason? } }`.
    `activeWorkerSessionIds(events)` returns sessions with a start but no
    terminal event.
  - Concurrency: POSIX atomic-append for writes under PIPE_BUF. No lockfile.
    20-parallel-writer test in `tests/progress-log.test.mjs`.

- **`mission-cli.mjs event <type>` subcommand**: explicit event emitter for
  cases mission-cli doesn't auto-generate (worker lifecycle, assertion runs,
  etc.). Flags: `--session-id=<sid>` (required), `--feature=<id>`,
  `--worker=<sid>`, `--exit-code=<n>`, `--reason=<msg>`, `--milestone=<m>`,
  `--spawn=<id>`, `--extra-json=<json>`. Exits 0 on append, 3 not-attached,
  4 bad-input.

- **Auto-emit from lifecycle subcommands**: `start`, `attach`, `detach`,
  `phase`, `complete`, `abort` now append the corresponding event to
  progress_log automatically. No code changes required at the caller.

- **Worker-return schemas** (`scripts/_lib/schemas.mjs`): hand-rolled
  validator, zero deps. `validate(schema, value)` returns
  `{ ok: true, value }` or `{ ok: false, errors: string[] }`. Exported
  schemas:
  - `workerHandoffSchema`. Required: `workerSessionId`, `featureId`,
    `successState` (`success|partial|failure`), `salientSummary` (20–500
    chars, 1–4 sentences — droid's refinement). Optional: `milestone`,
    `whatWasDone[]`, `whatWasLeftUndone[]`, `discoveredIssues[]`,
    `commitShas[]`, `returnToOrchestrator`.
  - `discoveredIssueSchema`. Required: `severity`
    (`low|medium|high|critical`), `description` (10–2000 chars).
  - `endFeatureInputSchema`. Required: `featureId`, `status`
    (`completed|cancelled|failed`), `summary` (20–500 chars, 1–4 sentences).

- **New event type `handoff_written`** (appended by `write-handoff.mjs`
  after a successful schema-validated write).

- **New event type `legacy_migration_completed`** (appended by
  `hooks/_lib/mission-state.mjs > migrateLegacyAttach` on a successful
  pre-0.5.0 state-file upgrade).

### Changed

- **`scripts/write-handoff.mjs` is no longer a stub.** Validates input JSON
  against `workerHandoffSchema` by default. Exit 0 → file written at
  `<missionPath>/handoffs/<ts>__<featureId>__<workerSessionId>.json` + a
  `handoff_written` event. Exit 1 → schema errors printed, no file, no log
  entry. Exit 2 → bad args. `--force-skip-validation` retained as an
  emergency escape (output tagged `_unverified: true`, progress_log entry
  carries `unverified: true`).

- **`mission-cli.mjs status`** now returns `workers` and `activeWorkers`
  alongside `attachedSessions`, derived from the mission's progress log.

- **`skills/mission-execute/SKILL.md`** gains a "Progress log" section and
  documents the worker-event-emission workflow around `Agent()` / `Task()`
  dispatches, plus the `write-handoff.mjs` contract in Phase 4b.

- **`skills/mission-status/SKILL.md`** notes the `workers` /
  `activeWorkers` additions to the status JSON.

### Probe gates

- §0.1 Phase-A probes ran in-session on 2026-04-22 against Claude Code
  2.1.117 (AWS Bedrock). Definitive findings:
  - Tier 1 env (`$CLAUDE_SESSION_ID` / `$CLAUDE_CODE_SESSION_ID`) —
    **NOT SET** in slash-command bash. Claude Code 2.1.117 does not inject.
  - Tier 2 stdin JSON — **NOT RECEIVED** in slash-command bash.
  - Tier 3a per-session file (`<sessionIdDir>/<sid>.active`) — **CONFIRMED**
    post-restart; SessionStart hook writes it.
  - Tier 3b jsonl filename (`~/.claude/projects/<slug>/<sid>.jsonl`) —
    **CONFIRMED**; load-bearing for slash-command bash.
  - §0.4 (`~/.claude/mission-executor/` ownership) — **CLEAR**. No conflict.
  - §0.3 (`disable-model-invocation` frontmatter) — **DEFERRED**. Not probe-
    verifiable. `commands/status.md` ships both the frontmatter key AND a
    prose deterrent, so correctness does not depend on the key being honored.
- `scripts/selfcheck-hooks.mjs` dropped the §0 probe-gate assertion. The
  PROBE_RESULTS.md artifact was archived out of tree once findings landed
  in this changelog entry.
- Non-blocking followups from the probe run: (A) scope Tier 3b glob to the
  `$PWD`-derived slug to avoid cross-project jsonl collisions under parallel
  sessions; (B) teach `resolve-sid.sh` a `${HOME}/.claude/mission-executor/
  state/sessions/` hardcoded fallback so slash-command bash can use Tier 3a
  without `CLAUDE_PLUGIN_ROOT`.

### Tests

- `tests/progress-log.test.mjs` — 6 cases including 20-parallel-writer
  atomic-append verification.
- `tests/schemas.test.mjs` — 13 cases covering happy paths, required-field
  errors, enum violations, string-length bounds, sentence-count refinement,
  nested item validation, null-at-required handling, and open-schema
  tolerance for unknown keys.
- `tests/write-handoff.test.mjs` — 7 cases including duplicate-refusal,
  `--force-skip-validation`, `--handoff-json=<file>` file input, and bad-arg
  exit codes.
- `tests/mission-cli.attach.test.mjs` + `tests/mission-cli.detach.test.mjs`
  extended with 6 assertions for auto-emitted events.

### Droid drift

Schemas and event vocabulary track a subset of droid's current shapes
(`resplit/1858.js` for zod schemas; `resplit/0806.js > updateDerived
WorkerStatesFromProgressEntry` for state derivation). Re-review at every
major droid release.

---

## 0.5.0 — 2026-04-22

Major API change: slash-command opt-in, state-path decoupling.

### Added

- **Slash-command surface**: `/mission-executor:execute`,
  `/mission-executor:detach`, `/mission-executor:status`,
  `/mission-executor:abort`. `execute` is idempotent — starts a new mission
  or attaches this session to an existing one.

- **Multi-session opt-in**: state file gains `attachedSessions[]`; hooks
  enforce only on sessions explicitly attached via `/execute`. Unrelated
  sessions in subdirectories are invisible to the hooks.

- **Global registry**: `~/.claude/mission-executor/registry.json` keyed by
  mission-id, indexes `statePath` per mission so hooks can find mission
  state without a filesystem walk-up.

- **`scripts/mission-cli.mjs`**: single CLI entry for all lifecycle
  operations. Subcommands: `resolve`, `start`, `attach`, `detach`, `status`,
  `phase`, `complete`, `abort`, `is-attached`.

- **`hooks/_lib/paths.mjs`**: single source of truth for on-disk layout.
  `layoutRoot()` is the primitive; every other path is a child of it.
  Resolution order: `MISSION_EXECUTOR_LAYOUT_ROOT` env → `MISSION_EXECUTOR_STATE_DIR`
  env (back-compat, must end in `/state`) → `plugin.json config.layoutRoot`
  → legacy autodetect (`.omc/` if the sentinel file exists) → default
  `.mission-executor`.

- **SessionStart hook** (`hooks/session-start-record.mjs`): writes
  `<sessionIdDir>/<session-id>.active` so slash-command bash can resolve
  its own session-id via the three-tier resolver.

- **Three-tier session-id resolver** (`scripts/_lib/resolve-sid.sh`):
  env → stdin JSON → per-session file. Sourced by every command's bash
  block.

- **Heartbeat file** (`hooks/_lib/paths.mjs > heartbeatFile(sid)`): touched
  by `worker-boundary-enforcer` on PreToolUse/PostToolUse and by
  `validation-tracker` on PostToolUse while a driver session is active.
  Consumed by `mission-cli.mjs detach` to block driver-detach while the
  skill is running.

- **Lockfile protocol** (`scripts/_lib/lockfile.mjs`): advisory O_EXCL
  lockfile with exponential backoff + stale-lock recovery (pid + mtime
  check). Used for `registry.json` writes and the legacy-migration state-file
  write.

### Changed

- **Worker-dispatch tier order reversed**: native `Agent()` is now Tier 1
  (always available, zero deps), native Agent Teams Tier 2, OMC `/team`
  Tier 3 (optional, when detected). Non-OMC installs no longer pay the
  inspection-miss on first dispatch.

- **All 8 hooks gated on `sessionId` in `state.attachedSessions[]`**. No
  walk-up; no over-scoping from subdirectory sessions.
  `hooks/_lib/mission-state.mjs > loadAttachedMissionState` is the single
  read path.

- **`scripts/mission-lifecycle.mjs`** is now a thin delegator to
  `mission-cli.mjs`. Back-compat contract preserved (arg surface, exit
  codes, `--force`).

- **`scripts/execute-assertion.mjs` proof bundles** now write to
  `proofsDir(id)` under `layoutRoot()` (project-scoped), not
  mission-relative `.omc/validation/...`. OMC installs with the legacy
  sentinel file continue to land proofs under `.omc/validation/...` via
  the autodetect branch.

- **`hooks/_lib/audit.mjs`** writes to `auditLogFile()` from `paths.mjs`
  instead of a hardcoded `.omc/state/hook-audit.log`.

### Removed

- **`walkUpForState` / `walkUpForAbort`** — deleted. The explicit opt-in
  model replaces filesystem walk-up.

### Back-compat

- Pre-0.5.0 in-flight missions (state file without `attachedSessions[]`)
  auto-migrate on the first hook call: the hook enforces normally AND
  appends the calling session to `attachedSessions[]` under the state-file
  lock. Concurrent migrations on the same state file from distinct
  session-ids all land — tested in `tests/hooks.in-flight-migration.concurrent.test.mjs`.

- `.omc/` installs continue to land state + validation under `.omc/...`
  via `paths.mjs > layoutRoot()` legacy autodetect (sentinel:
  `<project>/.omc/state/mission-executor-state.json`). Removing the
  autodetect branch is a 1.0.0 candidate.

### 1.0.0 candidates (not yet scheduled)

- Remove `paths.mjs > layoutRoot()` legacy-autodetect branch.
- Remove the `MISSION_EXECUTOR_STATE_DIR` back-compat alias.
- Remove the `mission-lifecycle.mjs` delegator.

Each requires a documented one-time migration path.
