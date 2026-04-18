#!/usr/bin/env node
// PreToolUse hook for Bash: Detect git add/commit commands that might stage
// pre-existing uncommitted files. Injects a warning reminder.
//
// This hook does NOT block -- it injects context reminding the agent to check
// scope before committing. Actual blocking would require PostToolUse analysis
// of the git status diff.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MISSION_STATE_PATH = ".omc/state/mission-executor-state.json";

function loadMissionState(cwd) {
  const statePath = join(cwd, MISSION_STATE_PATH);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  const { tool_name, tool_input } = JSON.parse(input);
  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();
  const state = loadMissionState(cwd);

  if (!state || !state.active || tool_name !== "Bash") {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  const cmd = tool_input?.command || "";
  const isGitStaging = /\bgit\s+(add|commit|stage)\b/.test(cmd);

  if (isGitStaging && state.protectedPaths?.length > 0) {
    const protectedList = state.protectedPaths.join(", ");
    process.stdout.write(JSON.stringify({
      decision: "allow",
      message: `[Mission Commit Guard] Protected uncommitted paths: ${protectedList}. Verify git status --porcelain before and after staging. Only stage files YOU created or edited. If any protected path flipped from ' M' to 'M ', run git restore --staged <path> immediately.`
    }));
  } else {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
  }
}

main().catch((e) => {
  process.stderr.write(`commit-scope-guard error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({ decision: "allow" }));
});
