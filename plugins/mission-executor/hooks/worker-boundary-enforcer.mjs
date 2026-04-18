#!/usr/bin/env node
// PreToolUse hook: Enforce mission AGENTS.md boundary rules on all tool calls.
// Reads NEVER-VIOLATE rules from the active mission's AGENTS.md and blocks
// tool calls that would violate them.
//
// Stdin: JSON { tool_name, tool_input, session_id }
// Stdout: JSON { decision: "allow"|"block", message?: string }

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

function loadBoundaries(missionPath) {
  const agentsPath = join(missionPath, "AGENTS.md");
  if (!existsSync(agentsPath)) return { neverRules: [], protectedPaths: [] };

  const content = readFileSync(agentsPath, "utf8");
  const neverRules = [];
  const protectedPaths = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (/never.*git push/i.test(trimmed)) neverRules.push("git_push");
    if (/never.*pkill/i.test(trimmed)) neverRules.push("pkill");
    if (/never.*delete.*fixture/i.test(trimmed)) neverRules.push("delete_fixture");
    if (/off-limits|do not (touch|edit|modify|delete)/i.test(trimmed)) {
      const pathMatch = trimmed.match(/[`"]([^`"]+)[`"]/);
      if (pathMatch) protectedPaths.push(pathMatch[1]);
    }
  }

  return { neverRules, protectedPaths };
}

function checkBashCommand(command, boundaries) {
  if (!command) return null;
  const cmd = typeof command === "string" ? command : "";

  if (boundaries.neverRules.includes("git_push") && /\bgit\s+push\b/.test(cmd)) {
    return "BLOCKED: git push is forbidden by mission boundaries.";
  }

  if (boundaries.neverRules.includes("pkill") && /\bpkill\b/.test(cmd)) {
    return "BLOCKED: pkill is forbidden by mission boundaries. Use targeted kill by PID if needed.";
  }

  for (const p of boundaries.protectedPaths) {
    if (cmd.includes(p) && /(rm|mv|>|truncate|dd)/.test(cmd)) {
      return `BLOCKED: ${p} is a protected path. Do not modify or delete it.`;
    }
  }

  return null;
}

function checkFileEdit(filePath, boundaries) {
  if (!filePath) return null;
  for (const p of boundaries.protectedPaths) {
    if (filePath.includes(p)) {
      return `BLOCKED: ${filePath} is protected by mission boundaries.`;
    }
  }
  return null;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  const { tool_name, tool_input } = JSON.parse(input);
  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();
  const state = loadMissionState(cwd);

  if (!state || !state.active || !state.missionPath) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  const boundaries = loadBoundaries(state.missionPath);

  let blockMsg = null;

  if (tool_name === "Bash") {
    const cmd = tool_input?.command || "";
    blockMsg = checkBashCommand(cmd, boundaries);
  }

  if (tool_name === "Edit" || tool_name === "Write") {
    const fp = tool_input?.file_path || "";
    blockMsg = checkFileEdit(fp, boundaries);
  }

  if (blockMsg) {
    process.stdout.write(JSON.stringify({ decision: "block", message: blockMsg }));
  } else {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
  }
}

main().catch((e) => {
  process.stderr.write(`worker-boundary-enforcer error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({ decision: "allow" }));
});
