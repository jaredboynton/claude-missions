#!/usr/bin/env node
// PostToolUse hook: worker-claim audit log (AUDIT ONLY).
//
// v0.5.0: gated on session_id membership in state.attachedSessions[]. Also
// touches the driver heartbeat file so /detach can detect active drivers
// (spec §4.3 calls for heartbeat touches in both PreToolUse and PostToolUse).

import { appendFileSync, mkdirSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import { loadAttachedMissionState, migrateLegacyAttach } from "./_lib/mission-state.mjs";
import { claimsLogFile, heartbeatFile, stateBase } from "./_lib/paths.mjs";
import { audit } from "./_lib/audit.mjs";

const VAL_PATTERN = /\b(VAL-[A-Z]+-\d+[a-z]?)\s*[:|]\s*(PASS|passed|pass|FAIL|failed|fail)\b/gi;

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

function appendClaim(entry) {
  try {
    const logPath = claimsLogFile();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {}
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try { parsed = JSON.parse(input); } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const tool_result = parsed.tool_response ?? parsed.tool_result;
  const tool_name = parsed.tool_name;
  const sessionId = parsed.session_id;
  const cwd = parsed.cwd || process.env.CLAUDE_WORKING_DIR || process.cwd();
  const { state, reason } = loadAttachedMissionState({ sessionId, cwd });

  if (!state || !state.active || !state.missionPath) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  if (reason === "legacy-auto-attach-pending") {
    try { await migrateLegacyAttach({ sessionId, cwd }); } catch {}
  }

  touchHeartbeat(sessionId);

  const output = typeof tool_result === "string" ? tool_result : JSON.stringify(tool_result ?? "");
  const claims = [];

  for (const match of output.matchAll(VAL_PATTERN)) {
    const assertionId = match[1].toUpperCase();
    const claim = /pass/i.test(match[2]) ? "pass" : "fail";
    const rawStart = Math.max(0, match.index - 40);
    const rawEnd = Math.min(output.length, match.index + match[0].length + 40);
    claims.push({
      assertionId, claim,
      sessionId: sessionId || "unknown",
      timestamp: new Date().toISOString(),
      toolName: tool_name,
      rawExcerpt: output.slice(rawStart, rawEnd),
    });
  }

  if (claims.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  for (const claim of claims) appendClaim(claim);

  audit("validation-tracker", { decision: "logged", count: claims.length, session_id: sessionId });

  process.stdout.write(JSON.stringify({
    message: `[worker-claims] Logged ${claims.length} assertion claim(s). These are AUDIT-ONLY. Only execute-assertion.mjs can move status to passed.`,
  }));
}

main().catch((e) => {
  process.stderr.write(`validation-tracker error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({}));
});
