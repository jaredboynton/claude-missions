@AGENTS.md

## Claude Code

This is a Claude Code plugin marketplace. When iterating on plugin code:

- Plugins are hot-loaded via `/reload-plugins`. After editing `.mjs` files
  under `plugins/<name>/`, run `/reload-plugins` before testing slash-commands.
- `claude plugin update <name>@claude-missions` from the shell will NOT refresh
  the current session. Use the TUI menu (see AGENTS.md > Commands).
- Slash-commands register as `/<plugin-name>:<command>` — e.g.
  `/mission-executor:execute`, not `/execute`.
- Hook discovery scans `plugins/<name>/hooks/hooks.json` only.
  `.claude-plugin/hooks.json` is silently ignored.
- Environment variables set by the plugin loader:
  `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_WORKING_DIR`.
- Session-id inside hooks arrives via stdin JSON (`hook_event_name`,
  `session_id`, etc.), not env vars. See `hooks/_lib/mission-state.mjs`
  and `scripts/_lib/resolve-sid.sh` for the three-tier resolver.
