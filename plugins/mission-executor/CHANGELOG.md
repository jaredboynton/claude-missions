# mission-executor changelog

All notable changes per release. Dates are the commit date of the version
bump in [.claude-plugin/plugin.json](.claude-plugin/plugin.json).

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

### Probe gates (see `PROBE_RESULTS.md`)

- §0.1 Phase-A probe gate in `scripts/selfcheck-hooks.mjs` is satisfied by
  `PROBE_RESULTS.md` existing at the plugin root; the selfcheck no longer
  greps the spec's §0 checkboxes. Rationale: the probe artifact is the
  evidentiary contract — evidence that tiers 1/2 are NOT available in
  slash-command bash is still "resolved evidence," not "unchecked work."

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
