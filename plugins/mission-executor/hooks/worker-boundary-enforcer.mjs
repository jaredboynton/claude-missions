#!/usr/bin/env node
// PreToolUse hook: Enforce mission AGENTS.md boundary rules on all tool calls,
// AND inject mission-active status context when the Stop hook was bypassed.
//
// Two responsibilities (merged from the former autopilot-preloop-guard):
//
//   1. HARD BOUNDARIES: reads NEVER-VIOLATE rules from the active mission's
//      AGENTS.md and blocks tool calls that would violate them (git push,
//      pkill, writes to protected paths, etc.).
//
//   2. SOFT CONTEXT INJECTION: when the mission is active but the tool call
//      isn't mission-progress-adjacent, injects a system-reminder via
//      hookSpecificOutput.additionalContext so the assistant sees the current
//      blocker list even if the Stop hook was bypassed. This is a
//      defense-in-depth against Anthropic issues #22925, #29881, #8615
//      (Stop hook fires inconsistently / doesn't block cleanly).
//
// Stdin: JSON { tool_name, tool_input, session_id }
// Stdout: JSON { decision, hookSpecificOutput, ... }

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadMissionState, checkCompletion } from "./_lib/mission-state.mjs";
import { audit } from "./_lib/audit.mjs";

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

// Rough heuristic: is this tool call making mission progress (running a
// plugin script, committing, reading state) vs unrelated work? Used only to
// decide whether to inject a "mission still active" context reminder; never
// used to block.
function isMissionProgressTool(tool_name, tool_input) {
  if (tool_name !== "Bash") return false;
  const cmd = (tool_input?.command || "").toString();
  return (
    /execute-assertion\.mjs|record-assertion\.mjs|mission-lifecycle\.mjs|mission-query\.mjs|sync-features-state\.mjs|reconcile-external-work\.mjs|validate-mission\.mjs|invalidate-stale-evidence\.mjs|critic-evaluator\.mjs|contract-lint\.mjs|write-handoff\.mjs|milestone-seal\.mjs/.test(
      cmd
    ) || /\bgit\s+(add|commit|status|log|diff|show)\b/.test(cmd)
  );
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

function allowPayload(additionalContext = null) {
  const out = {
    decision: "allow",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
  if (additionalContext) {
    out.hookSpecificOutput.additionalContext = additionalContext;
    // Belt-and-braces: also emit systemMessage which some Claude Code
    // versions render as a system-reminder even when additionalContext
    // doesn't inject (upstream #19643 class of bugs).
    out.systemMessage = additionalContext;
  }
  return out;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try { parsed = JSON.parse(input); } catch {
    audit("worker-boundary-enforcer", { decision: "allow", reason: "unparseable-input" });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  const tool_name = parsed.tool_name;
  const tool_input = parsed.tool_input || {};
  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();
  const { state } = loadMissionState(cwd);

  if (!state || !state.active || !state.missionPath) {
    audit("worker-boundary-enforcer", { decision: "allow", tool: tool_name, reason: "no-active-mission" });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  // RESPONSIBILITY 1: hard boundaries
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
    audit("worker-boundary-enforcer", {
      decision: "deny",
      tool: tool_name,
      missionPath: state.missionPath,
      reason: blockMsg,
    });
    process.stdout.write(JSON.stringify(denyPayload(blockMsg)));
    return;
  }

  // RESPONSIBILITY 2: soft context injection. Only for non-progress tools,
  // to avoid redundantly injecting context during mission-progress commands.
  let additionalContext = null;
  if (!isMissionProgressTool(tool_name, tool_input)) {
    const check = checkCompletion(state.missionPath);
    if (!check.complete) {
      additionalContext = [
        "[autopilot-lock] Mission still active -- Stop hook may have been bypassed (upstream #22925).",
        `Mission: ${state.missionPath}`,
        `Phase: ${state.phase || "unknown"}`,
        `Blocker: ${check.reason}`,
        "",
        "If this tool call is part of mission progress (execute-assertion, commit, etc.), ignore this reminder.",
        "If it isn't, switch to mission-progress work before continuing.",
      ].join("\n");
    }
  }

  audit("worker-boundary-enforcer", {
    decision: "allow",
    tool: tool_name,
    missionPath: state.missionPath,
    injectedContext: additionalContext ? true : false,
  });

  process.stdout.write(JSON.stringify(allowPayload(additionalContext)));
}

main().catch((e) => {
  process.stderr.write(`worker-boundary-enforcer error: ${e.message}\n`);
  audit("worker-boundary-enforcer", { decision: "allow", reason: `error:${e.message}` });
  process.stdout.write(JSON.stringify({ decision: "allow" }));
});
