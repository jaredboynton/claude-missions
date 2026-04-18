#!/usr/bin/env node
// PostToolUse hook: When in validation phase, detect assertion evidence
// in tool outputs and auto-update validation-state.json.
//
// Looks for patterns like "VAL-XXX-NNN: PASS" or "VAL-XXX-NNN: FAIL"
// in tool results and updates the mission's validation-state.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MISSION_STATE_PATH = ".omc/state/mission-executor-state.json";
const VAL_PATTERN = /\bVAL-[A-Z]+-\d+[a-z]?\b/g;
const PASS_PATTERN = /\b(VAL-[A-Z]+-\d+[a-z]?)\s*[:|]\s*(PASS|passed|pass)\b/gi;
const FAIL_PATTERN = /\b(VAL-[A-Z]+-\d+[a-z]?)\s*[:|]\s*(FAIL|failed|fail)\b/gi;

function loadMissionState(cwd) {
  const statePath = join(cwd, MISSION_STATE_PATH);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function updateValidationState(missionPath, updates) {
  const valPath = join(missionPath, "validation-state.json");
  if (!existsSync(valPath)) return;

  try {
    const valState = JSON.parse(readFileSync(valPath, "utf8"));
    let changed = false;

    for (const [id, status] of Object.entries(updates)) {
      if (valState.assertions?.[id]) {
        valState.assertions[id].status = status;
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(valPath, JSON.stringify(valState, null, 2) + "\n");
    }
  } catch {
    // Silently ignore write failures
  }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  const parsed = JSON.parse(input);
  // Claude Code PostToolUse uses `tool_response`; older docs said `tool_result`.
  // Accept either for forward/backward compatibility.
  const tool_result = parsed.tool_response ?? parsed.tool_result;
  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();
  const state = loadMissionState(cwd);

  if (!state || !state.active || !state.missionPath || state.phase !== "verify") {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const output = typeof tool_result === "string" ? tool_result : JSON.stringify(tool_result);
  const updates = {};

  for (const match of output.matchAll(PASS_PATTERN)) {
    updates[match[1].toUpperCase()] = "passed";
  }

  for (const match of output.matchAll(FAIL_PATTERN)) {
    updates[match[1].toUpperCase()] = "failed";
  }

  if (Object.keys(updates).length > 0) {
    updateValidationState(state.missionPath, updates);
    process.stdout.write(JSON.stringify({
      message: `[Validation Tracker] Updated ${Object.keys(updates).length} assertion(s): ${Object.entries(updates).map(([id, s]) => `${id}=${s}`).join(", ")}`
    }));
  } else {
    process.stdout.write(JSON.stringify({}));
  }
}

main().catch((e) => {
  process.stderr.write(`validation-tracker error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({}));
});
