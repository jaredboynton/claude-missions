#!/usr/bin/env node
// Canonical status queries for mission JSON artifacts.
//
// The plugin's JSON files have shapes that trip up casual jq one-liners:
//   - features.json: `{ features: [{ id, milestone, status, ... }, ...] }`
//   - validation-state.json: `{ assertions: { "VAL-XXX-NNN": { status, proof?, ... }, ... } }`
//
// Common trip-ups:
//   - `jq '.features | length'` works, but `jq '.features | group_by(.status)'`
//     fails on the assertions tree — the root is an OBJECT of id→status, not an
//     ARRAY, so group_by errors with "cannot be sorted".
//   - `jq '.assertions | to_entries[] | .value.status'` is the correct shape
//     for validation-state, but it is easy to forget mid-mission.
//
// This helper exposes explicit verbs so the orchestrator never needs to guess:
//
//   node mission-query.mjs <missionPath> features
//   node mission-query.mjs <missionPath> assertions
//   node mission-query.mjs <missionPath> summary          (default)
//
// All output is JSON on stdout. Exit 0 on success, 1 on shape error, 2 on
// missing mission artifact.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

function die(msg, code = 1) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
}

function loadJSON(path) {
  if (!existsSync(path)) die(`missing: ${path}`, 2);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`invalid JSON at ${path}: ${e.message}`, 1);
  }
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function featureSummary(missionPath) {
  const d = loadJSON(join(missionPath, "features.json"));
  const features = Array.isArray(d.features) ? d.features : [];
  const byStatus = countBy(features, (f) => f.status || "unknown");
  const byMilestone = {};
  for (const f of features) {
    const m = f.milestone || "unknown";
    byMilestone[m] ||= { total: 0, completed: 0, in_progress: 0, pending: 0, other: 0 };
    byMilestone[m].total += 1;
    const s = f.status || "unknown";
    if (s === "completed") byMilestone[m].completed += 1;
    else if (s === "in_progress") byMilestone[m].in_progress += 1;
    else if (s === "pending") byMilestone[m].pending += 1;
    else byMilestone[m].other += 1;
  }
  return {
    total: features.length,
    byStatus,
    byMilestone,
    completedIds: features.filter((f) => f.status === "completed").map((f) => f.id),
    pendingIds: features.filter((f) => f.status === "pending").map((f) => f.id),
    inProgressIds: features.filter((f) => f.status === "in_progress").map((f) => f.id),
  };
}

function assertionSummary(missionPath) {
  const d = loadJSON(join(missionPath, "validation-state.json"));
  const assertions = d.assertions;
  if (!assertions || typeof assertions !== "object" || Array.isArray(assertions)) {
    die("validation-state.json: .assertions must be an object of id→status", 1);
  }
  const ids = Object.keys(assertions);
  const byStatus = {};
  const pendingIds = [];
  const staleIds = [];
  const failedIds = [];
  const blockedIds = [];
  const passedWithoutProof = [];
  for (const id of ids) {
    const entry = assertions[id] || {};
    const s = entry.status || "unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
    if (s === "pending") pendingIds.push(id);
    else if (s === "stale") staleIds.push(id);
    else if (s === "failed") failedIds.push(id);
    else if (s === "blocked") blockedIds.push(id);
    else if (s === "passed") {
      // v0.6.0: proof must carry toolType + command + stdoutPath at minimum.
      // commitSha / childRepo dropped with the git-ancestry model.
      const p = entry.proof;
      if (!p || !p.toolType || !p.command || !p.stdoutPath) passedWithoutProof.push(id);
    }
  }
  return {
    total: ids.length,
    byStatus,
    pendingIds,
    staleIds,
    failedIds,
    blockedIds,
    passedWithoutProof,
  };
}

function missionState(missionPath) {
  const stateFile = join(missionPath, "state.json");
  if (!existsSync(stateFile)) return { missing: true };
  return loadJSON(stateFile);
}

function treeHeads(missionPath) {
  const wdFile = join(missionPath, "working_directory.txt");
  if (!existsSync(wdFile)) return { missing: "working_directory.txt" };
  const wd = readFileSync(wdFile, "utf8").trim();
  const heads = {};
  try {
    heads[wd] = execFileSync("git", ["-C", wd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    heads[wd] = "<not-a-git-repo>";
  }
  let entries = [];
  try {
    entries = readdirSync(wd);
  } catch {
    return heads;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const child = join(wd, name);
    let st;
    try { st = statSync(child); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (!existsSync(join(child, ".git"))) continue;
    try {
      heads[child] = execFileSync("git", ["-C", child, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {}
  }
  return heads;
}

function main() {
  const [, , missionArg, verb = "summary"] = process.argv;
  if (!missionArg) {
    die("usage: mission-query.mjs <mission-path> [features|assertions|summary]", 1);
  }
  const missionPath = resolve(missionArg);
  let out;
  if (verb === "features") out = featureSummary(missionPath);
  else if (verb === "assertions") out = assertionSummary(missionPath);
  else if (verb === "summary") {
    out = {
      missionPath,
      state: missionState(missionPath),
      features: featureSummary(missionPath),
      assertions: assertionSummary(missionPath),
      heads: treeHeads(missionPath),
    };
  } else {
    die(`unknown verb: ${verb}`, 1);
  }
  console.log(JSON.stringify(out, null, 2));
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main();
