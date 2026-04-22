#!/usr/bin/env node
// PreToolUse hook: block AskUserQuestion while a mission is active, and tell
// Claude exactly what command to run next instead of asking.
//
// /mission-executor:mission-execute is autopilot. The assistant must make
// decisions and continue; it cannot pause to ask the user. If the assistant
// believes a question is needed, it should pick the most defensible default
// and continue. The autopilot-lock Stop hook ensures a wrong choice gets
// corrected in the FIX loop without human intervention.
//
// SCHEMA: emits both the modern hookSpecificOutput form (Claude Code 2.x)
// and the legacy top-level {decision,message} form (older Claude Code).
//
// The permissionDecisionReason includes the concrete next command from
// mission-state so the assistant has an action path instead of just being
// blocked.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMissionState } from "./_lib/mission-state.mjs";
import { audit } from "./_lib/audit.mjs";
import { suggestNextAction } from "./_lib/mission-state.mjs";

function pluginRoot() {
  // hooks/foo.mjs -> plugin root is two levels up from this file
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..");
}

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

  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();
  const { state } = loadMissionState(cwd);
  if (!state || !state.active) {
    audit("no-ask-during-mission", { decision: "allow", reason: "no-active-mission" });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  // Build a reason that includes the concrete next action so the assistant
  // has a command to run instead of an unanswered question.
  let nextAction = "# (mission-query.mjs unavailable)";
  try {
    nextAction = suggestNextAction(state.missionPath, "${CLAUDE_PLUGIN_ROOT}");
  } catch {}

  const reason = [
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
    "Escape hatch: user may create .omc/state/mission-executor-abort to break the lock.",
  ].join("\n");

  audit("no-ask-during-mission", {
    decision: "deny",
    missionPath: state.missionPath,
    phase: state.phase,
  });

  process.stdout.write(JSON.stringify(denyPayload(reason)));
}

main().catch((e) => {
  process.stderr.write(`no-ask-during-mission error: ${e.message}\n`);
  audit("no-ask-during-mission", { decision: "allow", reason: `error:${e.message}` });
  process.stdout.write(JSON.stringify(allowPayload()));
});
