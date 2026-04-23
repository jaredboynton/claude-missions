---
name: mission-execute
description: Full autopilot execution of a Factory/droid mission -- teams, validation, fix loops, critic gate
argument-hint: "<mission-path>"
triggers:
  - execute mission
  - run mission
  - mission autopilot
  - mission-execute
---

# Mission Executor (Claude Code lane)

## Precondition (v0.5.0)

**This skill must be invoked via `/mission-executor:execute <mission-path-or-id>`.**
The slash command is the canonical entry point; it registers this session in
the mission's `attachedSessions[]` so hooks enforce correctly. If you reached
this skill directly (without the command firing first), abort and tell the
user to run the command instead — hooks will no-op for unattached sessions
and enforcement will silently not fire.

To verify attachment from within the skill:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" is-attached --session-id="<sid>"
```
Exit 0 = attached (continue). Exit 1 = not attached (abort with an error
message directing the user to run `/mission-executor:execute <mission-path>`).

## Overview

Executes Factory/droid missions FROM CLAUDE CODE. This is the Claude-Code side
of a dual-runtime system. The Factory droid CLI runtime owns the
feature→worker→handoff→dismiss loop, scrutiny-validator auto-injection at
milestone seals, and user-testing-validator auto-injection. This plugin handles:

- Phase 0-2: validation, contract-lint, and reconcile of mission state
- Phase 3: execute via Agent() spawns (three-tier team hierarchy; see Phase 3)
- Phase 4: assertion verification — `execute-assertion.mjs` is the SOLE path to `passed`
- Phase 5: critic gate via `critic-evaluator.mjs`
- Phase 7: completion gate (refuses to flip state.active=false without evidence)

If you need scrutiny / user-testing validators auto-injected at milestone seals,
run the mission from the droid CLI instead — those validators are owned by the
Factory runtime, not this plugin. This plugin's `milestone-seal.mjs` will probe
for them on PATH and exit 2 with guidance if absent, rather than silently
no-opping.

**AUTOPILOT — multi-layer enforcement.** A single enforcement point is
unreliable in Claude Code (see "Known Stop-hook limitations" below). This plugin
layers:

1. **PreToolUse hooks** (reliable): `assertion-proof-guard` and
   `features-json-guard` deny direct Write/Edit to authoritative state files;
   `worker-boundary-enforcer` enforces mission AGENTS.md NEVER-rules and
   injects mission-active status context into the first non-progress tool
   call of each turn; `no-ask-during-mission` denies `AskUserQuestion` with
   a concrete next-action hint from `mission-query.mjs`.
2. **Stop hook** (best-effort): `autopilot-lock` blocks turn-end while the
   mission has incomplete assertions/features/state. Short-circuits on
   `stop_hook_active` per Anthropic's FAQ (avoids infinite loop).
3. **Lifecycle gate**: `mission-lifecycle.mjs complete` refuses to flip
   `state.active=false` unless completion criteria are met. Pass `--force`
   only when the spec itself is corrupt (logged loudly).

The mission is complete only when:

- every assertion in `validation-state.json` is `status=passed` with a `proof` block carrying `commitSha`,
- every feature in `features.json` is `status=completed`, and
- `state.json` has `state=completed`.

Escape hatch: the user runs `/mission-executor:abort` to release the lock mid-run (or manually creates the abort marker at `<layoutRoot>/state/mission-executor-abort`; path resolved by `hooks/_lib/paths.mjs`).

**Audit log**: every hook invocation appends to
`<working-dir>/.omc/state/hook-audit.log` with timestamp, hook name, and
decision. Use this to diagnose whether hooks loaded and fired when a
mission post-mortem claims enforcement was bypassed.

If the audit log is missing or empty for a session that definitely ran
tool calls, the hooks were never registered -- DON'T assume Stop-hook
flakiness. Confirm by inspecting Claude Code's own session transcript:

```bash
rg -oN '"hookInfos":\[[^\]]+\]' \
  ~/.claude/projects/<cwd-encoded>/<session-id>.jsonl \
  | rg 'autopilot-lock|no-ask-during-mission|worker-boundary-enforcer'
```

If that prints nothing, Claude Code didn't see our hooks in the
registered set -- most likely because `hooks.json` was moved to a
non-discovered location. Run `node scripts/selfcheck-hooks.mjs` in
the plugin directory to verify the registration paths before blaming
upstream Stop-hook bugs.

## Known Stop-hook limitations (Anthropic upstream)

Stop hooks are flaky in Claude Code and cannot be trusted as the only
enforcement layer. Documented issues:

- `#22925` — Stop fires intermittently; sometimes skips text-only responses
- `#29881` — silent tool stops skip Stop entirely
- `#8615` — `decision:block` creates async concurrent request races, not clean blocking
- `#12436` — `continue:true` blocks can API-400 on thinking blocks
- `#19643`/`#19432`/`#16538` — `systemMessage`/`additionalContext` injection is broken across several events

This plugin puts the load-bearing enforcement at PreToolUse (fires reliably
on every tool call) and treats the Stop hook as defense-in-depth. Context
injection uses both `hookSpecificOutput.additionalContext` AND top-level
`systemMessage` as redundant paths.

## Input

- `<mission-path>`: Path to `.factory/missions/<id>/` directory. If omitted, auto-discovers paused missions in the working directory's `.factory/missions/`.

## Lifecycle state

