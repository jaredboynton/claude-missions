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

function complete() {
  const wd = process.cwd();
  let cur = wd;
  for (let i = 0; i < 8; i++) {
    const p = join(cur, STATE_REL);
    if (existsSync(p)) {
      const state = JSON.parse(readFileSync(p, "utf8"));
      state.active = false;
      state.phase = "complete";
      state.completedAt = new Date().toISOString();
      writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
      return { ok: true, state };
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { ok: false, error: "mission state not found" };
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
    case "complete": result = complete(); break;
    case "abort": result = abort(); break;
    default:
      process.stderr.write("Usage: node mission-lifecycle.mjs start|phase|complete|abort [arg]\n");
      process.exit(1);
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { start, phase, complete, abort, readState };
