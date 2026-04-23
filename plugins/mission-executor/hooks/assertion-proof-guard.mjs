#!/usr/bin/env node
// PreToolUse hook: gate writes to validation-state.json.
//
// Only execute-assertion.mjs and record-assertion.mjs (when called by the
// plugin itself) may modify validation-state.json. Everything else -- a worker
// trying to "fix" their test result, an orchestrator agent spot-editing,
// a forgotten Write tool call -- is blocked at the tool level.
//
// Contract:
//   - Plugin scripts set MISSION_EXECUTOR_WRITER=1 before invoking record-assertion.
//   - This hook reads the env at fork time via parent-process env passthrough.
//   - Claude Code does NOT propagate env vars set by a script into the
//     Write/Edit tool invocations the orchestrator makes. So the safe path:
//     the orchestrator invokes record-assertion.mjs AS A SHELL COMMAND
//     (MISSION_EXECUTOR_WRITER=1 node record-assertion.mjs ...), not hand-edit.
//
// SCHEMA: emits both the modern hookSpecificOutput form (Claude Code 2.x) and
// the legacy top-level {decision,message} form (older Claude Code). New
// clients honor hookSpecificOutput; older clients fall back to the top-level.

import { audit } from "./_lib/audit.mjs";

const BLOCKED_FILENAME = "validation-state.json";

function denyPayload(reason) {
  return {
    // Legacy schema (deprecated, still honored by older Claude Code)
    decision: "block",
    message: reason,
    // Modern schema (2.x+)
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
  try {
    parsed = JSON.parse(input);
  } catch {
    audit("assertion-proof-guard", { decision: "allow", reason: "unparseable-input" }, { skipIfNoMission: true });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  const tool_name = parsed.tool_name;
  const tool_input = parsed.tool_input || {};

  if (tool_name !== "Write" && tool_name !== "Edit") {
    audit("assertion-proof-guard", { decision: "allow", tool: tool_name, reason: "wrong-tool" }, { skipIfNoMission: true });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  const filePath = tool_input.file_path || tool_input.path || "";
  if (!filePath.endsWith(BLOCKED_FILENAME)) {
    audit("assertion-proof-guard", { decision: "allow", tool: tool_name, reason: "wrong-file" }, { skipIfNoMission: true });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  const reason = [
    `Blocked direct Write/Edit to ${BLOCKED_FILENAME}.`,
    "",
    "This file is the authoritative mission validation state and may only be",
    "modified by the plugin's record-assertion.mjs / execute-assertion.mjs",
    "scripts (invoked via Bash, not Write/Edit).",
    "",
    "If you need to record an assertion result, run:",
    "  MISSION_EXECUTOR_WRITER=1 node ${CLAUDE_PLUGIN_ROOT}/scripts/execute-assertion.mjs \\",
    "    <mission-path> --id=VAL-XXX-NNN",
    "",
    "Hand-editing is a plugin bug signal -- prior runs had 95 'passed' assertions",
    "written without any command having executed. The hook exists to prevent that.",
  ].join("\n");

  audit("assertion-proof-guard", {
    decision: "deny",
    tool: tool_name,
    filePath,
    reason: "direct-write-to-validation-state",
  });

  process.stdout.write(JSON.stringify(denyPayload(reason)));
}

main().catch((e) => {
  process.stderr.write(`assertion-proof-guard error: ${e.message}\n`);
  audit("assertion-proof-guard", { decision: "allow", reason: `error:${e.message}` }, { skipIfNoMission: true });
  process.stdout.write(JSON.stringify(allowPayload()));
});