**v0.5.0 change**: `/mission-executor:execute` already registered the mission
and attached this session BEFORE the skill was invoked. Do NOT call
`mission-lifecycle.mjs start` or `mission-cli.mjs start` again — that work is
done. The state file (`stateBase()/mission-executor-state.json`) is already
written with `active=true` and this session is already in `attachedSessions[]`.

The Stop hook reads that state file and refuses to let the assistant end its
turn until completion criteria are met. If `is-attached` returns exit 1 at
any point during the pipeline, something removed this session from the
mission's scope — abort with a clear error.

Phase transitions: as the pipeline advances phase, record the transition:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" phase "3-execute" --session-id="<sid>"
```
`mission-lifecycle.mjs phase` also works (thin delegator; same contract).

## Progress log (v0.5.1+)

Every lifecycle subcommand auto-appends an event to
`<missionPath>/progress_log.jsonl`:

- `start` -> `mission_started` or `session_attached`
- `attach` -> `session_attached`
- `detach` -> `session_detached`
- `phase` -> `phase_transition` (with `{ from, to }`)
- `complete` -> `mission_completed` (with `forced` flag)
- `abort` -> `mission_aborted`
- legacy-migration path -> `legacy_migration_completed`

For events that mission-cli doesn't auto-emit (worker lifecycle, handoff,
assertion runs), use the explicit subcommand:

```bash
# Before dispatching a worker Agent/Task:
node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" event worker_started \
  --session-id="<sid>" --worker="<workerId>" --feature="<featureId>"

# After the worker Agent returns:
node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" event worker_completed \
  --session-id="<sid>" --worker="<workerId>" --exit-code=0

# Or on failure:
node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" event worker_failed \
  --session-id="<sid>" --worker="<workerId>" --exit-code=1 --reason="timeout"
```

Event-type vocabulary (match droid where meaningful): `mission_started`,
`mission_paused`, `mission_resumed`, `mission_completed`, `mission_aborted`,
`session_attached`, `session_detached`, `legacy_migration_completed`,
`phase_transition`, `worker_started`, `worker_completed`, `worker_failed`,
`worker_paused`, `worker_stranded`, `milestone_validation_triggered`,
`assertion_executed`, `handoff_written`. Use these verbatim so dual-runtime
tooling (droid post-mortems, our `mission-cli status`) can parse consistently.

Hooks do NOT write to progress_log; they stay on `hook-audit.log`. The only
exception is the one-shot migration writer in `hooks/_lib/mission-state.mjs`.

`mission-cli status` reads progress_log to surface derived worker states
(`{ [workerSessionId]: { startedAt, completedAt, exitCode, failed? } }`)
and `activeWorkers[]` (sessions with a start but no terminal event).

At each phase transition, update the phase label so operator logs track progress:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-lifecycle.mjs" phase "<phase-id>"
```

At Phase 7's final step, clear the state:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-lifecycle.mjs" complete
```

The hooks will then allow the turn to end normally.

## Prerequisites

- Mission directory must contain: `features.json`, `validation-contract.md`, `validation-state.json`, `state.json`, `AGENTS.md`
- Working directory must have a root `CLAUDE.md` or `AGENTS.md` with build/test commands
- Mission `state.json` must have `state: "paused"` or `state: "running"`

## Pipeline (7 phases)

### Phase 0: VALIDATE (hard gate)

Very first action in the pipeline -- register mission state so the
autopilot Stop hook activates:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-lifecycle.mjs" start "$MISSION_PATH"
```

Then run schema + cross-reference validation against the mission
directory. This catches malformed `features.json` / `validation-state.json`
/ `state.json` before any downstream script corrupts them further.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-mission.mjs" "$MISSION_PATH"
```

The combined validator runs:
1. Native JS schema checks (always) -- port of Factory's `mission_contracts.py`
2. Factory's Python harness `python3 -m scripts.harness.check_missions` when
   the harness exists in an ancestor directory (graceful skip otherwise)

**Exit on any ERROR.** Warnings are advisory and may indicate:
- `missing validatedAtMilestone` -- passed assertions recorded without
  attribution. Fix by rewriting with `record-assertion.mjs`.
- `mission completion state diverges from feature completion` -- state.json
  says `completed` but features aren't all `completed` (or vice versa). Phase
  7 must reconcile before marking done.
- `worker session references do not resolve` -- harmless until a retention
  policy exists.

**Never proceed past Phase 0 with schema errors.** Fix manually, then re-run.

### Phase 0.5: CONTRACT-LINT (new)

Walk nested `AGENTS.md` files in the working directory and flag
assertions that contradict the project's own architectural docs. This
catches the VAL-CLI-003 pattern from bee21e7c where a contract asserted
behavior (`--require-gate` must invoke the orchestrator gate) that
`packages/kep/src/cli/cmd/AGENTS.md` explicitly says is bypassed by
design.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/contract-lint.mjs" "$MISSION_PATH"
```

Signals searched for in AGENTS.md paragraphs that mention an assertion's
keywords: `bypasses`, `by design`, `deliberately`, `intentionally`,
`trusted`, `deprecated`, `no longer`, `MUST NOT`, `NEVER`.

Contradictions hard-halt. The user either:

- Edits the assertion in validation-contract.md, OR
- Adds `contradiction-acknowledged: <sha-prefix-of-AGENTS.md>` inside
  the assertion body (only valid while the referenced AGENTS.md matches
  that sha).

