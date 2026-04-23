# claude-missions — agent notes

## Project Overview

`claude-missions` is a Claude Code plugin marketplace that ships orchestration
tooling for Factory/droid missions. The single plugin today, `mission-executor`,
reads a mission directory under `.factory/missions/<id>/`, decomposes features
into parallel team batches, validates every assertion independently, and loops
until a critic confirms a 100% pass rate.

Primary users are Claude Code operators driving Factory mission specs through
autopilot on their own repos.

The marketplace optimizes for:
- workers-lie-by-default validation (every assertion is retested)
- hook-level enforcement of mission boundaries (PreToolUse, not prompt trust)
- state write-back after every batch (features.json drift is fatal)
- external-work reconciliation before dispatch (git HEAD is the source of truth)

Avoid inventing new orchestration patterns here. New capabilities ship as
additional plugins under `plugins/<name>/`, not as forks of mission-executor.

## Tech Stack

- Node.js ES modules (`.mjs`), stdlib-only — no `package.json`, no `node_modules`
- Shell: POSIX `sh` / bash for slash-command entrypoints
- Python 3 (stdlib) — optional, for Factory harness cross-check only
- Tests: `node:test` + `node:assert/strict` (stdlib)
- Runtime: Claude Code plugin loader (`plugin.json` + `marketplace.json`)

Do not introduce:
- npm/yarn/pnpm dependencies
- TypeScript transpilation
- external test runners (vitest, jest, mocha)
- schema-validation libraries (ajv, zod, yup) — we ship a hand-rolled
  validator in `plugins/mission-executor/scripts/_lib/schemas.mjs`

unless a design note in a CHANGELOG entry explicitly calls for them.

## Architecture

```
claude-missions/
├── .claude-plugin/
│   └── marketplace.json            Marketplace registry (one entry per plugin)
├── plugins/
│   └── mission-executor/           The one shipping plugin. See its AGENTS.md.
│       ├── .claude-plugin/
│       │   └── plugin.json         Plugin manifest + version
│       ├── commands/               Slash-command markdown files
│       ├── hooks/                  PreToolUse / PostToolUse / Stop / SessionStart
│       │   └── hooks.json          Discovery path (MUST live here, not in .claude-plugin/)
│       ├── scripts/                Node ES modules invoked by commands + hooks
│       ├── skills/                 Skill markdown bundles used by slash-commands
│       └── tests/                  node:test suites
├── AGENTS.md                       This file (marketplace-level orientation)
├── CLAUDE.md                       One-line @-import of AGENTS.md + Claude-only addenda
├── LICENSE                         MIT
└── README.md                       User-facing marketplace docs
```

Rules:
- New plugins live under `plugins/<name>/` with their own
  `.claude-plugin/plugin.json`, own `AGENTS.md`, own `CLAUDE.md`.
- `marketplace.json` is the only root-level registry — bump when adding a plugin.
- Do not create shared utilities at the marketplace root. Each plugin is
  self-contained (no cross-plugin imports).
- Plugin hook files land at `<plugin>/hooks/hooks.json` (Claude Code's
  discovery path); `.claude-plugin/hooks.json` is silently ignored.

## Coding Conventions

- Node ES modules only (`.mjs`); no CommonJS, no TypeScript
- Use `node:`-prefixed built-in imports (`node:fs`, `node:path`, `node:child_process`)
- Prefer `readFileSync` / `writeFileSync` / `existsSync` over async variants for
  short-lived script entrypoints; reserve async for genuinely concurrent I/O
- Shebang on every script entrypoint: `#!/usr/bin/env node`
- Keep scripts under ~500 lines; extract shared helpers to `scripts/_lib/`
- Explicit exit codes: `0` success, `1` error, `2` bad args, `3+` domain-specific
- No `console.log` in hooks — audit via `hooks/_lib/audit.mjs`
- Never hand-write state files that are guarded (`validation-state.json`,
  `features.json`); the PreToolUse hooks block them
- All on-disk paths go through `hooks/_lib/paths.mjs`; no hardcoded
  `.mission-executor/` or `.omc/` literals outside that module
- Tests use `import { test } from "node:test"` + `assert from "node:assert/strict"`
- `CHANGELOG.md` is bumped per plugin, per release, with dated entries

## Testing and Quality

Before considering a task complete (per plugin):

```sh
cd plugins/<plugin-name>
node --test tests/
node scripts/selfcheck-hooks.mjs
```

Testing rules:
- Every behavior change in `scripts/` or `hooks/` gets a regression test
- Shell helpers (`scripts/_lib/resolve-sid.sh`) get `node:test` wrappers
  that spawn them and assert on stdout/stderr/exit-code
