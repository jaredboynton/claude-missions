# claude-missions — agent notes

## Project Overview

`claude-missions` is a Claude Code plugin marketplace that ships
orchestration tooling for Factory/droid missions. The one shipping plugin
today, `mission-executor`, reads a Factory mission spec under
`.factory/missions/<id>/`, decomposes features into parallel team batches,
re-validates every assertion independently, and loops until a critic
confirms a 100% pass rate.

Primary users are Claude Code operators driving Factory missions through
autopilot on their own repos.

New capabilities ship as additional plugins under `plugins/<name>/`, not
as forks of `mission-executor`. Per-plugin conventions live in
`plugins/<name>/AGENTS.md`; this file stays thin and marketplace-scoped.

## Architecture

```
claude-missions/
├── .claude-plugin/
│   └── marketplace.json            Marketplace registry (one entry per plugin)
├── plugins/
│   └── mission-executor/           See plugins/mission-executor/AGENTS.md
│       ├── .claude-plugin/plugin.json
│       ├── commands/  hooks/  scripts/  skills/  tests/  docs/
│       ├── AGENTS.md  CLAUDE.md  CHANGELOG.md  README.md
├── AGENTS.md   This file (marketplace-level orientation)
├── CLAUDE.md   One-line `@AGENTS.md` import + Claude-only addenda
├── LICENSE     MIT
└── README.md   User-facing marketplace docs
```

Rules:

- New plugins live under `plugins/<name>/` with their own
  `.claude-plugin/plugin.json`, `AGENTS.md`, and `CLAUDE.md`.
- `marketplace.json` is the only root-level registry; bump its version
  when adding a plugin or releasing a plugin bump.
- Do not create shared utilities at the marketplace root. Each plugin is
  self-contained (no cross-plugin imports, no shared `scripts/` or `lib/`).
- Per-plugin coding conventions, testing rules, and safe-change rules
  live in the plugin's own `AGENTS.md` — not here.

## File and Component Placement Rules

- New plugin → `plugins/<name>/` with the skeleton above.
- Plugin-scoped helper → inside that plugin, never at marketplace root.
- Plugin hook files → `<plugin>/hooks/hooks.json` (Claude Code's
  auto-discovery path). `.claude-plugin/hooks.json` is silently ignored.
- Do not add `package.json` anywhere — the marketplace is stdlib-only.
  If a future plugin needs npm, it declares its own `package.json`
  under `plugins/<name>/`, not at the root.

## Commands

End-user install:

```sh
claude plugin marketplace add jaredboynton/claude-missions
claude plugin install <plugin-name>@claude-missions
```

End-user update from inside the TUI (the shell `claude plugin update`
command does NOT refresh an active Claude Code session):

```
/plugin  →  Installed  →  filter: missions  →  <plugin>  →  Update now
/reload-plugins
```

Per-plugin development commands live in `plugins/<name>/AGENTS.md`.

## Safe-Change Rules (marketplace-scoped)

- Do not bump `marketplace.json` version without a matching plugin bump
  and a dated `CHANGELOG.md` entry in that plugin.
- Do not introduce network calls from marketplace-level files — the
  marketplace ships no scripts; plugins enforce their own network policy.
- Do not move a plugin's `hooks/hooks.json` into `.claude-plugin/` —
  Claude Code auto-discovery only scans `hooks/hooks.json`.

## Adding a new plugin

1. `mkdir -p plugins/<name>/.claude-plugin && mkdir -p plugins/<name>/{commands,hooks,scripts,skills,tests}`
2. Seed `plugins/<name>/.claude-plugin/plugin.json` (copy from `mission-executor/`)
3. Seed `plugins/<name>/AGENTS.md` (follow `plugins/mission-executor/AGENTS.md`)
4. Seed `plugins/<name>/CLAUDE.md` with `@AGENTS.md` + any Claude-only addenda
5. Append to `.claude-plugin/marketplace.json` `plugins` array
6. Bump `marketplace.json` version
7. Commit and push

## Cross-tool memory files (AGENTS.md vs CLAUDE.md)

Source: https://code.claude.com/docs/en/memory.

- Claude Code reads only `CLAUDE.md` — never `AGENTS.md`.
- Codex, Cursor, Copilot, Factory read `AGENTS.md` — never `CLAUDE.md`.

Both files exist at the marketplace root AND inside each plugin. Each
`CLAUDE.md` is a one-line `@AGENTS.md` import so Claude-specific addenda
can live beneath without duplicating content.
