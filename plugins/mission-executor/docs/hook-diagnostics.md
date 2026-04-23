# Hook diagnostic protocol

Every mission-executor hook logs to `auditLogFile()`
(`<layoutRoot>/state/hook-audit.log` — resolved via
`hooks/_lib/paths.mjs`) via `hooks/_lib/audit.mjs`.

## When enforcement appears bypassed

First diagnostic: compare the session's tool calls against `hookInfos`
entries in `~/.claude/projects/<cwd-encoded>/<session-id>.jsonl`. That
is Claude Code's own record of which hook commands it dispatched for
each event.

- If mission-executor hooks are absent from `hookInfos` (or the
  `command` field inside them does not mention our `.mjs` files), Claude
  Code never registered them.
- The audit log is only written when hooks actually run, so an empty
  log could mean either "hook ran but audit failed" or "hook never
  registered". `hookInfos` disambiguates.

## Release gate

Run `node scripts/selfcheck-hooks.mjs` before any release to catch
discovery-path regressions. The selfcheck probes the plugin layout and
confirms every hook in `hooks.json` resolves to a real `.mjs` file.