- Concurrency-sensitive code (progress-log, registry, state-file) gets a
  multi-writer stress test (see `tests/progress-log.test.mjs` — 20 parallel writers)
- Never mark a release "done" without `node scripts/selfcheck-hooks.mjs`
  passing; it catches hook-registration regressions that unit tests won't

## File and Component Placement Rules

- New Node script invoked by a hook or slash-command → `plugins/<p>/scripts/<verb>-<noun>.mjs`
- Shared helper used by 2+ scripts → `plugins/<p>/scripts/_lib/<name>.mjs`
- New hook → `plugins/<p>/hooks/<name>.mjs` + entry in `hooks/hooks.json`
- New on-disk path → add helper to `hooks/_lib/paths.mjs`, never inline the path
- New slash command → `plugins/<p>/commands/<name>.md`
- New skill → `plugins/<p>/skills/<name>/SKILL.md`
- Tests → `plugins/<p>/tests/<script-or-hook>.test.mjs`, one file per module

Do not create:
- marketplace-level `scripts/` or `lib/` (plugins stay self-contained)
- `package.json` anywhere — we are stdlib-only
- new abstractions for one-off usage (inline it in the caller)

## Safe-Change Rules

- Do not bump `plugin.json.version` or `marketplace.json.version` without a
  matching `CHANGELOG.md` entry in the same commit
- Do not rename or delete exports from `hooks/_lib/paths.mjs` — every script
  imports from it; breaking changes require a 1.0.0-candidate flag in CHANGELOG
- Do not remove the legacy `.omc/` autodetect branch in `paths.mjs > layoutRoot()`
  without a documented migration path (it exists for in-flight 0.4.x missions)
- Do not move `hooks/hooks.json` into `.claude-plugin/` — Claude Code's
  auto-discovery only scans `hooks/hooks.json`; moving it ships zero enforcement
- Do not introduce network calls from hooks or scripts — everything is local
- Preserve back-compat for `MISSION_EXECUTOR_STATE_DIR` (it is the 0.4.x
  alias and still in use by OMC installs)

## Commands

Plugin install (end-user):

```sh
claude plugin marketplace add jaredboynton/claude-missions
claude plugin install mission-executor@claude-missions
```

Plugin update (end-user, from inside the TUI — `claude plugin update` from
the shell does NOT refresh an active session):

```
/plugin  →  Installed  →  filter: missions  →  mission-executor  →  Update now
/reload-plugins
```

Development (per plugin):

```sh
cd plugins/mission-executor
node --test tests/
node scripts/selfcheck-hooks.mjs
node scripts/validate-mission.mjs <mission-path>
```

Release a new plugin version:

1. Edit code + tests
2. Bump `plugins/<p>/.claude-plugin/plugin.json` version
3. Bump `.claude-plugin/marketplace.json` version (match the plugin bump)
4. Add dated entry to `plugins/<p>/CHANGELOG.md`
5. `cd plugins/<p> && node --test tests/ && node scripts/selfcheck-hooks.mjs`
6. Commit, push, update via TUI menu (see above)

## Appendix: Marketplace-level conventions

### Cross-tool memory files (AGENTS.md vs CLAUDE.md)

Source: https://code.claude.com/docs/en/memory

- Claude Code reads only `CLAUDE.md` — never `AGENTS.md`.
- Codex, Cursor, Copilot, Factory read `AGENTS.md` — never `CLAUDE.md`.

Both files exist at the marketplace root AND inside each plugin. Each `CLAUDE.md`
is a one-line `@AGENTS.md` import so Claude-specific addenda can live beneath
without duplicating content.

### Why the marketplace has no `package.json`

Claude Code plugins are loaded directly from disk — the plugin loader executes
`.mjs` files with the host's Node runtime. A `package.json` would only add
dependency-management overhead without unlocking any capability we use. If a
future plugin genuinely needs npm, it declares its own `package.json` under
`plugins/<name>/`, not at the marketplace root.

### Adding a new plugin

1. `mkdir -p plugins/<name>/.claude-plugin && mkdir -p plugins/<name>/{commands,hooks,scripts,skills,tests}`
2. Seed `plugins/<name>/.claude-plugin/plugin.json` (copy from `mission-executor/`)
3. Seed `plugins/<name>/AGENTS.md` (follow the mission-executor template)
4. Seed `plugins/<name>/CLAUDE.md` with a single line: `@AGENTS.md`
5. Append to `.claude-plugin/marketplace.json` `plugins` array
6. Bump `marketplace.json` version
7. Commit, push
