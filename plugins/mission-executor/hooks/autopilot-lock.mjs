#!/usr/bin/env node
// Stop hook: lock the assistant into mission completion.
//
// When /mission-executor:mission-execute is running, mission-lifecycle.mjs
// writes .omc/state/mission-executor-state.json with active: true. This
// Stop hook reads that state and BLOCKS the assistant from ending its
// turn until every completion criterion is met:
//
//   1. validation-state.json: all assertions have status=passed AND a
//      proof block with commitSha.
//   2. features.json: every feature has status=completed.
//   3. state.json: mission state == "completed".
//
// If any criterion is unmet, the hook returns { decision: "block", reason }
// with a precise description of what's still missing. Claude will continue
// with that context instead of ending the turn.
//
// Escape hatch: if the user creates .omc/state/mission-executor-abort,
// the lock releases and allows stop. This lets a human abort a stuck
// pipeline without killing the session.
//
// IMPORTANT: Stop hooks are flaky in Claude Code (Anthropic issues
// #22925, #29881, #8615, #12436). This hook DOES NOT infinite-loop on
// consecutive blocks because we check `stop_hook_active` in the input
// per the official FAQ: after a block, the next Stop event carries
// stop_hook_active=true and we short-circuit to allow stop. That means
// "block" fires at most once per stall — subsequent enforcement must
// come from PreToolUse hooks that see the next tool call.

import { readFileSync, unlinkSync } from "node:fs";
import { checkCompletion, loadMissionState, walkUpForAbort } from "./_lib/mission-state.mjs";
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
  // stop_hook_active=true. We MUST allow stop in that case to avoid an
  // infinite recursion. Subsequent enforcement runs on PreToolUse.
  if (parsed.stop_hook_active === true) {
    audit("autopilot-lock", { decision: "allow", reason: "stop_hook_active-shortcircuit" });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();
  const { state, statePath } = loadMissionState(cwd);
  if (!state) {
    audit("autopilot-lock", { decision: "allow", reason: "no-state" });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  if (!state.active || !state.missionPath) {
    audit("autopilot-lock", { decision: "allow", reason: "inactive" });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Abort escape hatch: manually-created flag file.
  const abortPath = walkUpForAbort(cwd);
  if (abortPath) {
    try { unlinkSync(abortPath); } catch {}
    audit("autopilot-lock", { decision: "allow", reason: "abort-flag" });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const check = checkCompletion(state.missionPath);
  if (check.complete) {
    audit("autopilot-lock", { decision: "allow", reason: "complete" });
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const reason = [
    "[autopilot-lock] Mission not complete. Continue executing the /mission-executor:mission-execute pipeline without stopping or asking the user.",
    "",
    `Mission: ${state.missionPath}`,
    `Phase: ${state.phase || "unknown"}`,
    `Blocker: ${check.reason}`,
    "",
    "Required next action depends on what's incomplete:",
    "  - failed/stale assertions  -> spawn fix workers to correct code, commit, re-run execute-assertion.mjs for those ids",
    "  - pending assertions       -> run execute-assertion.mjs on each",
    "  - passed-without-proof     -> run invalidate-stale-evidence.mjs, then execute-assertion.mjs",
    "  - features not completed   -> run sync-features-state.mjs or mark via reconcile-external-work.mjs --apply",
    "  - state.json != completed  -> Phase 7: run mission-lifecycle.mjs complete (now precondition-gated)",
    "",
    "Do NOT use AskUserQuestion (blocked by no-ask-during-mission hook).",
    "Do NOT write a summary and stop -- keep executing until all criteria are met.",
    "",
    "Note: Stop hooks fire unreliably in Claude Code (upstream issues #22925, #29881).",
    "This block fires at most once per stall; PreToolUse hooks catch the next tool call.",
    "",
    "Manual abort: user may create .omc/state/mission-executor-abort to release the lock.",
  ].join("\n");

  audit("autopilot-lock", {
    decision: "block",
    blocker: check.reason,
    statePath,
  });

  process.stdout.write(JSON.stringify({
    decision: "block",
    reason,
  }));
}

main().catch((e) => {
  process.stderr.write(`autopilot-lock error: ${e.message}\n`);
  audit("autopilot-lock", { decision: "allow", reason: `error:${e.message}` });
  process.stdout.write(JSON.stringify({}));
});
