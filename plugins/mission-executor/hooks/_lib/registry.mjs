// Hook-side read-only view of the registry. Hooks run hot (every tool call)
// so we avoid the lock for reads - writes in scripts/_lib/registry.mjs use
// atomic tmp+rename, so a reader always sees a coherent snapshot.

import { readFileSync, existsSync } from "node:fs";
import { registryFile } from "./paths.mjs";

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
