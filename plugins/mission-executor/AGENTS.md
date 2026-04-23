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

- **Independent validation** — workers are assumed to lie; every assertion is
  re-executed against the tree at a recorded commit SHA.
- **Hook-level enforcement** — mission boundaries (NEVER-rules, write guards,
  completion gates) are enforced at PreToolUse, never via prompt trust.
- **State write-back** — `features.json` is re-synced from git HEAD after every
  batch; `validation-state.json` is mutated only via proof-gated scripts.
- **External-work reconciliation** — features that landed in git HEAD before
  dispatch are scored and marked complete so the runner doesn't re-do them.
- **Idempotent re-entry** — `/mission-executor:execute` on an active mission
  attaches the current session instead of starting a new run.

Avoid introducing orchestration tiers beyond the three documented in
Appendix A (sequential `Agent()`, native Agent Teams, OMC `/team`) without
a CHANGELOG design note.

## Tech Stack

- Node.js ES modules (`.mjs`), stdlib-only — no dependencies
- POSIX shell for slash-command entrypoints (`commands/*.md`) and the
  session-id resolver (`scripts/_lib/resolve-sid.sh`)
- Python 3 (stdlib) — optional second opinion in `validate-mission.mjs` when
  a Factory harness is reachable via walk-up
- Tests: `node:test` + `node:assert/strict`
- Runtime: Claude Code plugin loader (`plugin.json` + `hooks/hooks.json`)

Do not introduce: npm/yarn/pnpm dependencies, TypeScript, external schema
validators (ajv, zod, yup — use `scripts/_lib/schemas.mjs`), or external test
runners (vitest, jest, mocha — use `node --test`).

## Architecture

```
plugins/mission-executor/
├── .claude-plugin/plugin.json  Manifest. Declares "hooks": "./hooks/hooks.json".
├── commands/                   Slash-command markdown (execute, detach, status, abort)
├── hooks/
│   ├── hooks.json              Discovery path — MUST live here, not in .claude-plugin/
│   ├── _lib/                   paths.mjs (project-scoped), mission-state.mjs, audit.mjs
│   └── <hook>.mjs              9 hooks: PreToolUse (5), PostToolUse (2), Stop, SessionStart
├── scripts/
│   ├── _lib/                   Shared helpers (progress-log, schemas, lockfile,
│   │                           mission-paths, evidence-recognizers, migrate)
│   ├── mission-cli.mjs         Lifecycle (resolve/start/attach/detach/status/
│   │                           phase/complete/abort/event)
│   ├── execute-assertion.mjs   Assertion runner with proof bundles
│   ├── record-assertion.mjs    Proof-gated validation-state.json mutator
│   ├── sync-features-state.mjs git-HEAD-driven features.json reconciler
│   ├── reconcile-external-work.mjs     Proof-gated features.json reconciler
│   ├── critic-evaluator.mjs    Two-stage verdict
│   ├── contract-lint.mjs       Contract vs AGENTS.md contradiction scanner
│   ├── invalidate-stale-evidence.mjs   Contract-hash drift detector
│   ├── write-handoff.mjs       Schema-validated worker-return writer
│   ├── selfcheck-hooks.mjs     Release gate
│   └── validate-mission.mjs    JS + Python harness cross-check
├── skills/                     SKILL.md bundles loaded by slash-commands
├── docs/                       Operational deep-dives (contract-lint, hook diagnostics)
└── tests/                      node:test files, one per module
```

Hook event mapping: `worker-boundary-enforcer` (Bash|Edit|Write),
`commit-scope-guard` (Bash), `assertion-proof-guard` and `features-json-guard`
(Edit|Write of guarded state files), `no-ask-during-mission` (AskUserQuestion),
`build-discipline` (PostToolUse Edit|Write), `validation-tracker` (PostToolUse
Bash|Read|Grep|Glob), `autopilot-lock` (Stop), `session-start-record`
(SessionStart).

Data flow (happy path):

```
Operator runs /mission-executor:execute <path>
  → mission-cli.mjs resolve + start (or attach)
  → registers session in state.attachedSessions[]
  → writes mission_started event to <missionPath>/progress_log.jsonl
  → mission-execute skill runs Phases 0–7:
      0  selfcheck-hooks + validate-mission + contract-lint
      1  reconcile-external-work (git HEAD → features.json)
      2  decompose-features → batch plan
      3  dispatch batch (Tier 1/2/3 — see Appendix A)
      4  re-validate every assertion via execute-assertion
      4b write-handoff per worker (schema-validated)
      5  sync-features-state
      6  critic-evaluator (two-stage)
      7  loop or complete
```

