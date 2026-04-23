#!/usr/bin/env node
// Dispatcher for mission-cli subcommands. See _lib/mission-cli-core.mjs for
// shared helpers. See spec sec 4 for the full subcommand contract.
//
// v0.5.1: auto-emit progress-log events from lifecycle subcommands + new
// explicit `event` subcommand. See scripts/_lib/progress-log.mjs.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

import {
  parseArgs, emit, nowIso, ensureDir,
  readStateFile, writeStateAtomic,
  resolveMission, resolveDefault,
  mutateState, ensureAttached,
  heartbeatFresh,
} from "./_lib/mission-cli-core.mjs";
import {
  readRegistry, mutateRegistry, registerMission, unregisterMission,
  findMissionById, findMissionForSession, listActive,
} from "./_lib/registry.mjs";
import { stateFile, abortFile, stateBase } from "../hooks/_lib/paths.mjs";
import { appendEvent, readEvents, deriveWorkerStates, activeWorkerSessionIds } from "./_lib/progress-log.mjs";
import { migrateProjectStateToUserGlobal } from "./_lib/migrate.mjs";

// Safe wrapper: progress-log writes must NEVER fail a command. Silently swallow.
function emitEvent(missionPath, type, extra = {}) {
  if (!missionPath || !type) return;
  try { appendEvent(missionPath, { type, ...extra }); } catch {}
}

// Completion gate — re-used from mission-state.mjs pattern in 0.4.x.
// Inlined here to keep mission-cli free of hook-layer deps.
function checkCompletion(missionPath) {
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
        // v0.6.0: proof shape is toolType + command + paths (no commitSha).
        if (!a.proof || !a.proof.toolType || !a.proof.command) { counts.proofLess++; proofLessIds.push(id); }
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
    return { complete: false, reason: reasons.join("; "),
      detail: { counts, failedIds: failedIds.slice(0,5), staleIds: staleIds.slice(0,5),
                proofLessIds: proofLessIds.slice(0,5), pendingFeatures: pendingFeatures.slice(0,5).map((f)=>f.id) } };
  } catch (e) {
    return { complete: false, reason: `completion check failed: ${e.message}` };
  }
}

// ---- Subcommands ----

async function cmdResolve(args) {
  const raw = args._[0];
  if (!raw) return emit({ ok: false, error: "bad-input", hint: "usage: resolve <path-or-id>" }, 4);
  try {
    const r = resolveMission(raw);
    emit({ ok: true, ...r });
  } catch (e) {
    emit({ ok: false, error: e.message, ...(e.candidates ? { candidates: e.candidates } : {}) }, e.exitCode || 1);
  }
}

async function cmdStart(args) {
  const raw = args._[0];
  if (!raw) return emit({ ok: false, error: "bad-input", hint: "usage: start <mission-path>" }, 4);
  const sid = args["session-id"];
  if (!sid) return emit({ ok: false, error: "missing --session-id" }, 4);

  // v0.8.0: lift any pre-existing project-scoped state out of the workingDir
  // before resolving state paths. Never fatal.
  try { migrateProjectStateToUserGlobal(args.cwd || process.cwd()); } catch {}

  let mission;
  try { mission = resolveMission(raw); }
  catch (e) { return emit({ ok: false, error: e.message }, e.exitCode || 3); }

  // Collision check: a mission with this id already registered at a DIFFERENT path
  const existing = findMissionById(mission.missionId);
  if (existing) {
    try {
      const existingState = JSON.parse(readFileSync(existing.statePath, "utf8"));
      if (existingState.missionPath && existingState.missionPath !== mission.missionPath) {
        return emit({
          ok: false, error: "collision",
          missionId: mission.missionId,
          existingPath: existingState.missionPath,
          requestedPath: mission.missionPath,
          hint: "Two missions share the same basename. Rename one of the mission directories, or /execute the full path to disambiguate."
        }, 5);
      }
    } catch {}
  }

  const cwd = args.cwd || process.cwd();

  try {
    // State-file lock: atomic create-or-attach
    let action = "started";
    const next = await mutateState((current) => {
      if (current && current.active) {
        ensureAttached(current, sid, cwd);
        current.updatedAt = nowIso();
        action = "attached-to-existing";
        return current;
      }
      // Fresh start (no state, or prior state inactive)
      const fresh = {
        active: true,
        missionPath: mission.missionPath,
        missionId: mission.missionId,
        workingDirectory: cwd,
        attachedSessions: [],
        phase: "0-validate",
        startedAt: nowIso(),
        updatedAt: nowIso(),
      };
      ensureAttached(fresh, sid, cwd);
      return fresh;
    });

    // Register in global registry (GC happens inside mutateRegistry)
    await registerMission(mission.missionId, {
      statePath: stateFile(),
      workingDirectory: cwd,
      registeredAt: nowIso(),
    });

    emitEvent(mission.missionPath, action === "started" ? "mission_started" : "session_attached", {
      sessionId: sid, cwd, missionId: mission.missionId,
    });

    emit({ ok: true, action, missionId: mission.missionId, missionPath: mission.missionPath, statePath: stateFile() });
  } catch (e) {
    if (e.code === "LOCK_TIMEOUT") return emit({ ok: false, error: "lock-timeout", detail: e.message }, 6);
    throw e;
  }
}

