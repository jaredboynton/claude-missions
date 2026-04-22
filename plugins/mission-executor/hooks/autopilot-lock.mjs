#!/usr/bin/env node
// Stop hook: lock the assistant into mission completion.
//
// v0.5.0: enforcement is scoped to sessions in state.attachedSessions[]. A
// session that didn't /mission-executor:execute is invisible to this hook.
//
// Hook input stdin: JSON { session_id, stop_hook_active, ... }
// On block: { decision: "block", reason: "..." }

import { readFileSync, unlinkSync } from "node:fs";
import {
  checkCompletion, loadAttachedMissionState, readAbortFlag, clearAbortFlag,
  migrateLegacyAttach,
} from "./_lib/mission-state.mjs";
import { audit } from "./_lib/audit.mjs";

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try { parsed = JSON.parse(input); } catch {
    audit("autopilot-lock", { decision: "allow", reason: "unparseable-input" });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Official FAQ: if the previous Stop already blocked, the next call carries
  // stop_hook_active=true. Allow stop to avoid infinite recursion.
  if (parsed.stop_hook_active === true) {
    audit("autopilot-lock", { decision: "allow", reason: "stop_hook_active-shortcircuit" });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const sessionId = parsed.session_id;
  const cwd = parsed.cwd || process.env.CLAUDE_WORKING_DIR || process.cwd();
  const { state, statePath, reason } = loadAttachedMissionState({ sessionId, cwd });

  if (!state) {
    audit("autopilot-lock", { decision: "allow", reason: reason || "no-state", session_id: sessionId });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Legacy auto-attach: fire migration in the background (await briefly so it
  // completes before the hook exits, but deadline is short).
  if (reason === "legacy-auto-attach-pending") {
    try { await migrateLegacyAttach({ sessionId, cwd }); } catch {}
  }

  if (!state.active || !state.missionPath) {
    audit("autopilot-lock", { decision: "allow", reason: "inactive", session_id: sessionId });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Abort escape hatch
  const abortPath = readAbortFlag();
  if (abortPath) {
    clearAbortFlag();
    audit("autopilot-lock", { decision: "allow", reason: "abort-flag", session_id: sessionId });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const check = checkCompletion(state.missionPath);
  if (check.complete) {
    audit("autopilot-lock", { decision: "allow", reason: "complete", session_id: sessionId });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const reasonText = [
    "[autopilot-lock] Mission not complete. Continue executing the /mission-executor:mission-execute pipeline without stopping or asking the user.",
    "",
    `Mission: ${state.missionPath}`,
    `Phase: ${state.phase || "unknown"}`,
    `Blocker: ${check.reason}`,
    "",
    "Required next action depends on what's incomplete:",
    "  - failed/stale assertions  -> spawn fix workers, commit, re-run execute-assertion.mjs for those ids",
    "  - pending assertions       -> run execute-assertion.mjs on each",
    "  - passed-without-proof     -> run invalidate-stale-evidence.mjs, then execute-assertion.mjs",
    "  - features not completed   -> sync-features-state.mjs or reconcile-external-work.mjs --apply",
    "  - state.json != completed  -> node scripts/mission-cli.mjs complete --session-id=<sid>",
    "",
    "Do NOT use AskUserQuestion (blocked by no-ask-during-mission hook).",
    "Do NOT write a summary and stop -- keep executing until all criteria are met.",
    "",
    "Note: Stop hooks fire unreliably in Claude Code (upstream issues #22925, #29881).",
    "This block fires at most once per stall; PreToolUse hooks catch the next tool call.",
    "",
    "Manual abort: run /mission-executor:abort to release the lock.",
  ].join("\n");

  audit("autopilot-lock", { decision: "block", blocker: check.reason, statePath, session_id: sessionId });

  process.stdout.write(JSON.stringify({ decision: "block", reason: reasonText }));
}

main().catch((e) => {
  process.stderr.write(`autopilot-lock error: ${e.message}\n`);
  audit("autopilot-lock", { decision: "allow", reason: `error:${e.message}` });
  process.stdout.write(JSON.stringify({}));
});
