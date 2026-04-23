// Hook-side mission-state loader and completion-gate helpers.
//
// v0.5.0 rewrite:
//   - loadMissionState (walk-up, cwd-based) -> DELETED.
//     loadMissionStateFromCwd (rename, no walk-up) kept for scripts only.
//   - loadAttachedMissionState({ sessionId, cwd }) -> NEW primary API for hooks.
//     Gates enforcement on membership in state.attachedSessions[].
//   - Legacy-migration fallback for pre-0.5.0 state files (critic C2/N3):
//     emits reason: "legacy-auto-attach-pending" so hooks fire AND trigger
//     one-shot migration under stateLockFile().
//   - walkUpForState / walkUpForAbort -> DELETED.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  stateFile, stateLockFile, abortFile, registryFile,
} from "./paths.mjs";
import { findMissionForSession } from "./registry.mjs";

// ---- Completion criteria (unchanged from 0.4.x except path imports) ----

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
    const failedIds = []; const staleIds = []; const proofLessIds = [];
    for (const [id, a] of Object.entries(assertions)) {
      counts.total++;
      const status = a.status || "pending";
      if (status === "passed") {
        // v0.6.0: valid proof shape is toolType + command + paths (no commitSha).
        if (!a.proof || !a.proof.toolType || !a.proof.command) { counts.proofLess++; proofLessIds.push(id); }
        else counts.passed++;
      } else if (status === "failed") { counts.failed++; failedIds.push(id); }
      else if (status === "stale") { counts.stale++; staleIds.push(id); }
      else counts.pending++;
    }

    const features = fs.features || [];
    const pendingFeatures = features.filter((f) => f.status !== "completed");

    const reasons = [];
    if (counts.failed > 0) reasons.push(`${counts.failed} failed assertion(s): ${failedIds.slice(0,3).join(", ")}${failedIds.length>3?"...":""}`);
    if (counts.stale > 0) reasons.push(`${counts.stale} stale assertion(s) need re-run: ${staleIds.slice(0,3).join(", ")}${staleIds.length>3?"...":""}`);
    if (counts.pending > 0) reasons.push(`${counts.pending} pending assertion(s)`);
    if (counts.proofLess > 0) reasons.push(`${counts.proofLess} passed-without-proof assertion(s): ${proofLessIds.slice(0,3).join(", ")}${proofLessIds.length>3?"...":""}`);
    if (pendingFeatures.length > 0) reasons.push(`${pendingFeatures.length} feature(s) not completed: ${pendingFeatures.slice(0,3).map((f)=>f.id).join(", ")}${pendingFeatures.length>3?"...":""}`);
    if (st.state !== "completed") reasons.push(`mission state.json is '${st.state}', not 'completed'`);

    if (reasons.length === 0) return { complete: true };
    return {
      complete: false,
      reason: reasons.join("; "),
      detail: { counts, failedIds, staleIds, proofLessIds, pendingFeatures: pendingFeatures.map((f)=>f.id) },
    };
  } catch (e) {
    return { complete: false, reason: `completion check failed: ${e.message}` };
  }
}

// ---- Next-action suggestion (v0.5.0: points at mission-cli.mjs) ----

export function suggestNextAction(missionPath, pluginRoot) {
  const check = checkCompletion(missionPath);
  if (check.complete) {
    return [
      `node ${pluginRoot}/scripts/mission-cli.mjs complete --session-id=<sid>`,
      "# (all gates clear; mark mission complete)",
    ].join("\n");
  }
  const d = check.detail || {};
  if ((d.failedIds || []).length > 0) {
    return [
      `# ${d.failedIds.length} failed assertion(s). Fix code, commit, then re-run:`,
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
      `# ${counts.pending} pending assertion(s). Execute next:`,
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
      `# ${d.pendingFeatures.length} feature(s) not marked completed. Reconcile:`,
      `node ${pluginRoot}/scripts/reconcile-external-work.mjs <mission> --apply`,
    ].join("\n");
  }
  return [
    `# state.json is not 'completed'. Run completion gate:`,
    `node ${pluginRoot}/scripts/mission-cli.mjs complete --session-id=<sid>`,
  ].join("\n");
}

// ---- Abort flag: scoped to the current project's stateBase (no walk-up) ----

export function readAbortFlag() {
  const p = abortFile();
  if (!existsSync(p)) return null;
  return p;
}

export function clearAbortFlag() {
  const p = abortFile();
  try { unlinkSync(p); } catch {}
}

// ---- Primary v0.5.0 loader for hooks ----

