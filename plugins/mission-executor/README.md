# mission-executor

Full autopilot execution of Factory/droid missions with parallel teams, independent validation, and critic-gated completion.

## Skills

| Skill | Trigger | Description |
|-------|---------|-------------|
| `/mission-execute <path>` | "execute mission", "run mission" | Full pipeline: ingest -> decompose -> execute -> verify -> critic -> fix loop |
| `/mission-validate <path>` | "validate mission" | Standalone validation pass against current codebase |
| `/mission-status <path>` | "mission status" | Quick progress check (features + assertions) |

## Hooks

| Hook | Type | Matcher | Purpose |
|------|------|---------|---------|
| worker-boundary-enforcer | PreToolUse | Bash, Edit, Write | Block git push, pkill, protected path edits |
| commit-scope-guard | PreToolUse | Bash (git add/commit) | Warn about protected uncommitted files |
| validation-tracker | PostToolUse | All (during verify phase) | Auto-update validation-state.json from tool output |
| build-discipline | PostToolUse | Edit, Write | Remind to build after source file changes |

## Pipeline Phases

0. VALIDATE: Schema + cross-reference checks (JS + Factory's Python harness). Hard gate on errors
1. INGEST: Parse features.json, validation-contract.md, AGENTS.md
1.5. RECONCILE: Detect zombies + external work already in git HEAD. Skip execution for features already complete
2. DECOMPOSE: Group remaining features into parallel batches by milestone + code-path independence
3. EXECUTE: Spawn team workers per batch, monitor, shutdown, sync features.json from git
4. VERIFY: Run each assertion independently (unit-test, curl, cli-binary, tuistory); record via record-assertion.mjs so validatedAtMilestone is always populated
5. CRITIC: Opus-tier critic evaluates all assertions. Exit only on "all validation criteria have been met"
6. FIX: Spawn fix workers for failures, re-validate (max 5 iterations)
7. COMPLETE: Flip features to completed, update state.json, re-run Phase 0 as exit gate

## Mission Directory Schema

Required files in `.factory/missions/<id>/`:
- `features.json` - Feature specs with milestones, skillNames, fulfills arrays
- `validation-contract.md` - Behavioral assertions with tool types and evidence criteria
- `validation-state.json` - Assertion status tracking (pending/passed/failed/blocked)
- `state.json` - Mission lifecycle state
- `AGENTS.md` - Worker boundary rules and coding conventions
- `working_directory.txt` - Project root path

## Configuration

- `MISSION_EXECUTOR_MAX_WORKERS`: Max concurrent workers per batch (default: 5)
- `MISSION_EXECUTOR_MAX_FIX_ITERATIONS`: Max fix loop iterations (default: 5)

## Lessons Encoded

1. Workers lie about completion -- validator independently tests every assertion
2. Typecheck errors cascade between workers -- build verification between batches
3. Milestone dependencies are often artificial -- override where code paths are independent
4. Hook enforcement > prompt trust for boundary rules
5. Verifier false positives happen -- use code reads, not just grep patterns
6. HTTP servers serve stale code after rebuilds -- restart required
7. Fix loop must be bounded to prevent infinite retries
8. features.json stays pending unless explicitly written back -- sync-features-state after every batch
9. External work must be reconciled before dispatch -- reconcile-external-work in Phase 1.5
10. Zombie `workerSessionIds` appear alive in features.json -- detect-zombies cross-checks progress_log
11. Schema drift bites late -- Phase 0 validates against Factory's harness contract before any write; Phase 7 re-runs it as the exit gate
12. Validation writes must go through record-assertion.mjs so `validatedAtMilestone` is populated from feature.fulfills; hand-written entries fail the harness check

## Scripts (11 total)

| Script | Purpose |
|--------|---------|
| parse-mission.mjs | Parse + validate mission directory |
| validate-schema.mjs | JS port of Factory's mission_contracts.py; schema + cross-reference checks |
| validate-mission.mjs | Combined validator: runs validate-schema.mjs AND Factory's Python harness when available |
| decompose-features.mjs | Group features into parallel batches |
| generate-worker-prompts.mjs | Build complete worker prompts from feature specs |
| run-assertion.mjs | Generate assertion validation commands |
| record-assertion.mjs | Write validation-state.json entries with `validatedAtMilestone` populated |
| critic-evaluator.mjs | Evaluate pass/fail verdict from validation-state |
| sync-features-state.mjs | Write back features.json status from git HEAD after batches (no non-schema keys) |
| detect-zombies.mjs | Classify features as dead-work-landed, dead-no-session, pending-but-landed, or healthy |
| reconcile-external-work.mjs | Score each feature's completion evidence, route to skip/verify/execute |
