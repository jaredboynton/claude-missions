// Append-only mission event stream.
//
// Path: <missionPath>/progress_log.jsonl (per-mission, next to state.json /
// features.json / validation-state.json). Matches droid's MissionFileService
// location so a dual-runtime workflow can share the file.
//
// Concurrency: POSIX atomic-append (single write < PIPE_BUF, ~4KB on Linux,
// 512B on older kernels). Our entries stay well under 1KB. No lockfile.
//
// Who writes: scripts/mission-cli.mjs (auto-emit from lifecycle subcommands +
// explicit `event` subcommand), hooks/_lib/mission-state.mjs (legacy-migration
// emitter only). The 8 hooks DO NOT touch progress_log - they stay on
// hook-audit.log. Bright line.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { progressLogFile } from "../../hooks/_lib/paths.mjs";

// ---- Append ----

// Append one event. `event` MUST include `type`. `timestamp` is filled in if
// absent. Returns { ok, path } | { ok:false, error }.
export function appendEvent(missionPath, event) {
  if (!missionPath) return { ok: false, error: "missionPath required" };
  if (!event || typeof event !== "object") return { ok: false, error: "event must be an object" };
  if (!event.type || typeof event.type !== "string") return { ok: false, error: "event.type required" };

  const entry = { timestamp: event.timestamp || new Date().toISOString(), ...event };
  const line = JSON.stringify(entry) + "\n";
  const path = progressLogFile(missionPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- Read ----

// Read all events. Returns [] on missing file or parse errors (best-effort).
export function readEvents(missionPath) {
  const path = progressLogFile(missionPath);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---- Derivations ----

// Map worker session-id -> { startedAt, completedAt?, exitCode?, reason?, failed? }
// from the event stream. Mirrors droid's derivedWorkerStates reduction.
export function deriveWorkerStates(events) {
  const states = {};
  for (const e of events) {
    const sid = e.workerSessionId;
    if (!sid) continue;
    if (e.type === "worker_started") {
      const prev = states[sid] || {};
      states[sid] = { startedAt: prev.startedAt || e.timestamp, ...prev };
    } else if (e.type === "worker_completed") {
      const prev = states[sid] || {};
      states[sid] = {
        startedAt: prev.startedAt || e.timestamp,
        completedAt: e.timestamp,
        exitCode: e.exitCode,
      };
    } else if (e.type === "worker_failed") {
      const prev = states[sid] || {};
      states[sid] = {
        startedAt: prev.startedAt || e.timestamp,
        completedAt: e.timestamp,
        exitCode: e.exitCode,
        failed: true,
        ...(e.reason ? { reason: e.reason } : {}),
      };
    } else if (e.type === "worker_paused") {
      const prev = states[sid] || {};
      states[sid] = { ...prev, pausedAt: e.timestamp };
    } else if (e.type === "worker_stranded") {
      const prev = states[sid] || {};
      states[sid] = {
        startedAt: prev.startedAt || e.timestamp,
        completedAt: e.timestamp,
        stranded: true,
        ...(e.reason ? { reason: e.reason } : {}),
      };
    }
  }
  return states;
}

// Session-ids with a start but no terminal event (complete/fail/stranded).
export function activeWorkerSessionIds(events) {
  const states = deriveWorkerStates(events);
  return Object.entries(states)
    .filter(([, s]) => !s.completedAt)
    .map(([sid]) => sid);
}