Exit 0 proceeds; exit 1 halts.

### Phase 1: INGEST

Read and parse the mission directory:

```
mission_path = argument or auto-discover from .factory/missions/
features     = JSON.parse(read(mission_path + "/features.json")).features
contract     = read(mission_path + "/validation-contract.md")
val_state    = JSON.parse(read(mission_path + "/validation-state.json"))
agents_md    = read(mission_path + "/AGENTS.md")
state        = JSON.parse(read(mission_path + "/state.json"))
working_dir  = read(mission_path + "/working_directory.txt").trim()
```

Extract from AGENTS.md:
- NEVER-VIOLATE boundary rules (git push, pkill, protected paths, etc.)
- Build discipline commands (the specific build/test commands for the project)
- Coding conventions (language, framework patterns, import aliases)
- Pre-existing uncommitted files to protect

Extract from features.json:
- Features grouped by `milestone` field
- Dependency ordering from milestone sequence
- Worker type routing from `skillName` field
- Validation mapping from `fulfills` arrays

Extract from validation-contract.md:
- All assertion IDs, descriptions, tool types, and evidence criteria
- Tool types: `unit-test`, `curl`, `cli-binary`, `tuistory`
- Shape pins and environment requirements

### Phase 1.5: RECONCILE (critical -- do not skip)

Before executing anything, reconcile mission state with git HEAD. This phase
catches three anti-patterns that cost hours if skipped:

1. **External team completion**: Another agent, human, or mission already
   did the work. features.json is stale (shows pending) but git HEAD already
   contains the commits satisfying `expectedBehavior`.
2. **Zombie workers**: `in_progress` features with paused or dead
   `workerSessionIds`. Resuming would do nothing useful; the work already landed.
3. **Partial completion**: Some features complete, others not. Executor must
   only dispatch workers for the ones genuinely needing work.

Execution:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/detect-zombies.mjs" "$MISSION_PATH"
node "${CLAUDE_PLUGIN_ROOT}/scripts/reconcile-external-work.mjs" "$MISSION_PATH" --apply
```

Interpretation of reconcile decisions:
- `already-completed` (score 100): features.json marked completed, skip.
- `mark-completed` (score >= 50, commit by ID): script marks completed, skip to verify.
- `likely-done-verify-first` (score 20-49): don't re-execute; route directly to Phase 4 (VERIFY).
   If verify passes, mark completed. If verify fails, add to fix queue.
- `partial-evidence` (score 10-19): execute with TDD; workers must respect existing partial work.
- `needs-execution` (score < 10): full normal execution path.

**Never re-execute a feature whose work is already in git HEAD.** This
wastes tokens, risks merge conflicts, and can regress previously-correct work.

### Phase 2: DECOMPOSE

Group ONLY features in `needs-execution` or `partial-evidence` state into
parallel execution batches (those in `likely-done-verify-first`,
`mark-completed`, or `already-completed` skip to Phase 4 directly):

1. Order milestones by their sequence in the mission spec
2. Within each milestone, identify features that touch different code paths (can run in parallel)
3. Across milestones, identify cross-milestone features that are actually independent (override milestone ordering where safe)
4. Create task batches with max 5 concurrent workers per batch
5. Route each feature to a worker type based on `skillName`:
   - `tui-worker` -> executor agent (TUI/SolidJS expertise)
   - `backend-worker` -> executor agent (Effect/schema expertise)
   - `http-worker` -> executor agent (HTTP route handler expertise)
   - `cli-worker` -> executor agent (CLI command expertise)
   - `polish-worker` -> executor agent (UI polish expertise)

### Phase 3: EXECUTE

Dispatch each batch through the highest-priority team runtime available
to the session. The orchestrator evaluates tier availability **once** at
the start of Phase 3 via inspection of the session's system-reminder
(plus a single smoke-probe on Tier 2) and sticks with the chosen tier
for the whole mission.

#### Worker event emission (v0.5.1+)

Before EACH `Agent(...)` / `Task(...)` dispatch, append a `worker_started`
event to progress_log via `mission-cli event`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-cli.mjs" event worker_started \
  --session-id="<sid>" --worker="<workerId>" --feature="<featureId>"
```

After the worker returns, emit `worker_completed` (success) or
`worker_failed` (non-zero exit / thrown error / detected regression):

```bash
# on success:
node .../mission-cli.mjs event worker_completed --session-id=<sid> --worker=<workerId> --exit-code=0
# on failure:
node .../mission-cli.mjs event worker_failed --session-id=<sid> --worker=<workerId> --exit-code=1 --reason="test suite red"
```

These are advisory events (audit trail), NOT the authoritative completion
path. Phase 4's `execute-assertion.mjs` still owns the `passed` status
transition. Without these events, `mission-cli status` can't surface
derived worker states and post-mortems lose per-worker timing.

#### Tier selection (inspection-first, smoke-probe on Tier 2)

**v0.5.0 reorder (spec §7.2)**: native `Agent()` is now Tier 1 (always
available, zero deps). OMC `/team` is Tier 3 when detected — still
preferred for high-parallelism batches when OMC is installed (its
pane-management + cancel plumbing win over native Task in practice) but
no longer the default. The plugin is genuinely usable without OMC.

Evaluate in order and use the first match:

1. **Tier 1 — Sequential `Agent()`** (always available): baseline dispatch
   path. Zero dependencies, no experimental flags, works in every Claude
   Code install. For small batches (≤2 features) or missions where
   parallelism gains are marginal, stop here.
2. **Tier 2 — Native Claude Code Agent Teams** (parallel): if `TeamCreate`,
   `SendMessage`, AND `Agent` (with a `team_name` parameter) all appear
   in the session's tool catalog. This signals that
   `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set in settings.json
   (introduced in Claude Code v2.1.32, docs at
   https://code.claude.com/docs/en/agent-teams). Tool-catalog inspection
   alone is insufficient — catalog presence does not guarantee `Agent`
   with `team_name` actually succeeds (see caveat #40270 below). Tier 2
   selection MUST include a throwaway smoke-probe before committing the
   mission to this tier; see the "Mandatory preflight probe" subsection.
3. **Tier 3 — OMC `/team`** (optional, if detected): if
   `oh-my-claudecode:team` appears in the session's available-skills
   list AND the mission has ≥3 parallel features where OMC's stage
   pipeline / handoff docs / worktree isolation add real value. Skip
   silently if OMC isn't installed.

Step 1 and 2 detection are inspection-only — grep the session's
system-reminder text for the literal skill name and tool names. Do not
invoke any tool just to test its availability at this step. Step 2's
probe is a single real tool call; document it in the mission's
progress-log before running.

**Degenerate case**: if the `Agent` tool is absent from the catalog
entirely (not just missing the `team_name` parameter), no tier works.
This happens when the orchestrator itself was launched with
`claude --agent <custom>` — upstream issue #23506 — and even Tier 3's
hand-rolled `Agent()` call fails. Abort Phase 3 with an explicit error
instructing the operator to re-run from plain `claude` (not
`claude --agent`).

#### Tier 3 — `/oh-my-claudecode:team` (when detected)

If OMC's `/team` skill is loaded, dispatch the batch through it. The
skill layers stage-aware agent routing, handoff documents, state-file
persistence, worktree isolation, dynamic scaling, role-routing configs,
and shutdown protocol on top of the same `TeamCreate` +
`Agent(team_name=...)` primitives Tier 2 uses. Dispatching here avoids
reproducing ~800 lines of team-runtime contract inline and keeps the
runtime version aligned with the rest of the user's OMC install.

Invocation shape:
```
Skill("oh-my-claudecode:team", args=<task description + pre-computed
      feature batch + exec-worker-type + boundaries>)
```

The orchestrator passes the batch through as the task description;
`/team` decomposes internally, pre-assigns owners, spawns teammates,
and drives the staged pipeline (`team-plan` -> `team-exec` ->
`team-verify` -> `team-fix`). The orchestrator monitors progress via
`SendMessage` checkpoints as a team-lead peer rather than managing every
primitive call directly. On completion, the orchestrator takes the
team's `whatWasDone` handoff and plumbs it into Phase 3's state
write-back + Phase 4 VERIFY.

Benefits beyond raw primitives: interoperates cleanly with
`/oh-my-claudecode:cancel` so mid-mission cancel reaches workers, and
surfaces standard OMC state files (`state_read mode=team`) for operator
visibility.

#### Tier 2 — Native Agent Teams (experimental parallel; requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the host profile)

If OMC isn't installed but native teams are enabled, the orchestrator
MAY hand-roll the team primitives directly — subject to the caveats
and preflight probe below. Tier 2 uses the **same underlying toolset**
Tier 1 wraps; what's missing is OMC's stage pipeline, state files, and
cancel integration.

**Tier 2 caveats (read BEFORE choosing this path):**

| Issue | Symptom | Mitigation |
|-------|---------|------------|
| [anthropics/claude-code#33764](https://github.com/anthropics/claude-code/issues/33764) | `~/.claude/teams/` + `~/.claude/tasks/` are wiped on session restart. | mission-executor's authoritative state lives in `features.json` + `progress_log.jsonl` (persistent under `.factory/`) and survives restarts. Mitigates **in-flight batch state only**; does not recover cross-session team config. Cross-session missions MUST re-dispatch each batch and re-run the Tier 2 preflight probe on resumption. |
| [anthropics/claude-code#40270](https://github.com/anthropics/claude-code/issues/40270) | `Agent` with `team_name` returns "Tool result missing due to internal error" in some tmux sessions, independent of prompt content. | Detection: the mandatory preflight probe (below). On probe failure, abort Tier 2 for the whole mission and fall through to Tier 3. Do not attempt per-batch retries on Tier 2 after probe failure — the failure is session-scoped, not batch-scoped. |
| [anthropics/claude-code#32110](https://github.com/anthropics/claude-code/issues/32110) / [#32987](https://github.com/anthropics/claude-code/issues/32987) | Per-teammate model propagation is buggy — teammates inherit the lead's model instead of the `model=` param on `Agent()`. | Document `model=` on teammates as **advisory only** under Tier 2 until upstream fix lands. Prefer **uniform-model batches** (all teammates on the same tier) so the lead's model is the correct model for every worker. `/team` (Tier 1) already resolves this via role-routing config. |
| [anthropics/claude-code#23506](https://github.com/anthropics/claude-code/issues/23506) | Custom-agent sessions (`claude --agent <name>`) don't expose `Agent` with `team_name`. Sometimes `Agent` itself is absent, not just its `team_name` parameter. | Split detection: if `Agent` is absent entirely from the catalog, abort Phase 3 (Tier 3 also fails — see "Degenerate case" above). If `Agent` is present but `team_name` parameter is missing from its signature, fall through to Tier 3 automatically. |

**Mandatory preflight probe** (before any batch dispatch on Tier 2):

Spawn one throwaway `Agent` call with `team_name="mission-preflight"`,
`name="probe"`, `subagent_type="general-purpose"`, a trivial prompt
(`"Reply 'ok' and return. Do not write files, do not claim tasks, do
not spawn sub-agents."`), and a 60-second timeout. The probe MUST NOT
claim any task, touch any file, or participate in the real batch — its
only job is to verify the `Agent(team_name=...)` code path succeeds in
this session. If the probe returns within 60s with a non-error result,
select Tier 2 for the mission. If it returns "Tool result missing due
to internal error" or times out, abort Tier 2 and record the fall-
through in `progress_log.jsonl`; the mission proceeds on Tier 3. A
Tier 2 → Tier 3 fall-through is sticky for the rest of the mission —
the orchestrator MUST NOT re-probe mid-mission.