Storage model: a mission operates on exactly **one** git repo pointed to by
`<missionPath>/working_directory.txt`. Mission artifacts
(`validation-contract.md`, `validation-state.json`, `features.json`,
`progress_log.jsonl`, `handoffs/`, `validation/proofs/`) live under
`<missionPath>/`. Project-scoped state
(`mission-executor-state.json`, session markers, `hook-audit.log`) lives in
`~/.claude/mission-executor/projects/<slug>/state/` since 0.8.0 — was
`<workingDir>/.mission-executor/state/` in 0.5.x through 0.7.0. All paths
resolve through `hooks/_lib/paths.mjs`. The cross-project registry
(`registry.json`) lives one level up at `~/.claude/mission-executor/`. The
env vars `MISSION_EXECUTOR_LAYOUT_ROOT` and `MISSION_EXECUTOR_STATE_DIR`
still force a cwd-anchored layout for operators who want it. Meta-repo
awareness and cross-repo touchpoint routing are intentionally absent;
cross-repo work requires multiple missions.

Two write channels, bright line: enforcement hooks write to `hook-audit.log`;
the mission event stream (`progress_log.jsonl`) is owned by `mission-cli.mjs`
and `write-handoff.mjs`. Do not cross.

## Coding Conventions

- Node ES modules only. File extension `.mjs`. No CommonJS.
- `#!/usr/bin/env node` shebang on every script entrypoint.
- `node:`-prefixed imports exclusively (`node:fs`, `node:path`,
  `node:child_process`).
- Prefer sync I/O in short-lived script entrypoints; async only for real
  concurrency.
- Exit codes: `0` success; `1` error; `2` bad args; `3+` domain-specific
  (e.g. `mission-cli.mjs event` returns `3` for not-attached, `4` for bad
  input).
- Silent-swallow for progress-log writes: a progress-log failure MUST NEVER
  fail the calling command. See `mission-cli.mjs > emitEvent`.
- **Project-scoped paths** via `hooks/_lib/paths.mjs` (state, sessions,
  hook-audit). **Mission-scoped paths** via `scripts/_lib/mission-paths.mjs`
  (proofs, handoffs, progress log, `working_directory.txt`). Mission-scoped
  helpers take `missionPath` as an argument and never consult `layoutRoot()`.
- **Never hand-write `validation-state.json`** —
  `assertion-proof-guard.mjs` blocks it at PreToolUse. Route through
  `record-assertion.mjs` via `execute-assertion.mjs`.
- **Never hand-write `features.json`** — `features-json-guard.mjs` blocks it.
  Use `sync-features-state.mjs` (git-HEAD-driven) or
  `reconcile-external-work.mjs --apply` (proof-gated).
- Worker claims in tool output (e.g. `VAL-XXX: PASS`) are audit-only and
  land in `claimsLogFile()`. They do NOT flip status.
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

- `node --test tests/` all green.
- `node scripts/selfcheck-hooks.mjs` exits 0 (catches hook discovery and
  path regressions).
- Shadow harness against a real corpus mission when modifying
  `execute-assertion.mjs > dispatchShellGeneric` or any recognizer.

Testing rules:

- One test file per module under test.
- Concurrency-sensitive code gets a multi-writer stress test
  (see `tests/progress-log.test.mjs` — 20 parallel writers, atomic-append check).
- Legacy-migration paths require a concurrent-migration test
  (see `tests/hooks.in-flight-migration.concurrent.test.mjs`).
- `contract-lint`, `critic-evaluator`, and `execute-assertion` each carry a
  "defect N regression" test — preserve and extend these when refactoring.

## File and Component Placement Rules

- New enforcement hook → `hooks/<name>.mjs` + entry in `hooks/hooks.json`.
- New orchestration script → `scripts/<verb>-<noun>.mjs`.
- Shared helper used by ≥2 scripts → `scripts/_lib/<name>.mjs`.
- New on-disk path → helper in `hooks/_lib/paths.mjs` (project-scoped) or
  `scripts/_lib/mission-paths.mjs` (mission-scoped), never inline.
- New slash command → `commands/<name>.md` (namespaced `/mission-executor:<name>`).
- New skill → `skills/<name>/SKILL.md`.
- Tests → `tests/<module>.test.mjs`.
- Operational deep-dive (too long for AGENTS.md, not a release note) →
  `docs/<topic>.md` with a one-line pointer from this file.
- Release notes / deferred work → `CHANGELOG.md`.

Do not create duplicate helpers between `scripts/_lib/` and `hooks/_lib/`
(scripts import from `hooks/_lib`, not the other way). Do not invent a new
abstraction for one-off usage.

## Safe-Change Rules

- Do not bump `plugin.json` / `marketplace.json` version without a matching
  `CHANGELOG.md` entry in the same commit.
- Do not rename or delete exports from `hooks/_lib/paths.mjs` or
  `scripts/_lib/mission-paths.mjs` — 1.0.0 candidates.
- Do not re-introduce `proof.commitSha` or `proof.childRepo`. v0.6.0 dropped
  the git-ancestry staleness model; staleness is contract-hash-driven via
  `proof.contractSha256`. See CHANGELOG 0.6.0.
