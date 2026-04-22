#!/usr/bin/env node
// Single CLI entry for all mission lifecycle operations (v0.5.0).
// Replaces scattered shell-outs to mission-lifecycle.mjs.
//
// Subcommands + exit codes (spec sec 4):
//   resolve  <path-or-id>                                  0 ok, 2 ambiguous, 3 not-found, 4 bad-input
//   start    <missionPath> --session-id=<id>               0 ok, 4 missing-sid, 5 collision, 6 lock-timeout
//   attach   [<missionId>] --session-id=<id> [--cwd]       0 ok, 2 ambiguous, 3 no-such, 4 missing-sid, 6 lock-timeout
//   detach                 --session-id=<id>               0 ok, 3 not-attached, 7 detach-blocked, 6 lock-timeout
//   status   [<missionId>] [--session-id=<id>]             0 ok, 2 ambiguous, 3 no-such
//   phase    <phaseName>   --session-id=<id>               0 ok, 3 not-attached, 6 lock-timeout
//   complete               --session-id=<id> [--force]     0 ok, 8 gate-unmet, 3 not-attached
//   abort                  --session-id=<id>               0 ok, 3 not-attached
//   is-attached            --session-id=<id>               0 attached, 1 not-attached
//
// All subcommands print one JSON object to stdout. Stderr carries warnings
// (stale-lock recovery, GC drops, migration notices).

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, utimesSync } from "node:fs";
import { resolve as resolvePath, basename, dirname, join } from "node:path";
import { realpathSync } from "node:fs";

import {
  stateFile, stateLockFile, stateBase, abortFile, heartbeatFile,
} from "../../hooks/_lib/paths.mjs";
import {
  readRegistry, mutateRegistry, registerMission, unregisterMission,
  findMissionById, findMissionForSession, listActive,
} from "./registry.mjs";
import { withLock } from "./lockfile.mjs";

const HEARTBEAT_STALE_MS = 60_000;

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, ...rest] = a.slice(2).split("=");
      out[k] = rest.length ? rest.join("=") : true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function nowIso() { return new Date().toISOString(); }

function ensureDir(p) { mkdirSync(p, { recursive: true }); }

function readStateFile() {
  const p = stateFile();
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function writeStateAtomic(obj) {
  const p = stateFile();
  ensureDir(dirname(p));
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  renameSync(tmp, p);
  return p;
}

// ---- Resolution ----

// Resolve raw input (path or bare id) to { missionPath, missionId }.
// Path: realpathSync + basename. Id: registry lookup.
function resolveMission(raw) {
  if (!raw || typeof raw !== "string") throw Object.assign(new Error("empty input"), { exitCode: 4 });

  // Try path resolution first if it looks like a path or exists on disk.
  const looksLikePath = raw.includes("/") || raw.startsWith(".") || raw.startsWith("~");
  if (looksLikePath) {
    const abs = resolvePath(raw.replace(/^~/, process.env.HOME || "~"));
    if (!existsSync(abs)) throw Object.assign(new Error(`path not found: ${abs}`), { exitCode: 3 });
    const real = realpathSync(abs);
    return { missionPath: real, missionId: basename(real) };
  }

  // Bare id: look up in registry
  const entry = findMissionById(raw);
  if (!entry) throw Object.assign(new Error(`unknown mission id: ${raw}`), { exitCode: 3 });
  // The registry entry stores statePath, not missionPath directly; pull it from state file.
  try {
    const st = JSON.parse(readFileSync(entry.statePath, "utf8"));
    return { missionPath: st.missionPath, missionId: raw };
  } catch {
    throw Object.assign(new Error(`registry entry for '${raw}' points at unreadable state`), { exitCode: 3 });
  }
}

// When called with no mission arg, pick the sole active mission or error.
function resolveDefault() {
  const active = listActive();
  if (active.length === 0) throw Object.assign(new Error("no active missions"), { exitCode: 3 });
  if (active.length > 1) {
    const candidates = active.map((a) => ({ missionId: a.missionId, missionPath: a.state.missionPath }));
    throw Object.assign(new Error("ambiguous"), { exitCode: 2, candidates });
  }
  const a = active[0];
  return { missionPath: a.state.missionPath, missionId: a.missionId };
}

// ---- Session-attach under state-file lock ----

// Mutate the state file under lock. cb receives the current state (or null),
// returns the new state. Caller decides whether to initialize.
async function mutateState(cb) {
  ensureDir(stateBase());
  return withLock(stateLockFile(), async () => {
    const current = readStateFile();
    const next = await cb(current);
    if (next) writeStateAtomic(next);
    return next;
  });
}

function ensureAttached(state, sessionId, cwd, { migratedFromLegacy = false } = {}) {
  state.attachedSessions = state.attachedSessions || [];
  const existing = state.attachedSessions.find((x) => x.sessionId === sessionId);
  if (existing) {
    existing.cwd = cwd || existing.cwd;
    return false;
  }
  state.attachedSessions.push({
    sessionId,
    attachedAt: nowIso(),
    cwd: cwd || process.cwd(),
    role: "driver",
    ...(migratedFromLegacy ? { migratedFromLegacy: true } : {}),
  });
  return true;
}

// ---- Heartbeat (driver-active detection) ----

function heartbeatFresh(sid) {
  try {
    const st = statSync(heartbeatFile(sid));
    return Date.now() - st.mtimeMs < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

// ---- Export for subcommand dispatch ----

export {
  parseArgs, emit, nowIso, ensureDir,
  readStateFile, writeStateAtomic,
  resolveMission, resolveDefault,
  mutateState, ensureAttached,
  heartbeatFresh,
};
