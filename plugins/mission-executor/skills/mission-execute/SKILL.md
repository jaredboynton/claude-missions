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

# Mission Executor

Fully automated execution of Factory/droid missions. Reads the mission spec, decomposes features into parallel teams, executes, validates every assertion, fixes failures, and loops until a critic confirms 100% pass rate.

## Input

- `<mission-path>`: Path to `.factory/missions/<id>/` directory. If omitted, auto-discovers paused missions in the working directory's `.factory/missions/`.

## Prerequisites

- Mission directory must contain: `features.json`, `validation-contract.md`, `validation-state.json`, `state.json`, `AGENTS.md`
- Working directory must have a root `CLAUDE.md` or `AGENTS.md` with build/test commands
- Mission `state.json` must have `state: "paused"` or `state: "running"`

## Pipeline (7 phases)

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

For each batch, use Claude Code native teams:

```
TeamCreate("mission-batch-N")

For each feature in batch:
  TaskCreate(
    subject: "[M{milestone}] {skillName}: {feature.id}",
    description: feature.description + preconditions + expectedBehavior + verificationSteps
  )
  TaskUpdate(taskId, owner: "worker-N")

Spawn workers with Agent(
  subagent_type: "oh-my-claudecode:executor",
  team_name: "mission-batch-N",
  name: "worker-N",
  prompt: <worker-preamble> + <feature-spec> + <boundaries> + <build-commands>
)

Monitor until all tasks complete or fail
Shutdown workers -> TeamDelete
```

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

### Phase 4: VERIFY

For each assertion in validation-contract.md:

1. Parse the assertion's tool type
2. Execute the appropriate verification:
   - `unit-test`: Run the test file, check green
   - `curl`: Execute the HTTP request, check response shape
   - `cli-binary`: Run the CLI command, check exit code + output
   - `tuistory`: Launch TUI via tuistory, navigate, capture snapshot, check content
3. Record result to validation-state.json:
   ```json
   {"VAL-XXX-NNN": {"status": "passed", "evidence": "..."}}
   ```
4. Write detailed evidence to `.omc/validation/{assertion-id}.md`

**Verification workers**: Spawn up to 3 parallel validators:
- HTTP validator: all curl + cli-binary assertions
- TUI validator: all tuistory assertions (max 1 session at a time)
- Unit test validator: all unit-test assertions (run test suite)

### Phase 5: CRITIC

Spawn a critic agent (oh-my-claudecode:critic) that:

1. Reads validation-state.json -- counts PASS / FAIL / PENDING
2. Reads all evidence files in .omc/validation/
3. Cross-references against validation-contract.md
4. Produces a verdict:
   - If ALL assertions pass: output exactly "all validation criteria have been met"
   - If any FAIL: list each failure with assertion ID, evidence, and root cause analysis
   - If any PENDING: list each with strategy to reach the required state

**Exit condition**: Critic must output the exact string "all validation criteria have been met" to proceed to Phase 7. Otherwise, proceed to Phase 6.

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

1. Update mission `state.json`: set state to reflect completion
2. Ensure `validation-state.json` has all assertions as "passed"
3. Append completion entry to `progress_log.jsonl`
4. Write execution summary to mission directory
5. Clean up temporary files (.omc/skills/mission-worker-*, .omc/validation/)
6. Report final status to user

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

## Configuration

Environment variables:
- `MISSION_EXECUTOR_MAX_WORKERS`: Max concurrent workers per batch (default: 5)
- `MISSION_EXECUTOR_MAX_FIX_ITERATIONS`: Max fix loop iterations (default: 5)
- `MISSION_EXECUTOR_SKIP_PHASES`: Comma-separated phases to skip (e.g., "DECOMPOSE" to use features as-is)
