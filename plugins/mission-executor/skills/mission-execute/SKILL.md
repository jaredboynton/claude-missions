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

### Phase 0: VALIDATE (hard gate)

Before doing anything else, run schema + cross-reference validation against the
mission directory. This catches malformed `features.json` / `validation-state.json`
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

### Phase 4a: INVALIDATE STALE EVIDENCE

Before running any new assertion, sweep prior proofs that are no longer
fresh. A passed assertion whose `proof.commitSha` is not an ancestor of
HEAD (or whose touchpoints changed since the proof was captured) is
flipped to `stale` and its proof bundle is archived.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/invalidate-stale-evidence.mjs" "$MISSION_PATH"
```

This is the first line of defense against the bee21e7c failure mode: the
prior wave had 95 passed assertions with evidence strings reading
`"critic-confirmed in prior session"`. No command had been run this run.
The invalidator demotes every such entry to `stale` so Phase 4b re-runs
them from scratch.

### Phase 4b: VERIFY (driven by execute-assertion.mjs)

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
`.omc/validation/proofs/<id>/{stdout.txt,stderr.txt,meta.json}` and
records:

```json
{
  "status": "passed",
  "proof": {
    "commitSha": "<HEAD at execution>",
    "toolType": "curl",
    "command": "curl -sS ...",
    "exitCode": 0,
    "stdoutSha256": "...",
    "stderrSha256": "...",
    "stdoutPath": ".omc/validation/proofs/VAL-X/stdout.txt",
    "stderrPath": ".omc/validation/proofs/VAL-X/stderr.txt",
    "touchpoints": ["packages/kep/src/..."],
    "executedAt": "2026-04-18T...",
    "executor": "execute-assertion.mjs"
  }
}
```

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

- `proof` block present with all required fields
- `proof.commitSha` is an ancestor of HEAD
- recomputed sha256 of `stdoutPath`/`stderrPath` matches proof

Any failure here means a proof was tampered with or never produced. The
critic returns verdict `INCOMPLETE` / `FAIL` and does NOT proceed to Stage B.

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
8. Report final status to user

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

## Configuration

Environment variables:
- `MISSION_EXECUTOR_MAX_WORKERS`: Max concurrent workers per batch (default: 5)
- `MISSION_EXECUTOR_MAX_FIX_ITERATIONS`: Max fix loop iterations (default: 5)
- `MISSION_EXECUTOR_SKIP_PHASES`: Comma-separated phases to skip (e.g., "DECOMPOSE" to use features as-is)
