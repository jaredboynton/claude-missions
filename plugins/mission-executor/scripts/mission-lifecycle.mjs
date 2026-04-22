#!/usr/bin/env node
// Mission lifecycle state manager. Writes / clears the marker that
// autopilot-lock.mjs reads to enforce non-stopping execution.
//
// Usage:
//   node mission-lifecycle.mjs start <mission-path>          # Phase 0 entry
//   node mission-lifecycle.mjs phase <phase-name>            # Phase transition
//   node mission-lifecycle.mjs complete                      # Phase 7 exit
//   node mission-lifecycle.mjs abort                         # user-invoked escape

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

const STATE_REL = ".omc/state/mission-executor-state.json";
const ABORT_REL = ".omc/state/mission-executor-abort";

function stateDir(missionPath) {
  // Store state next to the working directory so autopilot-lock can find it
  // regardless of mission path. Resolved via working_directory.txt.
  const wd = (() => {
    if (!missionPath) return process.cwd();
    const wdPath = join(resolve(missionPath), "working_directory.txt");
    if (existsSync(wdPath)) return readFileSync(wdPath, "utf8").trim();
    return process.cwd();
  })();
  return wd;
}

function readState(workingDir) {
  const p = join(workingDir, STATE_REL);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch { return null; }
}

function writeState(workingDir, state) {
  const p = join(workingDir, STATE_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
  return p;
}

function start(missionPath) {
  const mp = resolve(missionPath);
  const wd = stateDir(mp);
  const state = {
    active: true,
    missionPath: mp,
    workingDirectory: wd,
    phase: "0-validate",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const p = writeState(wd, state);
  return { ok: true, statePath: p, state };
}

function phase(phaseName) {
  const wd = process.cwd();
  // Walk up to find state file.
  let cur = wd;
  for (let i = 0; i < 8; i++) {
    const p = join(cur, STATE_REL);
    if (existsSync(p)) {
      const state = JSON.parse(readFileSync(p, "utf8"));
      state.phase = phaseName;
      state.updatedAt = new Date().toISOString();
      writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
      return { ok: true, state };
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { ok: false, error: "mission state not found; run 'start' first" };
}

// Complete a mission. GATED: refuses to flip state.active=false unless every
// completion criterion is met (all assertions passed+proof, all features
// completed, state.json says "completed"). This prevents the orchestrator
// from self-declaring completion without evidence. An operator who needs
// to force-complete a mission should create .omc/state/mission-executor-abort
// first (which bypasses the Stop hook) -- the complete gate is intentional.
//
// Override: pass --force to skip the gate. Logged loudly. Use only when
// completion criteria themselves are corrupt (e.g., mission spec bug).
function complete({ force = false } = {}) {
  const wd = process.cwd();
  let cur = wd;
  for (let i = 0; i < 8; i++) {
    const p = join(cur, STATE_REL);
    if (existsSync(p)) {
      const state = JSON.parse(readFileSync(p, "utf8"));

      if (!force && state.missionPath) {
        const check = _checkCompletion(state.missionPath);
        if (!check.complete) {
          return {
            ok: false,
            error: "completion-gate",
            reason: check.reason,
            detail: check.detail || null,
            hint: [
              "Refusing to flip state.active=false because completion criteria are unmet.",
              "Run the suggested next-action from autopilot-lock's block message, or pass",
              "--force if you are recovering a corrupt mission-spec state (logged loudly).",
            ].join(" "),
          };
        }
      }

      state.active = false;
      state.phase = "complete";
      state.completedAt = new Date().toISOString();
      if (force) state.forcedComplete = true;
      writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
      return { ok: true, state, forced: !!force };
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { ok: false, error: "mission state not found" };
}

// Completion-criteria check. Inlined here (rather than imported from
// hooks/_lib/mission-state.mjs) so this script has no hook-layer dependency
// and can be run as a pure CLI utility.
function _checkCompletion(missionPath) {
  try {
    const vsPath = join(missionPath, "validation-state.json");
    const fsPath = join(missionPath, "features.json");
    const stPath = join(missionPath, "state.json");
    if (!existsSync(vsPath)) return { complete: false, reason: "validation-state.json missing" };
    if (!existsSync(fsPath)) return { complete: false, reason: "features.json missing" };
    if (!existsSync(stPath)) return { complete: false, reason: "state.json missing" };
    const vs = JSON.parse(readFileSync(vsPath, "utf8"));
    const fsDoc = JSON.parse(readFileSync(fsPath, "utf8"));
    const st = JSON.parse(readFileSync(stPath, "utf8"));
    const assertions = vs.assertions || {};
    const counts = { total: 0, passed: 0, failed: 0, stale: 0, pending: 0, proofLess: 0 };
    const failedIds = []; const staleIds = []; const proofLessIds = [];
    for (const [id, a] of Object.entries(assertions)) {
      counts.total++;
      const s = a.status || "pending";
      if (s === "passed") {
        if (!a.proof || !a.proof.commitSha) { counts.proofLess++; proofLessIds.push(id); }
        else counts.passed++;
      } else if (s === "failed") { counts.failed++; failedIds.push(id); }
      else if (s === "stale") { counts.stale++; staleIds.push(id); }
      else counts.pending++;
    }
    const features = fsDoc.features || [];
    const pendingFeatures = features.filter((f) => f.status !== "completed");
    const reasons = [];
    if (counts.failed > 0) reasons.push(`${counts.failed} failed assertion(s)`);
    if (counts.stale > 0) reasons.push(`${counts.stale} stale assertion(s)`);
    if (counts.pending > 0) reasons.push(`${counts.pending} pending assertion(s)`);
    if (counts.proofLess > 0) reasons.push(`${counts.proofLess} passed-without-proof assertion(s)`);
    if (pendingFeatures.length > 0) reasons.push(`${pendingFeatures.length} feature(s) not completed`);
    if (st.state !== "completed") reasons.push(`state.json is '${st.state}', not 'completed'`);
    if (reasons.length === 0) return { complete: true };
    return {
      complete: false,
      reason: reasons.join("; "),
      detail: { counts, failedIds: failedIds.slice(0, 5), staleIds: staleIds.slice(0, 5), proofLessIds: proofLessIds.slice(0, 5), pendingFeatures: pendingFeatures.slice(0, 5).map((f) => f.id) },
    };
  } catch (e) {
    return { complete: false, reason: `completion check failed: ${e.message}` };
  }
}

function abort() {
  const wd = process.cwd();
  let cur = wd;
  for (let i = 0; i < 8; i++) {
    const p = join(cur, STATE_REL);
    if (existsSync(p)) {
      const abortPath = join(cur, ABORT_REL);
      mkdirSync(dirname(abortPath), { recursive: true });
      writeFileSync(abortPath, new Date().toISOString() + "\n");
      return { ok: true, abortPath };
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { ok: false, error: "mission state not found" };
}

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain) {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  let result;
  switch (cmd) {
    case "start":
      if (!arg) { process.stderr.write("Usage: node mission-lifecycle.mjs start <mission-path>\n"); process.exit(1); }
      result = start(arg); break;
    case "phase":
      if (!arg) { process.stderr.write("Usage: node mission-lifecycle.mjs phase <phase-name>\n"); process.exit(1); }
      result = phase(arg); break;
    case "complete": {
      const force = process.argv.includes("--force");
      result = complete({ force });
      break;
    }
    case "abort": result = abort(); break;
    default:
      process.stderr.write("Usage: node mission-lifecycle.mjs start|phase|complete [--force]|abort [arg]\n");
      process.exit(1);
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { start, phase, complete, abort, readState };
