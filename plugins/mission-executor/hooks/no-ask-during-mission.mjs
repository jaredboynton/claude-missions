#!/usr/bin/env node
// PreToolUse hook: block AskUserQuestion while a mission is active.
//
// /mission-executor:mission-execute is autopilot. The assistant must
// make decisions and continue; it cannot pause to ask the user. If the
// assistant believes a question is needed, it should either:
//
//   1. Pick the most reasonable default and proceed, OR
//   2. Log the question to worker-claims.jsonl and pick a default
//
// The autopilot-lock Stop hook ensures the run doesn't end until the
// mission is complete, so a wrong choice can still be corrected in the
// FIX loop without human intervention.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const STATE_REL = ".omc/state/mission-executor-state.json";

function walkUpForState(start) {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    const p = join(cur, STATE_REL);
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try { parsed = JSON.parse(input); } catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  if (parsed.tool_name !== "AskUserQuestion") {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();
  const statePath = walkUpForState(cwd);
  if (!statePath) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  let state;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); }
  catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  if (!state.active) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    return;
  }

  process.stdout.write(JSON.stringify({
    decision: "block",
    message: [
      "[autopilot-lock] AskUserQuestion is blocked while /mission-executor:mission-execute is active.",
      "Autopilot does not pause for user input. Pick the most defensible default based on:",
      "  - the mission's AGENTS.md boundaries",
      "  - the feature/assertion spec in features.json / validation-contract.md",
      "  - existing kep code patterns",
      "and continue. If the decision is wrong, the FIX loop will catch it.",
      "",
      `Active mission: ${state.missionPath}`,
      `Phase: ${state.phase || "unknown"}`,
      "",
      "Escape hatch: the user may create .omc/state/mission-executor-abort to break the lock.",
    ].join("\n"),
  }));
}

main().catch(() => process.stdout.write(JSON.stringify({ decision: "allow" })));
