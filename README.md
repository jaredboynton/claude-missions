# claude-missions

Claude Code plugins for orchestrating Factory/droid mission execution. Built for the `.factory/missions/` schema: parallel team execution, independent assertion validation, critic-gated completion.

## Plugins

### `mission-executor`

Full autopilot execution of Factory/droid missions.

**Install:**

```bash
claude plugin marketplace add jaredboynton/claude-missions
claude plugin install mission-executor@claude-missions
```

**What it does:**

Reads a mission directory under `.factory/missions/<id>/`, decomposes features into parallel team batches, executes them, validates every assertion independently, and loops until a critic confirms 100% pass rate. Respects mission boundaries (NEVER-rules from AGENTS.md) via hooks, syncs `features.json` state from git HEAD after every batch, detects zombie worker sessions, and reconciles externally-landed work before dispatching.

**Skills:**

| Command | Purpose |
|---------|---------|
| `/mission-execute <path>` | Full autopilot: ingest -> reconcile -> decompose -> execute -> verify -> critic -> fix loop |
| `/mission-validate <path>` | Standalone validation pass against current codebase |
| `/mission-status <path>` | Quick progress check (features + assertions) |

**Hooks (enforce mission boundaries):**

| Hook | Type | Purpose |
|------|------|---------|
| worker-boundary-enforcer | PreToolUse | Block `git push`, `pkill`, protected path edits |
| commit-scope-guard | PreToolUse(Bash) | Warn on staging of pre-existing uncommitted files |
| validation-tracker | PostToolUse | Auto-update `validation-state.json` from tool output |
| build-discipline | PostToolUse(Edit/Write) | Remind to build after source file changes |

## Design principles

1. **Workers lie** -- every assertion is tested independently, regardless of commit claims
2. **Mission runner goes blind without state write-back** -- `sync-features-state` runs after every batch
3. **External work must be reconciled** -- `reconcile-external-work` scores features in git HEAD before dispatch
4. **Zombies look alive** -- `detect-zombies` cross-references `workerSessionIds` with `progress_log.jsonl`
5. **Hook enforcement > prompt trust** -- NEVER-rules are enforced at tool level, not via instructions

## License

MIT
