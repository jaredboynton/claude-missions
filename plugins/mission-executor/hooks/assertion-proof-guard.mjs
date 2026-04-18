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
//   - Claude Code currently does NOT propagate env vars set by a script into the
//     Write/Edit tool invocations the orchestrator makes. So the safe path:
//     the orchestrator should invoke record-assertion.mjs AS A SHELL COMMAND
//     (MISSION_EXECUTOR_WRITER=1 node record-assertion.mjs ...), not hand-edit
//     validation-state.json via Write/Edit.
//
// This hook enforces that discipline: Write/Edit to validation-state.json
// are blocked unconditionally. The only way to change validation-state.json
// is via Bash running record-assertion.mjs with the env var set.

import { readFileSync } from "node:fs";

const BLOCKED_FILENAME = "validation-state.json";

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    // Malformed input: do not block (default-allow on parse failure).
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  const tool_name = parsed.tool_name;
  const tool_input = parsed.tool_input || {};

  if (tool_name !== "Write" && tool_name !== "Edit") {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  const filePath = tool_input.file_path || tool_input.path || "";
  if (!filePath.endsWith(BLOCKED_FILENAME)) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  // Block. The validation-state.json file is off-limits to Write/Edit.
  process.stdout.write(JSON.stringify({
    decision: "block",
    message: [
      `Blocked direct Write/Edit to ${BLOCKED_FILENAME}.`,
      "This file is the authoritative mission validation state and may only be",
      "modified by the plugin's record-assertion.mjs / execute-assertion.mjs scripts.",
      "",
      "If you need to record an assertion result, run:",
      "  MISSION_EXECUTOR_WRITER=1 node ${CLAUDE_PLUGIN_ROOT}/scripts/execute-assertion.mjs \\",
      "    <mission-path> --id=VAL-XXX-NNN",
      "",
      "Hand-editing is a plugin bug signal -- the last run had 95 'passed' assertions",
      "written without any command having executed. The hook exists to prevent that.",
    ].join("\n"),
  }));
}

main().catch((e) => {
  process.stderr.write(`assertion-proof-guard error: ${e.message}\n`);
  // Default-allow on error so a buggy hook never blocks the user entirely.
  process.stdout.write(JSON.stringify({ decision: "allow" }));
});