async function cmdAttach(args) {
  const sid = args["session-id"];
  if (!sid) return emit({ ok: false, error: "missing --session-id" }, 4);

  // v0.8.0: lift any pre-existing project-scoped state out of the workingDir
  // before resolving state paths. Never fatal.
  try { migrateProjectStateToUserGlobal(args.cwd || process.cwd()); } catch {}

  let mission;
  try {
    if (args._[0]) mission = resolveMission(args._[0]);
    else mission = resolveDefault();
  } catch (e) {
    const payload = { ok: false, error: e.message };
    if (e.candidates) payload.candidates = e.candidates;
    return emit(payload, e.exitCode || 3);
  }

  const cwd = args.cwd || process.cwd();
  try {
    const next = await mutateState((current) => {
      if (!current || !current.active) {
        const err = new Error("mission not active"); err.exitCode = 3; throw err;
      }
      if (current.missionId !== mission.missionId) {
        // State file is for a different mission; can't attach here.
        const err = new Error(`state file at ${stateFile()} is for '${current.missionId}', not '${mission.missionId}'`);
        err.exitCode = 3; throw err;
      }
      ensureAttached(current, sid, cwd);
      current.updatedAt = nowIso();
      return current;
    });

    emitEvent(mission.missionPath, "session_attached", { sessionId: sid, cwd, missionId: mission.missionId });

    emit({ ok: true, action: "attached", missionId: mission.missionId, statePath: stateFile() });
  } catch (e) {
    if (e.code === "LOCK_TIMEOUT") return emit({ ok: false, error: "lock-timeout" }, 6);
    if (e.exitCode) return emit({ ok: false, error: e.message }, e.exitCode);
    throw e;
  }
}

async function cmdDetach(args) {
  const sid = args["session-id"];
  if (!sid) return emit({ ok: false, error: "missing --session-id" }, 4);

  try {
    let result = null;
    let missionPath = null;
    const next = await mutateState((current) => {
      if (!current || !current.active) {
        const err = new Error("no active mission"); err.exitCode = 3; throw err;
      }
      const idx = (current.attachedSessions || []).findIndex((x) => x.sessionId === sid);
      if (idx < 0) {
        const err = new Error("not-attached"); err.exitCode = 3; throw err;
      }
      const me = current.attachedSessions[idx];
      const isLast = current.attachedSessions.length === 1;
      if (isLast) {
        const err = new Error(
          "Last-session detach blocked. Run /mission-executor:abort or /mission-executor:complete " +
          "to end the mission, or open a second session and /execute there first."
        );
        err.exitCode = 7; throw err;
      }
      if (me.role === "driver" && heartbeatFresh(sid)) {
        const err = new Error("driver-detach-blocked: skill appears to be running (heartbeat <60s old)");
        err.exitCode = 7; throw err;
      }
      current.attachedSessions.splice(idx, 1);
      current.updatedAt = nowIso();
      result = { remaining: current.attachedSessions.length };
      missionPath = current.missionPath;
      return current;
    });

    emitEvent(missionPath, "session_detached", { sessionId: sid, remaining: result?.remaining });

    emit({ ok: true, action: "detached", ...result });
  } catch (e) {
    if (e.code === "LOCK_TIMEOUT") return emit({ ok: false, error: "lock-timeout" }, 6);
    if (e.exitCode) return emit({ ok: false, error: e.message }, e.exitCode);
    throw e;
  }
}