Probe cost: ~$0.01 and ~60s wall time per mission when Tier 2 is a
candidate. Zero cost when Tier 1 is selected (probe is skipped).

**Invocation shape** (if probe passes):
```
TeamCreate("mission-batch-N")

For each feature in batch:
  TaskCreate(
    subject: "[M{milestone}] {skillName}: {feature.id}",
    description: feature.description + preconditions +
                 expectedBehavior + verificationSteps
  )
  TaskUpdate(taskId, owner: "worker-N")

Spawn workers with Agent(
  subagent_type: "executor",
  team_name: "mission-batch-N",
  name: "worker-N",
  prompt: <worker-preamble> + <feature-spec> + <boundaries> + <build-commands>
)

Monitor via inbound SendMessage + TaskList polling until all tasks
complete or fail.

Shutdown workers via SendMessage(shutdown_request) -> await
shutdown_response -> TeamDelete.
```

#### Tier 1 — Sequential `Agent()` (baseline; always available)

If neither Tier 1 nor Tier 2 is available (or Tier 2 preflight probe
failed), dispatch features through pure `Agent()` subagents with
orchestrator-managed sequencing. This is the pre-0.4.0 reference
behavior. No shared task list, no inter-agent messaging — the
orchestrator drives each feature in sequence and synthesizes results
across invocations.

Invocation shape:
```
For each feature in batch (serially):
  Agent(
    subagent_type: "general-purpose" (or any available executor),
    prompt: <worker-preamble> + <feature-spec> + <boundaries> +
            <build-commands>
  )
  Wait for return, parse handoff, write back features.json via
  sync-features-state.mjs, then advance to next feature.
```

Tier 3 is strictly slower than Tiers 1/2 for mixed-milestone batches
(all work is serial). It preserves the Phase 3 contract: workers still
commit to git, the runner still writes back `features.json` via
`sync-features-state.mjs`, and Phase 4 VERIFY still drives the
authoritative pass/fail via `execute-assertion.mjs`.

#### Contract invariant (all tiers)

Regardless of tier, Phase 3 must respect:

- Workers commit their own work to git with scoped `git add`
- The runner (not workers) writes back `features.json` status via
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-features-state.mjs" "$MISSION_PATH"`
  after the batch closes
- Phase 4 VERIFY is authoritative for pass/fail; worker claims are
  audit-only (`.omc/validation/worker-claims.jsonl`)

**Worker Preamble** (injected into every worker):
- Mission AGENTS.md boundaries (verbatim NEVER rules)
- Build discipline: run build command after every src change
- Commit scope: only stage files you created/edited, snapshot git status before/after
- TDD: write failing test first, then implement
- Report completion via SendMessage to team-lead

**Dynamic Skill Creation** (droid pattern):
Before spawning workers, create per-feature skill files:
```
.omc/skills/mission-worker-{featureId}.md
```
Each contains the full feature spec from features.json. Workers reference these for context. Clean up after batch completes.

**State Write-back** (critical -- the runner is blind without this):
After every batch completes, sync features.json from git HEAD. Workers commit
their work but do NOT update features.json directly. The plugin writes back:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-features-state.mjs" "$MISSION_PATH"
```

This scans git log for commits mentioning feature IDs and flips status from
`in_progress`/`pending` to `completed` with the commit SHA recorded. Without
this step, features.json remains stale ("runner saw no worker completions")
even though the code shipped.

### Phase 4a: INVALIDATE STALE EVIDENCE

Before running any new assertion, sweep prior proofs whose contract text
has changed. v0.6.0 uses a droid-aligned model: proofs carry
`proof.contractSha256` (hash of the assertion's block in
`validation-contract.md` at execution time). On subsequent runs, any
drift between the recorded hash and the current contract block flips the
assertion to `stale` and archives its proof bundle.

Assertions deleted from the contract are also flipped to `stale`.

Proofs with no `proof.contractSha256` field (legacy 0.5.x and earlier) are
left alone — they'll pick up a hash on their next re-execute via
`execute-assertion.mjs`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/invalidate-stale-evidence.mjs" "$MISSION_PATH"
```

This is the first line of defense against the bee21e7c failure mode: the
prior wave had 95 passed assertions with evidence strings reading
`"critic-confirmed in prior session"`. No command had been run this run.
The invalidator demotes every such entry to `stale` so Phase 4b re-runs
them from scratch.

