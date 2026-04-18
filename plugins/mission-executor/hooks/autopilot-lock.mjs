#!/usr/bin/env node
// Stop hook: lock the assistant into mission completion.
//
// When /mission-executor:mission-execute is running, mission-lifecycle.mjs
// writes .omc/state/mission-executor-state.json with active: true. This
// Stop hook reads that state and BLOCKS the assistant from ending its
// turn until every completion criterion is met:
//
//   1. validation-state.json: all assertions have status=passed AND a
//      proof block with commitSha.
//   2. features.json: every feature has status=completed.
//   3. state.json: mission state == "completed".
//
// If any criterion is unmet, the hook returns { decision: "block", reason }
// with a precise description of what's still missing. Claude will continue
// with that context instead of ending the turn.
//
// Escape hatch: if the user creates .omc/state/mission-executor-abort,
// the lock releases and allows stop. This lets a human abort a stuck
// pipeline without killing the session.

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

const STATE_REL = ".omc/state/mission-executor-state.json";
const ABORT_REL = ".omc/state/mission-executor-abort";

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

function walkUpForAbort(start) {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    const p = join(cur, ABORT_REL);
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function checkCompletion(missionPath) {
  try {
    const vsPath = join(missionPath, "validation-state.json");
    const fsPath = join(missionPath, "features.json");
    const stPath = join(missionPath, "state.json");

    if (!existsSync(vsPath)) return { complete: false, reason: "validation-state.json missing" };
    if (!existsSync(fsPath)) return { complete: false, reason: "features.json missing" };
    if (!existsSync(stPath)) return { complete: false, reason: "state.json missing" };

    const vs = JSON.parse(readFileSync(vsPath, "utf8"));
    const fs = JSON.parse(readFileSync(fsPath, "utf8"));
    const st = JSON.parse(readFileSync(stPath, "utf8"));

    const assertions = vs.assertions || {};
    const counts = { total: 0, passed: 0, failed: 0, stale: 0, pending: 0, proofLess: 0 };
    const failedIds = [];
    const staleIds = [];
    const proofLessIds = [];
    for (const [id, a] of Object.entries(assertions)) {
      counts.total++;
      const status = a.status || "pending";
      if (status === "passed") {
        if (!a.proof || !a.proof.commitSha) {
          counts.proofLess++;
          proofLessIds.push(id);
        } else {
          counts.passed++;
        }
      } else if (status === "failed") { counts.failed++; failedIds.push(id); }
      else if (status === "stale") { counts.stale++; staleIds.push(id); }
      else counts.pending++;
    }

    const features = fs.features || [];
    const pendingFeatures = features.filter((f) => f.status !== "completed");

    const reasons = [];
    if (counts.failed > 0) reasons.push(`${counts.failed} failed assertion(s): ${failedIds.slice(0, 3).join(", ")}${failedIds.length > 3 ? "..." : ""}`);
    if (counts.stale > 0) reasons.push(`${counts.stale} stale assertion(s) need re-run: ${staleIds.slice(0, 3).join(", ")}${staleIds.length > 3 ? "..." : ""}`);
    if (counts.pending > 0) reasons.push(`${counts.pending} pending assertion(s)`);
    if (counts.proofLess > 0) reasons.push(`${counts.proofLess} passed-without-proof assertion(s): ${proofLessIds.slice(0, 3).join(", ")}${proofLessIds.length > 3 ? "..." : ""}`);
    if (pendingFeatures.length > 0) reasons.push(`${pendingFeatures.length} feature(s) not completed: ${pendingFeatures.slice(0, 3).map((f) => f.id).join(", ")}${pendingFeatures.length > 3 ? "..." : ""}`);
    if (st.state !== "completed") reasons.push(`mission state.json is '${st.state}', not 'completed'`);

    if (reasons.length === 0) return { complete: true };
    return {
      complete: false,
      reason: reasons.join("; "),
      detail: { counts, failedIds, staleIds, proofLessIds, pendingFeatures: pendingFeatures.map((f) => f.id) },
    };
  } catch (e) {
    return { complete: false, reason: `completion check failed: ${e.message}` };
  }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try { parsed = JSON.parse(input); } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const cwd = process.env.CLAUDE_WORKING_DIR || process.cwd();
  const statePath = walkUpForState(cwd);
  if (!statePath) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  let state;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); }
  catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  if (!state.active || !state.missionPath) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  // Abort escape hatch
  const abortPath = walkUpForAbort(cwd);
  if (abortPath) {
    try { unlinkSync(abortPath); } catch {}
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const check = checkCompletion(state.missionPath);
  if (check.complete) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const reason = [
    "[autopilot-lock] Mission not complete. Continue executing the /mission-executor:mission-execute pipeline without stopping or asking the user.",
    "",
    `Mission: ${state.missionPath}`,
    `Phase: ${state.phase || "unknown"}`,
    `Blocker: ${check.reason}`,
    "",
    "Required next action depends on what's incomplete:",
    "  - failed/stale assertions  -> spawn fix workers to correct code, commit, re-run execute-assertion.mjs for those ids",
    "  - pending assertions       -> run execute-assertion.mjs on each",
    "  - passed-without-proof     -> run invalidate-stale-evidence.mjs, then execute-assertion.mjs",
    "  - features not completed   -> run sync-features-state.mjs or mark via reconcile-external-work.mjs --apply",
    "  - state.json != completed  -> Phase 7: set state=completed, append progress_log, re-run validate-mission.mjs as exit gate",
    "",
    "Do NOT use AskUserQuestion (blocked by no-ask-during-mission hook).",
    "Do NOT write a summary and stop -- keep executing until all criteria are met.",
    "",
    "Manual abort: user may create .omc/state/mission-executor-abort to release the lock.",
  ].join("\n");

  process.stdout.write(JSON.stringify({
    decision: "block",
    reason,
  }));
}

main().catch((e) => {
  process.stderr.write(`autopilot-lock error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({}));
});
