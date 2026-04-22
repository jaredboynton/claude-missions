// Shared mission-state + completion-check helpers used by every hook.
//
// Previously, autopilot-lock.mjs reimplemented checkCompletion inline. That
// worked but meant completion logic drift whenever a hook needed to know
// "is the mission currently blocking on X?". This module is the single
// source of truth.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const STATE_REL = ".omc/state/mission-executor-state.json";
const ABORT_REL = ".omc/state/mission-executor-abort";

export function walkUpForState(start) {
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

export function walkUpForAbort(start) {
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

export function loadMissionState(cwd) {
  const statePath = walkUpForState(cwd);
  if (!statePath) return { state: null, statePath: null };
  try {
    return { state: JSON.parse(readFileSync(statePath, "utf8")), statePath };
  } catch {
    return { state: null, statePath };
  }
}

// Evaluate mission completion criteria. Returns { complete: bool, reason?: string,
// detail?: { counts, failedIds, staleIds, proofLessIds, pendingFeatures } }.
export function checkCompletion(missionPath) {
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

// Suggest the next concrete command the orchestrator should run, given current
// mission state. Used in PreToolUse/deny reasons so the block message actually
// tells Claude what to do.
export function suggestNextAction(missionPath, pluginRoot) {
  const check = checkCompletion(missionPath);
  if (check.complete) {
    return [
      `node ${pluginRoot}/scripts/mission-lifecycle.mjs complete`,
      "# (all gates clear; mark mission complete)",
    ].join("\n");
  }
  const d = check.detail || {};
  // Priority: failed assertions -> stale -> pending -> proofless -> features -> state.json
  if ((d.failedIds || []).length > 0) {
    return [
      `# ${d.failedIds.length} failed assertion(s). Fix the underlying code, commit, then re-run:`,
      ...d.failedIds.slice(0, 3).map(
        (id) => `MISSION_EXECUTOR_WRITER=1 node ${pluginRoot}/scripts/execute-assertion.mjs <mission> --id=${id}`
      ),
    ].join("\n");
  }
  if ((d.staleIds || []).length > 0) {
    return [
      `# ${d.staleIds.length} stale proof(s). Re-run:`,
      `node ${pluginRoot}/scripts/invalidate-stale-evidence.mjs <mission>`,
      ...d.staleIds.slice(0, 3).map(
        (id) => `MISSION_EXECUTOR_WRITER=1 node ${pluginRoot}/scripts/execute-assertion.mjs <mission> --id=${id}`
      ),
    ].join("\n");
  }
  const counts = d.counts || {};
  if (counts.pending > 0) {
    return [
      `# ${counts.pending} pending assertion(s). Execute the next one:`,
      `# (use mission-query.mjs to list all pending ids)`,
      `node ${pluginRoot}/scripts/mission-query.mjs <mission> assertions | jq -r '.pendingIds[0]'`,
      `MISSION_EXECUTOR_WRITER=1 node ${pluginRoot}/scripts/execute-assertion.mjs <mission> --id=<id>`,
    ].join("\n");
  }
  if ((d.proofLessIds || []).length > 0) {
    return [
      `# ${d.proofLessIds.length} passed-without-proof assertion(s). Invalidate + re-execute:`,
      `node ${pluginRoot}/scripts/invalidate-stale-evidence.mjs <mission>`,
      ...d.proofLessIds.slice(0, 3).map(
        (id) => `MISSION_EXECUTOR_WRITER=1 node ${pluginRoot}/scripts/execute-assertion.mjs <mission> --id=${id}`
      ),
    ].join("\n");
  }
  if ((d.pendingFeatures || []).length > 0) {
    return [
      `# ${d.pendingFeatures.length} feature(s) not marked completed. Reconcile from commits/proofs:`,
      `node ${pluginRoot}/scripts/reconcile-external-work.mjs <mission> --apply`,
    ].join("\n");
  }
  return [
    `# state.json is not 'completed'. Run completion gate:`,
    `node ${pluginRoot}/scripts/mission-lifecycle.mjs complete`,
  ].join("\n");
}