async function cmdStatus(args) {
  let mission;
  try {
    if (args._[0]) mission = resolveMission(args._[0]);
    else {
      try { mission = resolveDefault(); }
      catch (e) {
        if (e.exitCode === 3) return emit({ ok: true, active: [], note: "no active missions" });
        throw e;
      }
    }
  } catch (e) {
    const payload = { ok: false, error: e.message };
    if (e.candidates) payload.candidates = e.candidates;
    return emit(payload, e.exitCode || 3);
  }
  const st = readStateFile();
  if (!st || !st.active) return emit({ ok: true, missionId: mission.missionId, active: false });
  const check = st.missionPath ? checkCompletion(st.missionPath) : { complete: false, reason: "no missionPath in state" };

  // v0.5.1: derive worker state summary from progress_log.jsonl.
  let workers = null;
  let activeWorkers = null;
  if (st.missionPath) {
    try {
      const events = readEvents(st.missionPath);
      workers = deriveWorkerStates(events);
      activeWorkers = activeWorkerSessionIds(events);
    } catch {}
  }

  emit({
    ok: true,
    missionId: mission.missionId,
    missionPath: st.missionPath,
    phase: st.phase,
    active: st.active,
    attachedSessions: (st.attachedSessions || []).map((s) => ({ sessionId: s.sessionId, role: s.role, cwd: s.cwd })),
    completion: check,
    ...(workers ? { workers, activeWorkers } : {}),
  });
}

async function cmdPhase(args) {
  const phaseName = args._[0];
  if (!phaseName) return emit({ ok: false, error: "bad-input", hint: "usage: phase <name>" }, 4);
  const sid = args["session-id"];
  if (!sid) return emit({ ok: false, error: "missing --session-id" }, 4);
  try {
    let fromPhase = null;
    let missionPath = null;
    await mutateState((current) => {
      if (!current || !current.active) {
        const err = new Error("no active mission"); err.exitCode = 3; throw err;
      }
      if (!current.attachedSessions?.some((x) => x.sessionId === sid)) {
        const err = new Error("not-attached"); err.exitCode = 3; throw err;
      }
      fromPhase = current.phase || null;
      missionPath = current.missionPath;
      current.phase = phaseName;
      current.updatedAt = nowIso();
      return current;
    });

    emitEvent(missionPath, "phase_transition", { sessionId: sid, from: fromPhase, to: phaseName });

    emit({ ok: true, phase: phaseName });
  } catch (e) {
    if (e.code === "LOCK_TIMEOUT") return emit({ ok: false, error: "lock-timeout" }, 6);
    if (e.exitCode) return emit({ ok: false, error: e.message }, e.exitCode);
    throw e;
  }
}

async function cmdComplete(args) {
  const sid = args["session-id"];
  if (!sid) return emit({ ok: false, error: "missing --session-id" }, 4);
  const force = !!args.force;
  try {
    let missionId = null;
    let missionPath = null;
    await mutateState((current) => {
      if (!current) { const err = new Error("no active mission"); err.exitCode = 3; throw err; }
      if (!current.attachedSessions?.some((x) => x.sessionId === sid)) {
        const err = new Error("not-attached"); err.exitCode = 3; throw err;
      }
      if (!force && current.missionPath) {
        const check = checkCompletion(current.missionPath);
        if (!check.complete) {
          const err = new Error("completion-gate-unmet"); err.exitCode = 8;
          err.detail = { reason: check.reason, ...check.detail };
          throw err;
        }
      }
      current.active = false;
      current.phase = "complete";
      current.completedAt = nowIso();
      if (force) current.forcedComplete = true;
      missionId = current.missionId;
      missionPath = current.missionPath;
      return current;
    });
    if (missionId) await unregisterMission(missionId);

    emitEvent(missionPath, "mission_completed", { sessionId: sid, forced: force, missionId });

    emit({ ok: true, action: "completed", forced: !!force });
  } catch (e) {
    if (e.code === "LOCK_TIMEOUT") return emit({ ok: false, error: "lock-timeout" }, 6);
    if (e.exitCode === 8) return emit({ ok: false, error: "completion-gate-unmet", detail: e.detail }, 8);
    if (e.exitCode) return emit({ ok: false, error: e.message }, e.exitCode);
    throw e;
  }
}

