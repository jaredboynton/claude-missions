// Global mission registry reader/writer at ~/.claude/mission-executor/registry.json.
//
// All mutations acquire registryLockFile() via withLock(). Reads are lock-free
// (atomic write via tmp+rename guarantees a valid JSON snapshot).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { registryFile, registryLockFile } from "../../hooks/_lib/paths.mjs";
import { withLock } from "./lockfile.mjs";

function ensureDir(p) { mkdirSync(p, { recursive: true }); }

export function readRegistry() {
  const p = registryFile();
  if (!existsSync(p)) return { missions: {} };
  try {
    const doc = JSON.parse(readFileSync(p, "utf8"));
    if (!doc || typeof doc !== "object" || !doc.missions) return { missions: {} };
    return doc;
  } catch {
    return { missions: {} };
  }
}

function writeRegistryAtomic(doc) {
  const p = registryFile();
  ensureDir(dirname(p));
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  renameSync(tmp, p);
}

// Drop entries whose statePath is missing OR whose state file has active:false.
// Returns the list of removed missionIds for audit/stderr surfacing.
function gc(doc) {
  const removed = [];
  for (const [id, entry] of Object.entries(doc.missions || {})) {
    let drop = false;
    if (!entry?.statePath || !existsSync(entry.statePath)) {
      drop = true;
    } else {
      try {
        const st = JSON.parse(readFileSync(entry.statePath, "utf8"));
        if (st.active === false) drop = true;
      } catch {
        drop = true;
      }
    }
    if (drop) {
      delete doc.missions[id];
      removed.push(id);
    }
  }
  return removed;
}

export async function mutateRegistry(fn, { skipGc = false } = {}) {
  ensureDir(dirname(registryFile()));
  return withLock(registryLockFile(), async () => {
    const doc = readRegistry();
    const removed = skipGc ? [] : gc(doc);
    const result = await fn(doc);
    writeRegistryAtomic(doc);
    return { result, gcRemoved: removed };
  });
}

export async function registerMission(missionId, entry) {
  return mutateRegistry((doc) => {
    doc.missions = doc.missions || {};
    doc.missions[missionId] = entry;
    return doc.missions[missionId];
  });
}

export async function unregisterMission(missionId) {
  return mutateRegistry((doc) => {
    if (doc.missions && doc.missions[missionId]) delete doc.missions[missionId];
    return null;
  });
}

export function findMissionById(missionId) {
  const doc = readRegistry();
  return doc.missions?.[missionId] || null;
}

export function findMissionForSession(sessionId) {
  const doc = readRegistry();
  for (const [id, entry] of Object.entries(doc.missions || {})) {
    if (!entry?.statePath || !existsSync(entry.statePath)) continue;
    try {
      const st = JSON.parse(readFileSync(entry.statePath, "utf8"));
      if (st.attachedSessions?.some((x) => x.sessionId === sessionId)) {
        return { missionId: id, entry, state: st };
      }
    } catch {}
  }
  return null;
}

export function listActive() {
  const doc = readRegistry();
  const out = [];
  for (const [id, entry] of Object.entries(doc.missions || {})) {
    if (!entry?.statePath || !existsSync(entry.statePath)) continue;
    try {
      const st = JSON.parse(readFileSync(entry.statePath, "utf8"));
      if (st.active) out.push({ missionId: id, entry, state: st });
    } catch {}
  }
  return out;
}
