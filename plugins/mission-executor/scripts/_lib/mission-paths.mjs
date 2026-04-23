// Mission-scoped path helpers (0.6.0+).
//
// In the 0.6.0 droid-aligned layout, all mission artifacts live INSIDE the
// mission directory, not under a project-scoped `layoutRoot()`. This module
// exposes those paths as pure functions of `missionPath` so callers never
// need to consult the layout-root cache at `hooks/_lib/paths.mjs`.
//
// Matches droid's `MissionFileService` convention at
// `droid-fork/organized/core-services/0806.js` so dual-runtime workflows can
// read and write the same files.
//
// Project-scoped concerns (state.json, session markers, hook-audit.log) stay
// in `hooks/_lib/paths.mjs`'s `layoutRoot()` — they describe "is this project
// running a mission", not "what is the mission's content".

import { join } from "node:path";

export function validationDir(missionPath)   { return join(missionPath, "validation"); }
export function proofsDir(missionPath, id)   { return join(validationDir(missionPath), "proofs", id); }
export function proofStdoutPath(missionPath, id) { return join(proofsDir(missionPath, id), "stdout.txt"); }
export function proofStderrPath(missionPath, id) { return join(proofsDir(missionPath, id), "stderr.txt"); }
export function proofMetaPath(missionPath, id)   { return join(proofsDir(missionPath, id), "meta.json"); }
export function handoffsDir(missionPath)     { return join(missionPath, "handoffs"); }
export function progressLogPath(missionPath) { return join(missionPath, "progress_log.jsonl"); }
export function workingDirectoryPath(missionPath) { return join(missionPath, "working_directory.txt"); }
export function featuresPath(missionPath)    { return join(missionPath, "features.json"); }
export function validationStatePath(missionPath) { return join(missionPath, "validation-state.json"); }
export function validationContractPath(missionPath) { return join(missionPath, "validation-contract.md"); }
export function statePath(missionPath)       { return join(missionPath, "state.json"); }

// Proof-path persistence rule: proof.stdoutPath / proof.stderrPath stored in
// validation-state.json are RELATIVE to missionPath (e.g.
// "validation/proofs/VAL-X/stdout.txt"). Matches droid's relative-path
// convention and keeps proofs portable if the mission directory is moved.
export function relativeProofPath(id, kind) {
  return join("validation", "proofs", id, `${kind}.txt`);
}