// Returns one of:
//   { state, statePath }                                         -> session attached, enforce normally
//   { state: null, statePath: null, reason: "no-session-id" }    -> hook must no-op
//   { state: null, statePath: null, reason: "not-attached" }     -> hook must no-op (invisible)
//   { state: null, statePath, reason: "inactive" }               -> mission not active
//   { state, statePath, reason: "legacy-auto-attach-pending" }   -> enforce AND migrate
//
// Resolution order:
//   1. Registry lookup (cross-project; fast path for a session that ran /execute)
//   2. Project-local state file where sessionId is already in attachedSessions[]
//   3. Project-local state file is active AND mission is NOT in the registry:
//      treat as legacy-auto-attach-pending regardless of whether attachedSessions
//      is empty. The registry entry is the "formally registered" signal; absent
//      it, ANY session arriving should auto-attach via migrateLegacyAttach().
//      This is the v5 fix for the concurrent-migration race where Hook A
//      migrates to [A] before Hook B reads state, leaving B unable to attach.
export function loadAttachedMissionState({ sessionId, cwd } = {}) {
  if (!sessionId) return { state: null, statePath: null, reason: "no-session-id" };

  // 1. Registry lookup
  const found = findMissionForSession(sessionId);
  if (found) {
    const s = found.state;
    if (!s.active) return { state: null, statePath: found.entry.statePath, reason: "inactive" };
    return { state: s, statePath: found.entry.statePath };
  }

  // 2. & 3. Project-local state file
  try {
    const localPath = stateFile();
    if (existsSync(localPath)) {
      const s = JSON.parse(readFileSync(localPath, "utf8"));
      if (s.active) {
        if (s.attachedSessions?.some((x) => x.sessionId === sessionId)) {
          return { state: s, statePath: localPath };
        }
        // Mission active but this session isn't in it. If the mission is also
        // NOT registered in the global registry, this is a legacy-migration
        // candidate — auto-attach this session via migrateLegacyAttach.
        const registered = isRegistered(s.missionId, s.missionPath);
        if (!registered) {
          return { state: s, statePath: localPath, reason: "legacy-auto-attach-pending" };
        }
      }
    }
  } catch {}

  return { state: null, statePath: null, reason: "not-attached" };
}

function isRegistered(missionId, missionPath) {
  try {
    const p = registryFile();
    if (!existsSync(p)) return false;
    const doc = JSON.parse(readFileSync(p, "utf8"));
    if (!doc?.missions) return false;
    if (missionId && doc.missions[missionId]) return true;
    if (!missionPath) return false;
    for (const entry of Object.values(doc.missions)) {
      if (!entry?.statePath) continue;
      try {
        const ms = JSON.parse(readFileSync(entry.statePath, "utf8"));
        if (ms.missionPath === missionPath) return true;
      } catch {}
    }
  } catch {}
  return false;
}

// ---- One-shot legacy migration, append-if-absent under stateLockFile ----
//
// Called by any hook that sees reason: "legacy-auto-attach-pending". Acquires
// the state-file lock with a short deadline (if another hook is already mid-
// migration, we just skip — they'll finish and the next call for this session
// will hit the primary path). Append-if-absent semantics mean concurrent
// migrations with distinct session-ids all land in attachedSessions[].
//
// v0.5.1: on successful migration, emits a `legacy_migration_completed` event
// to the mission's progress log. This is the ONE place hooks (transitively)
// write to progress_log — isolated to the migration writer; all other hooks
// stay on hook-audit.log.
//
// Returns: { migrated: bool, skipped: bool, reason? }
export async function migrateLegacyAttach({ sessionId, cwd } = {}) {
  if (!sessionId) return { migrated: false, skipped: true, reason: "no-session-id" };
  const { withLock } = await import("../../scripts/_lib/lockfile.mjs");
  const p = stateFile();
  let migratedMissionPath = null;
  try {
    const outcome = await withLock(stateLockFile(), () => {
      if (!existsSync(p)) return { migrated: false, skipped: true, reason: "no-state" };
      const s = JSON.parse(readFileSync(p, "utf8"));
      s.attachedSessions = s.attachedSessions || [];
      if (s.attachedSessions.some((x) => x.sessionId === sessionId)) {
        return { migrated: false, skipped: true, reason: "already-attached" };
      }
      s.attachedSessions.push({
        sessionId,
        attachedAt: new Date().toISOString(),
        cwd: cwd || process.cwd(),
        role: "driver",
        migratedFromLegacy: true,
      });
      s.updatedAt = new Date().toISOString();
      const tmp = p + ".tmp";
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
      renameSync(tmp, p);
      migratedMissionPath = s.missionPath || null;
      return { migrated: true, skipped: false };
    }, { deadlineMs: 1000 });

    // Emit after lock released (progress_log has its own append-atomic semantics).
    if (outcome.migrated && migratedMissionPath) {
      try {
        const { appendEvent } = await import("../../scripts/_lib/progress-log.mjs");
        appendEvent(migratedMissionPath, {
          type: "legacy_migration_completed",
          sessionId,
          cwd: cwd || process.cwd(),
        });
      } catch {
        // Progress-log write is best-effort; never fail the migration.
      }
    }
    return outcome;
  } catch (e) {
    if (e.code === "LOCK_TIMEOUT") return { migrated: false, skipped: true, reason: "lock-timeout" };
    return { migrated: false, skipped: true, reason: `error:${e.message}` };
  }
}

// ---- Script-side back-compat loader (no walk-up; reads project-local state) ----

export function loadMissionStateFromCwd() {
  const p = stateFile();
  if (!existsSync(p)) return { state: null, statePath: null };
  try { return { state: JSON.parse(readFileSync(p, "utf8")), statePath: p }; }
  catch { return { state: null, statePath: p }; }
}