**No more git ancestry checks.** 0.5.x's `proof.commitSha + git merge-base
--is-ancestor` staleness signal was removed in 0.6.0. The
mission-executor runtime makes no git calls during validation; staleness
is purely contract-driven, matching droid's
`organized/uncategorized/0801.js:1649` convention ("If the change
invalidates a previous `"passed"` result, reset the status to
`"pending"`"). Missions now run cleanly inside meta-repos and across
force-pushes without any per-repo awareness.

### Phase 4b: VERIFY (driven by execute-assertion.mjs)

#### Writing worker handoffs (v0.5.1+)

As each feature completes, the orchestrator MUST write a validated handoff
JSON via `write-handoff.mjs`. This replaces the v0.4.x "ad-hoc bash
heredoc" pattern and is the canonical worker-return contract.

```bash
# Assemble the handoff JSON in-context, then pipe:
cat <<'JSON' | node "${CLAUDE_PLUGIN_ROOT}/scripts/write-handoff.mjs" "$MISSION_PATH"
{
  "workerSessionId": "<worker-session-id>",
  "featureId": "<feature-id>",
  "milestone": "<M1|M2|...>",
  "successState": "success",
  "salientSummary": "1-4 sentences, 20-500 chars. What changed and why it's ready.",
  "whatWasDone": ["bullet", "list"],
  "whatWasLeftUndone": ["bullet", "list"],
  "discoveredIssues": [{ "severity": "high|medium|low|critical", "description": ">=10 chars" }],
  "commitShas": ["abc1234"],
  "returnToOrchestrator": "optional free-form"
}
JSON
```

Exit 0 = handoff written at `$MISSION_PATH/handoffs/<ts>__<feat>__<worker>.json`
plus a `handoff_written` event appended to progress_log. Exit 1 = schema
validation failed; fix the input and retry (the failure JSON lists every
error). Exit 2 = bad args.

Schema source of truth: `scripts/_lib/schemas.mjs > workerHandoffSchema`.

Use `--force-skip-validation` ONLY when recovering from a corrupt spec
where the schema itself is wrong; the output gets tagged `_unverified: true`.

#### Running the assertions

For every assertion in validation-state.json that is `pending` or `stale`,
run `execute-assertion.mjs`. This is the ONLY path that writes
`passed` into validation-state.json.

```bash
# Plugin sets MISSION_EXECUTOR_WRITER=1 so the proof-guard hook allows the
# validation-state.json write that record-assertion.mjs performs internally.
for id in $(jq -r '.assertions | to_entries[] | select(.value.status=="pending" or .value.status=="stale") | .key' \
  "$MISSION_PATH/validation-state.json"); do
  MISSION_EXECUTOR_WRITER=1 \
    node "${CLAUDE_PLUGIN_ROOT}/scripts/execute-assertion.mjs" "$MISSION_PATH" --id="$id"
done
```

Tool-type dispatch (internal to execute-assertion.mjs):

| tool | action | pass condition |
|---|---|---|
| `unit-test` | `bun test <file> -t <name>` | exit 0 and test name in stdout |
| `curl` | emit command from evidence, run with `-w "\nHTTP_STATUS:%{http_code}"`, compare status and required fields | status match + all required fields present |
| `cli-binary` | resolve `MISSION_CLI_BIN`, run extracted backtick command | exit code matches + required literal present |
| `tuistory` | launch tuistory session, snapshot, grep | snapshot contains required literal |
| `literal-probe` | `rg --fixed-strings` declared literal against repo | ≥1 match |

Each execution writes a proof bundle to
`<missionPath>/validation/proofs/<id>/{stdout.txt,stderr.txt,meta.json}`
(v0.6.0: mission-scoped, not workingDir-scoped) and records:

```json
{
  "status": "passed",
  "proof": {
    "toolType": "curl",
    "command": "curl -sS ...",
    "exitCode": 0,
    "stdoutSha256": "...",
    "stderrSha256": "...",
    "stdoutPath": "validation/proofs/VAL-X/stdout.txt",
    "stderrPath": "validation/proofs/VAL-X/stderr.txt",
    "touchpoints": ["packages/kep/src/..."],
    "executedAt": "2026-04-18T...",
    "executor": "execute-assertion.mjs",
    "contractSha256": "<sha256 of the assertion's block in validation-contract.md>"
  }
}
```

**v0.6.0 schema notes**:
- Proof paths are **missionPath-relative** (not workingDir-anchored), so
  missions remain portable if the directory is moved.
- `proof.contractSha256` (new in 0.6.0) is the hash of the assertion's
  block from `validation-contract.md` at execution time —
  `invalidate-stale-evidence.mjs` uses this as the staleness signal.
- `proof.commitSha` and `proof.childRepo` (0.5.x-only) are gone.
  Mission-executor no longer reads git history for validation freshness.

record-assertion.mjs REJECTS `passed` without these fields.

Exit codes: 0 passed, 1 failed, 2 blocked (evidence unparseable or env
incomplete), 3 infrastructure (daemon down, binary missing).

**Never hand-write validation-state.json.** The
`assertion-proof-guard.mjs` hook (PreToolUse Write|Edit) blocks direct
edits to that file at the tool level.

### Phase 4c: INVALIDATE AGAIN

Re-run `invalidate-stale-evidence.mjs` after VERIFY. Protects against
late commits that would make a freshly-recorded proof stale by the time
the critic runs.

### Phase 5a: CRITIC — STAGE A (structural)

Run `critic-evaluator.mjs`. Stage A verifies for every `passed`
assertion:

- `proof` block present with all required fields (toolType, command,
  exitCode, stdoutPath, stderrPath, touchpoints, executedAt)
- recomputed sha256 of `stdoutPath`/`stderrPath` matches proof

Any failure here means a proof was tampered with or never produced. The
critic returns verdict `INCOMPLETE` / `FAIL` and does NOT proceed to Stage B.

**v0.6.0**: the git-ancestry check (`proof.commitSha` is-ancestor of HEAD)
is gone. Staleness is detected by Phase 4a's contract-hash comparison,
not by the critic. Stage A is purely a content-integrity check on the
proof bundle files.

### Phase 5b: CRITIC — STAGE B (spot re-execute)

If Stage A is clean, the critic samples 20% of passed assertions + 100%
of literal-probe assertions and re-runs them via execute-assertion.mjs.
Any divergence (a previously-passed assertion now failing) is a
regression.

Only a clean Stage A + clean Stage B emits the exact string
`"all validation criteria have been met"`, which is the only sentinel
the pipeline accepts to advance to Phase 7.

### Phase 6: FIX

For each FAIL from the critic:

1. Analyze the failure evidence and root cause
2. Classify: code fix needed vs test environment issue vs test specification mismatch
3. For code fixes: spawn fix workers (parallel where independent)
4. For environment issues: adjust test approach or create required fixtures/state
5. Re-run affected assertions only (not full validation suite)
6. Loop back to Phase 5

**Bounded**: Max 5 fix iterations. After 5 failures on the same assertion, mark as BLOCKED and report to user.

### Phase 7: COMPLETE

1. Ensure every feature in `features.json` has `status: "completed"`
   (otherwise mission-state/feature-state divergence will fire)
2. Update mission `state.json`: set `state: "completed"`
3. Ensure `validation-state.json` has all assertions as `"passed"` with
   `validatedAtMilestone` populated (Phase 4 helper does this)
4. Append completion entry to `progress_log.jsonl`
5. Write execution summary to mission directory
6. Clean up temporary files (`.omc/skills/mission-worker-*`, `.omc/validation/`)
7. **Re-run Phase 0 validation as a gate**. Must exit with zero errors:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-mission.mjs" "$MISSION_PATH"
   ```
