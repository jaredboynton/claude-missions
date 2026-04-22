#!/usr/bin/env node
// PreToolUse hook: enforce mission AGENTS.md boundaries AND inject mission-
// active context when Stop was bypassed. Also touches the driver heartbeat
// file so /detach can tell whether this session is actively driving.
//
// v0.5.0: gated on session_id membership in state.attachedSessions[].

import { readFileSync, existsSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadAttachedMissionState, checkCompletion, migrateLegacyAttach } from "./_lib/mission-state.mjs";
import { audit } from "./_lib/audit.mjs";
import { heartbeatFile, stateBase } from "./_lib/paths.mjs";

function touchHeartbeat(sessionId) {
  if (!sessionId) return;
  try {
    mkdirSync(stateBase(), { recursive: true });
    const p = heartbeatFile(sessionId);
    if (existsSync(p)) {
      const now = new Date();
      utimesSync(p, now, now);
    } else {
      writeFileSync(p, new Date().toISOString());
    }
  } catch {}
}

function loadBoundaries(missionPath) {
  const agentsPath = join(missionPath, "AGENTS.md");
  if (!existsSync(agentsPath)) return { neverRules: [], protectedPaths: [] };
  const content = readFileSync(agentsPath, "utf8");
  const neverRules = []; const protectedPaths = [];
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
    if (filePath.includes(p)) return `BLOCKED: ${filePath} is protected by mission boundaries.`;
  }
  return null;
}

function isMissionProgressTool(tool_name, tool_input) {
  if (tool_name !== "Bash") return false;
  const cmd = (tool_input?.command || "").toString();
  return (
    /execute-assertion\.mjs|record-assertion\.mjs|mission-cli\.mjs|mission-lifecycle\.mjs|mission-query\.mjs|sync-features-state\.mjs|reconcile-external-work\.mjs|validate-mission\.mjs|invalidate-stale-evidence\.mjs|critic-evaluator\.mjs|contract-lint\.mjs|write-handoff\.mjs|milestone-seal\.mjs/.test(cmd)
    || /\bgit\s+(add|commit|status|log|diff|show)\b/.test(cmd)
  );
}

function denyPayload(reason) {
  return {
    decision: "block", message: reason,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  };
}

function allowPayload(additionalContext = null) {
  const out = {
    decision: "allow",
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  };
  if (additionalContext) {
    out.hookSpecificOutput.additionalContext = additionalContext;
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
  const sessionId = parsed.session_id;
  const cwd = parsed.cwd || process.env.CLAUDE_WORKING_DIR || process.cwd();
  const { state, reason } = loadAttachedMissionState({ sessionId, cwd });

  if (!state || !state.active || !state.missionPath) {
    audit("worker-boundary-enforcer", { decision: "allow", tool: tool_name, reason: reason || "no-active-mission", session_id: sessionId });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  if (reason === "legacy-auto-attach-pending") {
    try { await migrateLegacyAttach({ sessionId, cwd }); } catch {}
  }

  // Driver heartbeat (v0.5.0 §4.3). Touches on PreToolUse AND PostToolUse.
  touchHeartbeat(sessionId);

  const boundaries = loadBoundaries(state.missionPath);
  let blockMsg = null;
  if (tool_name === "Bash") {
    blockMsg = checkBashCommand(tool_input?.command || "", boundaries);
  }
  if (tool_name === "Edit" || tool_name === "Write") {
    blockMsg = checkFileEdit(tool_input?.file_path || "", boundaries);
  }
  if (blockMsg) {
    audit("worker-boundary-enforcer", { decision: "deny", tool: tool_name, missionPath: state.missionPath, reason: blockMsg, session_id: sessionId });
    process.stdout.write(JSON.stringify(denyPayload(blockMsg)));
    return;
  }

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
    decision: "allow", tool: tool_name, missionPath: state.missionPath,
    injectedContext: !!additionalContext, session_id: sessionId,
  });
  process.stdout.write(JSON.stringify(allowPayload(additionalContext)));
}

main().catch((e) => {
  process.stderr.write(`worker-boundary-enforcer error: ${e.message}\n`);
  audit("worker-boundary-enforcer", { decision: "allow", reason: `error:${e.message}` });
  process.stdout.write(JSON.stringify({ decision: "allow" }));
});