async function cmdAbort(args) {
  const sid = args["session-id"];
  if (!sid) return emit({ ok: false, error: "missing --session-id" }, 4);
  const st = readStateFile();
  if (!st || !st.active) return emit({ ok: false, error: "no-active-mission" }, 3);
  if (!st.attachedSessions?.some((x) => x.sessionId === sid)) {
    return emit({ ok: false, error: "not-attached" }, 3);
  }
  ensureDir(stateBase());
  writeFileSync(abortFile(), nowIso() + "\n");

  emitEvent(st.missionPath, "mission_aborted", { sessionId: sid });

  emit({ ok: true, action: "abort-marker-dropped", path: abortFile() });
}

async function cmdIsAttached(args) {
  // v0.8.1: query-success semantics.
  //   Missing --session-id        -> ok:false, exit 4  (bad input)
  //   Session attached to mission -> ok:true, attached:true, missionId, exit 0
  //   Session not attached        -> ok:true, attached:false, exit 0
  //
  // Prior behavior exited 1 for both "no sid" and "not attached", which is
  // indistinguishable from "lookup threw" and made shell callers (commands/
  // execute.md bash helpers) unable to branch cleanly. Query-success is
  // now encoded in the JSON field, not the exit code, mirroring the
  // shared `emit()` convention used by resolve/start/complete/status/etc.
  const sid = args["session-id"];
  if (!sid) return emit({ ok: false, error: "bad-input", hint: "usage: is-attached --session-id=<sid>" }, 4);
  const found = findMissionForSession(sid);
  if (found) return emit({ ok: true, attached: true, missionId: found.missionId }, 0);
  return emit({ ok: true, attached: false }, 0);
}

// v0.5.1: explicit event emitter. Used by the skill for worker_started /
// worker_completed / worker_failed etc. that mission-cli doesn't auto-emit.
async function cmdEvent(args) {
  const type = args._[0];
  if (!type) return emit({ ok: false, error: "bad-input", hint: "usage: event <type> --session-id=<sid> [flags]" }, 4);
  const sid = args["session-id"];
  if (!sid) return emit({ ok: false, error: "missing --session-id" }, 4);

  // Resolve mission from the session's attach state. Only attached sessions
  // can emit — keeps unrelated sessions from polluting the log.
  const found = findMissionForSession(sid);
  if (!found) return emit({ ok: false, error: "not-attached" }, 3);

  const missionPath = found.state?.missionPath;
  if (!missionPath) return emit({ ok: false, error: "no missionPath on state" }, 1);

  const extra = { sessionId: sid };
  if (args.feature) extra.featureId = args.feature;
  if (args.worker) extra.workerSessionId = args.worker;
  if (args.milestone) extra.milestone = args.milestone;
  if (args.reason) extra.reason = args.reason;
  if (args["exit-code"] !== undefined) {
    const n = Number(args["exit-code"]);
    if (Number.isFinite(n)) extra.exitCode = n;
  }
  if (args.spawn) extra.spawnId = args.spawn;
  if (args["extra-json"]) {
    try { Object.assign(extra, JSON.parse(args["extra-json"])); }
    catch (e) { return emit({ ok: false, error: `bad --extra-json: ${e.message}` }, 4); }
  }

  const r = appendEvent(missionPath, { type, ...extra });
  if (!r.ok) return emit({ ok: false, error: r.error }, 1);
  emit({ ok: true, path: r.path, type });
}

// ---- Main ----

const argv = process.argv.slice(2);
const sub = argv[0];
const args = parseArgs(argv.slice(1));

const table = {
  "resolve": cmdResolve, "start": cmdStart, "attach": cmdAttach, "detach": cmdDetach,
  "status": cmdStatus, "phase": cmdPhase, "complete": cmdComplete, "abort": cmdAbort,
  "is-attached": cmdIsAttached,
  "event": cmdEvent,
};

if (sub === "--help" || sub === "-h" || !sub) {
  process.stdout.write([
    "mission-cli.mjs <subcommand> [args]",
    "Subcommands: " + Object.keys(table).join(", "),
    "All subcommands accept --session-id=<id>; see spec sec 4 for exit codes.",
  ].join("\n") + "\n");
  process.exit(sub ? 0 : 4);
}

const fn = table[sub];
if (!fn) {
  process.stderr.write(`mission-cli.mjs: unknown subcommand '${sub}'\n`);
  process.exit(4);
}

fn(args).catch((e) => {
  process.stderr.write(`mission-cli.mjs: ${e.stack || e.message}\n`);
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + "\n");
  process.exit(1);
});
