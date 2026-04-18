#!/usr/bin/env node
// PostToolUse hook for Edit/Write: After modifying source files, inject a
// reminder to run the project's build command before committing.
//
// Reads the build command from the mission state (extracted from AGENTS.md
// during INGEST phase).

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

  if (!state || !state.active) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  if (tool_name !== "Edit" && tool_name !== "Write") {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const filePath = tool_input?.file_path || "";
  const srcPatterns = state.srcPatterns || ["src/"];
  const isSrcFile = srcPatterns.some((p) => filePath.includes(p));

  if (isSrcFile && state.buildCommand) {
    process.stdout.write(JSON.stringify({
      message: `[Build Discipline] Source file modified: ${filePath}. Run \`${state.buildCommand}\` before committing.`
    }));
  } else {
    process.stdout.write(JSON.stringify({}));
  }
}

main().catch((e) => {
  process.stderr.write(`build-discipline error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({}));
});