8. **Clear mission state to release the autopilot lock**:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mission-lifecycle.mjs" complete
   ```
   Without this, `autopilot-lock.mjs` will keep blocking Stop even when
   criteria are met.
9. Report final status to user

## Lessons Encoded (from real execution)

These failure modes were discovered during live mission execution and are built into the pipeline:

0. **Mission runner goes blind without state write-back**: Workers commit to git but do NOT update features.json. Without Phase 3's `sync-features-state` call, the runner sees all features as `pending` even after work ships, and re-executes everything on resume. The droid-side auditor will correctly report "runner saw no worker completions" -- this is the plugin's fault, not the workers'.

0a. **External work must be reconciled before dispatch**: If work already landed (prior session, human fix, different agent), re-executing creates conflicts and wastes tokens. Phase 1.5 (RECONCILE) runs `reconcile-external-work.mjs` to detect this via commit message + touchpoint scoring.

0b. **Zombie sessions look alive in features.json**: A paused worker's `workerSessionIds` list remains in features.json. If you check that list without also checking progress_log.jsonl for `worker_paused` / `mission_paused` events, you'll attempt to resume a dead session. Phase 1.5's `detect-zombies.mjs` cross-references both.

1. **Workers lie about completion**: Workers will claim features are "already present" or "complete" when they are not. Phase 4 (VERIFY) independently tests every assertion. Never trust worker self-reports.

2. **Typecheck errors cascade**: One worker's changes can break another worker's build. Run typecheck between batches, not just within them.

3. **Build server serves stale code**: After code changes, HTTP servers must be restarted to serve the new build. The pipeline must detect and handle this.

4. **Milestone dependencies are often artificial**: Features in different milestones may touch completely different code paths. Override milestone ordering where code-path analysis shows independence, to maximize parallelism.

5. **Verifier false positives**: The verification agent can report features as missing when they exist (grep patterns too narrow, or file not at expected path). Verification must use actual code reads, not just pattern matching.

6. **Hook enforcement > prompt trust**: Mission boundary rules (no git push, no pkill, no staging protected files) must be enforced via hooks at the tool level, not just instructions in worker prompts. Workers will violate prompt-only rules under pressure.

7. **Command palette navigation is context-dependent**: TUI panel commands only appear in the palette when registered from the correct view context. Validation must navigate to the right view first.

8. **Error response contracts drift**: HTTP error responses may lack required fields (like structured error codes) even when the handler exists. Validation must check response shapes precisely.

9. **Status is cheap, proof is not (bee21e7c lesson)**: A prior plugin wave seeded validation-state.json's 95 `passed` entries from natural-language strings in .omc/validation/*.md left over from an earlier run. No command had been executed that wave. Lesson: the ONLY path to `passed` is `execute-assertion.mjs`, which writes a `proof` object with commitSha + sha256'd stdout/stderr. `record-assertion.mjs` rejects passed writes that lack proof.

10. **Commit titles are narrative, not behavioral**: The old reconcile scorer awarded +50 points for a commit message mentioning a feature id. That auto-marked `nav-missing-mission-scoping-route` completed while `mission-scoping.tsx:77-82` was still a literal `// TODO`. Lesson: commit messages score 0. `mark-completed` requires proofs on linked assertions.

