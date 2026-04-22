#!/usr/bin/env node
// PreToolUse(AskUserQuestion) hook: block interactive questions while this
// session is attached to an active mission.
//
// v0.5.0: gated on session_id membership in state.attachedSessions[].

import { loadAttachedMissionState, suggestNextAction, migrateLegacyAttach } from "./_lib/mission-state.mjs";
import { audit } from "./_lib/audit.mjs";

function denyPayload(reason) {
  return {
    decision: "block",
    message: reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function allowPayload() {
  return {
    decision: "allow",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try { parsed = JSON.parse(input); } catch {
    audit("no-ask-during-mission", { decision: "allow", reason: "unparseable-input" });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  if (parsed.tool_name !== "AskUserQuestion") {
    audit("no-ask-during-mission", { decision: "allow", tool: parsed.tool_name, reason: "wrong-tool" });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  const sessionId = parsed.session_id;
  const cwd = parsed.cwd || process.env.CLAUDE_WORKING_DIR || process.cwd();
  const { state, reason } = loadAttachedMissionState({ sessionId, cwd });

  if (!state || !state.active) {
    audit("no-ask-during-mission", { decision: "allow", reason: reason || "no-active-mission", session_id: sessionId });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  if (reason === "legacy-auto-attach-pending") {
    try { await migrateLegacyAttach({ sessionId, cwd }); } catch {}
  }

  let nextAction = "# (mission-query unavailable)";
  try { nextAction = suggestNextAction(state.missionPath, "${CLAUDE_PLUGIN_ROOT}"); } catch {}

  const reasonText = [
    "[autopilot-lock] AskUserQuestion is blocked while /mission-executor:mission-execute is active.",
    "",
    "Autopilot does not pause for user input. Pick the most defensible default based on:",
    "  - the mission's AGENTS.md boundaries",
    "  - the feature/assertion spec in features.json / validation-contract.md",
    "  - existing code patterns in the working directory",
    "and continue. If the decision is wrong, the FIX loop will catch it.",
    "",
    `Active mission: ${state.missionPath}`,
    `Phase: ${state.phase || "unknown"}`,
    "",
    "Next concrete action (auto-suggested from mission state):",
    nextAction,
    "",
    "Escape hatch: run /mission-executor:abort to release the lock.",
  ].join("\n");

  audit("no-ask-during-mission", { decision: "deny", missionPath: state.missionPath, phase: state.phase, session_id: sessionId });
  process.stdout.write(JSON.stringify(denyPayload(reasonText)));
}

main().catch((e) => {
  process.stderr.write(`no-ask-during-mission error: ${e.message}\n`);
  audit("no-ask-during-mission", { decision: "allow", reason: `error:${e.message}` });
  process.stdout.write(JSON.stringify(allowPayload()));
});