- Do not introduce cross-repo touchpoint routing (`.meta` walking, child
  git repos). Cross-repo coordination requires multiple missions.
- The `.omc/` autodetect branch in `paths.mjs > layoutRoot()` was removed
  in 0.8.0. Back-compat now flows through
  `scripts/_lib/migrate.mjs > migrateProjectStateToUserGlobal()`, invoked
  by `mission-cli.mjs > cmdStart` / `cmdAttach`. Do not re-add the
  autodetect — it was what produced the pre-0.8.0 cwd pollution.
- Do not move `hooks/hooks.json` into `.claude-plugin/` — Claude Code's
  auto-discovery only scans `hooks/hooks.json`; `.claude-plugin/hooks.json`
  is silently ignored. v0.4.5 shipped that way and every mission ran with
  zero enforcement. `plugin.json` also declares
  `"hooks": "./hooks/hooks.json"` belt-and-braces.
- Do not assume Stop hooks alone catch bypasses — they are flaky (upstream
  #22925, #29881, #8615, #12436). Always layer PreToolUse alongside Stop.
- Do not change the worker-return schema (`workerHandoffSchema`) without
  coordinating with droid — we track a subset of droid's shapes and
  re-review every major droid release.
- Do not change tier order (native `Agent()` Tier 1, native Teams Tier 2,
  OMC `/team` Tier 3) without a design note.
- `mission-cli.mjs complete` is gated; it refuses to flip
  `state.active=false` unless completion criteria are met. Pass `--force`
  only when the spec itself is corrupt (logged).
- `write-handoff.mjs --force-skip-validation` tags output
  `_unverified: true` and emits a `progress_log` entry carrying
  `unverified: true`. Use only when recovering from a corrupt spec.
- `milestone-seal.mjs` is a STUB. `scrutiny-validator` and
  `user-testing-validator` are Factory-droid-runtime scripts. The stub
  probes `DROID_SCRUTINY_BIN` / `DROID_USER_TESTING_BIN` env vars and common
  install paths; if absent it exits 2 loudly.

## Commands

Development:

```sh
# Run full test suite
node --test tests/

# Release-gate check
node scripts/selfcheck-hooks.mjs

# Validate a mission spec (JS + optional Python harness)
node scripts/validate-mission.mjs <mission-path>

# Execute one assertion end-to-end with proof
MISSION_EXECUTOR_WRITER=1 node scripts/execute-assertion.mjs <mission-path> --id=VAL-XXX-NNN

# Invalidate stale proofs (contract-hash drift)
node scripts/invalidate-stale-evidence.mjs <mission-path>

# Contract vs AGENTS.md contradictions
node scripts/contract-lint.mjs <mission-path>

# Two-stage critic
node scripts/critic-evaluator.mjs <mission-path>

# Reconcile feature state from proofs + commits
node scripts/reconcile-external-work.mjs <mission-path> --apply
```

Update in an active Claude Code TUI (`claude plugin update` from the
shell does NOT refresh a running session): `/plugin → Installed → filter:
missions → mission-executor → Update now`, then `/reload-plugins`. Bump
both `plugin.json` and `marketplace.json` before pushing — the TUI only
offers "Update now" when the marketplace version is newer.

---

## Appendix A — Tier hierarchy (Phase 3 dispatch)

Phase 3 EXECUTE evaluates three tiers before dispatch (v0.5.0 order —
native-first, OMC-last):

1. **Tier 1** — sequential `Agent()`. Always available, baseline.
2. **Tier 2** — native Agent Teams (`TeamCreate` + `Agent(team_name=...)` +
   `SendMessage`) when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` exposes
   them. Requires a no-op smoke-probe with 60s timeout and fall-through to
   Tier 1 on internal error (upstream #40270).
3. **Tier 3** — `/oh-my-claudecode:team`. Optional; only when OMC is
   detected AND the batch has ≥3 parallel features.

Tier detection is inspection-only — grep the session's system-reminder at
Phase 3 start for skill and tool names. Never run mission-executor from
`claude --agent <custom>` — upstream #23506 makes `Agent(team_name=...)`
unavailable there and the Phase 3 degenerate-case abort fires.

Decision tree and caveats: `skills/mission-execute/SKILL.md` Phase 3
(issues #33764, #40270, #32110/#32987, #23506).

## Appendix B — Deep-dive pointers

- `docs/contract-lint-tuning.md` — four-filter tuning ladder.
- `docs/hook-diagnostics.md` — `hookInfos` disambiguation when enforcement
  appears bypassed.
- `CHANGELOG.md` 0.5.1 (progress log + handoff schemas), 0.6.0 (droid
  alignment, contract-driven staleness, single-repo model), 0.7.0
  (`dispatchShellGeneric` recognizers + `CRITIC_SPOT_CHECK` gate).