11. **Hook scraping is a spoof surface**: The old `validation-tracker.mjs` scraped tool output for `"VAL-XXX: PASS"` strings and wrote them to validation-state.json. Any worker could echo the string in Bash and flip the assertion. Lesson: hooks never write authoritative state; they append to `worker-claims.jsonl` as audit-only, and `assertion-proof-guard.mjs` blocks tool-level edits to validation-state.json.

12. **Stale evidence must be invalidated, never trusted**: Evidence files from prior waves are input-only audit artefacts. If a prior proof's commitSha is no longer an ancestor of HEAD, or touchpoints moved since it was captured, the proof is `stale` and the assertion must be re-executed. `invalidate-stale-evidence.mjs` runs at both the start of Phase 4 and before the critic.

13. **Contract contradictions AGENTS.md contradictions must surface at Phase 0.5**: VAL-CLI-003 contradicted `packages/kep/src/cli/cmd/AGENTS.md`'s documented trust model. Lesson: `contract-lint.mjs` walks every nested AGENTS.md before workers spawn; unacknowledged contradictions hard-halt.

14. **Contract-lint signal quality matters more than recall**: First run of `contract-lint.mjs` on bee21e7c emitted 15 findings. Only 1 was real. The 14 false positives came from four sources, each now filtered:
    - **Parser bug**: the assertion-block extractor stopped at the next `###` but not at `##`, so the last assertion in each section absorbed the next section's intro prose and picked up spurious keywords (e.g. VAL-RECOVERY-004 absorbed the `## VAL-CLI` section's "bypass the gate" text).
    - **External-code mirrors**: `.discovery/` and similar directories contain reference AGENTS.md files (codex-cli, postman-app, etc.) that don't govern kep behavior. Skip these in the AGENTS.md walk alongside `node_modules/`, `dist/`, `.git/`, `.factory/`, `.cache/`.
    - **Generic English words**: backtick-wrapped tokens like `error`, `code`, `running`, `state`, `status`, `message` match any AGENTS.md phrase too loosely. Maintain a stoplist. Also add the contract's own tool-type tokens (`unit-test`, `curl`, `cli-binary`, `tuistory`, `literal-probe`) because they appear structurally in every assertion and match AGENTS.md paragraphs that use the words in unrelated contexts.
    - **Cross-paragraph co-occurrence**: if the keyword and the suspect phrase straddle a paragraph break (`\n\n`), they are describing different topics that happen to share a doc. Reject. Example: `server/routes/AGENTS.md` explains HTTP 403 enforcement in one paragraph and the CLI's in-process bypass in the next -- both mention `403` and `bypass` within a ±150 char window but are thematically separate.

15. **Alignment check suppresses affirm-not-contradict**: when an assertion body mentions any suspect-phrase root (`bypass`, `deliberat`, `trusted`, `by design`, `in-process`, `trust model`), the assertion is describing the same behavior the AGENTS.md documents. Not a contradiction. Example: VAL-CLI-001 asserts `--help stdout contains the substring "bypasses"` — the assertion is affirming the documented bypass, not demanding enforcement. A real contradiction looks like VAL-CLI-003: assertion demands enforcement behavior (non-zero exit, `MissionOrchestratorOnlyError`) WITHOUT referencing the documented trust model.

16. **Worker prompts must forbid contract-edit shortcuts**: a common failure mode in fix-loop iterations is the worker seeing a failing assertion, judging the code correct, and editing the contract to match. This silently launders bugs into the passed column. The worker preamble now explicitly forbids editing `validation-contract.md` and `validation-state.json`; the `assertion-proof-guard.mjs` hook blocks the latter at the tool level.

17. **"Full autopilot" requires Stop-hook enforcement, not prose**: the skill doc said "fully automated execution" but nothing prevented the assistant from writing a progress summary and handing back mid-pipeline. Real autopilot requires a Stop hook that inspects mission-completion criteria on every turn-end attempt and rejects with a precise blocker list. `autopilot-lock.mjs` blocks Stop whenever `active=true` in `.omc/state/mission-executor-state.json` AND any of: assertions unpassed / features uncompleted / `state.json != completed`. The sibling `no-ask-during-mission.mjs` blocks `AskUserQuestion` so the assistant can't pause for user input either. Escape hatch for humans: create `.omc/state/mission-executor-abort` to release.

18. **Lifecycle scripts, not orchestrator discipline**: the state file is written by `mission-lifecycle.mjs start` at Phase 0 and cleared by `mission-lifecycle.mjs complete` at Phase 7. Orchestrator discipline (remembering to flip a flag) is not reliable under pressure; explicit scripts invoked at the phase boundaries make autopilot non-bypassable.

## Configuration

Environment variables:
- `MISSION_EXECUTOR_MAX_WORKERS`: Max concurrent workers per batch (default: 5)
- `MISSION_EXECUTOR_MAX_FIX_ITERATIONS`: Max fix loop iterations (default: 5)
- `MISSION_EXECUTOR_SKIP_PHASES`: Comma-separated phases to skip (e.g., "DECOMPOSE" to use features as-is)
