#!/usr/bin/env node
// PostToolUse hook: worker-claim audit log (AUDIT ONLY, never authoritative).
//
// Prior versions of this hook pattern-scraped tool output for "VAL-XXX: PASS"
// strings and wrote them directly to validation-state.json. That let any
// worker flip an assertion to passed just by echoing the right string.
//
// The hook now appends to .omc/validation/worker-claims.jsonl for forensic
// audit. It NEVER writes to validation-state.json. Only execute-assertion.mjs
// (gated by MISSION_EXECUTOR_WRITER=1 and assertion-proof-guard hook) can
// move a status to passed.

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const MISSION_STATE_PATH = ".omc/state/mission-executor-state.json";
const CLAIMS_LOG = ".omc/validation/worker-claims.jsonl";
const VAL_PATTERN = /\b(VAL-[A-Z]+-\d+[a-z]?)\s*[:|]\s*(PASS|passed|pass|FAIL|failed|fail)\b/gi;

function loadMissionState(cwd) {
  const statePath = join(cwd, MISSION_STATE_PATH);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function appendClaim(missionPath, entry) {
  const logPath = join(missionPath, CLAIMS_LOG);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const tool_result = parsed.tool_response ?? parsed.tool_result;
  const tool_name = parsed.tool_name;
  const session_id = parsed.session_id || "unknown";
  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();
  const state = loadMissionState(cwd);

  if (!state || !state.active || !state.missionPath) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const output = typeof tool_result === "string" ? tool_result : JSON.stringify(tool_result ?? "");
  const claims = [];

  for (const match of output.matchAll(VAL_PATTERN)) {
    const assertionId = match[1].toUpperCase();
    const claim = /pass/i.test(match[2]) ? "pass" : "fail";
    const rawStart = Math.max(0, match.index - 40);
    const rawEnd = Math.min(output.length, match.index + match[0].length + 40);
    claims.push({
      assertionId,
      claim,
      sessionId: session_id,
      timestamp: new Date().toISOString(),
      toolName: tool_name,
      rawExcerpt: output.slice(rawStart, rawEnd),
    });
  }

  if (claims.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  for (const claim of claims) appendClaim(state.missionPath, claim);

  // Audit-only: never flips status. Return advisory message to the agent so
  // they know their claim was logged but is NOT authoritative.
  process.stdout.write(JSON.stringify({
    message: `[worker-claims] Logged ${claims.length} assertion claim(s) to ${CLAIMS_LOG}. These are AUDIT-ONLY. Only execute-assertion.mjs can move status to passed.`,
  }));
}

main().catch((e) => {
  process.stderr.write(`validation-tracker error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({}));
});
