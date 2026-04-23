@AGENTS.md

## Claude Code

Plugin-specific Claude Code notes beyond the marketplace-level addenda in
`../../CLAUDE.md`:

- When editing hooks, reload with `/reload-plugins` AND start a fresh session
  to exercise `SessionStart` (`session-start-record.mjs`). Existing sessions
  don't re-fire SessionStart on plugin reload.
- Hook stdin payload shape for this plugin: parsed via
  `hooks/_lib/mission-state.mjs > loadAttachedMissionState`. The `session_id`
  field is the mission-scoped key; it must appear in
  `state.attachedSessions[]` or the hook no-ops out.
- Stop hooks are flaky in Claude Code (upstream #22925, #29881, #8615,
  #12436). `autopilot-lock.mjs` runs at Stop but never relies on it alone;
  every NEVER-rule is also enforced at PreToolUse.
- Progress-log events are the ONLY channel that crosses from runtime state
  into the host session's view. Emit via `mission-cli.mjs event <type>` or
  let lifecycle subcommands auto-emit. Never write JSONL lines by hand.
- Tier 2 native Agent Teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  in the host environment AND smoke-probe pass (upstream #40270). Check
  AGENTS.md Appendix A before assuming teams are available.
