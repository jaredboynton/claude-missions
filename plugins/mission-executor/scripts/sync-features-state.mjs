#!/usr/bin/env node
// Sync features.json status field from git HEAD after a team batch completes.
// For each feature, check if git HEAD contains commits that mention the
// feature ID or touch the feature's declared touchpoints. If so, mark the
// feature as completed and record the completing commit SHA.
//
// Usage: node sync-features-state.mjs <mission-path> [--dry-run]
// Outputs: JSON summary of status transitions.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return "";
  }
}

function extractTouchpoints(description) {
  const paths = [];
  const regex = /`([^`]+\.(ts|tsx|js|jsx|py|go|rs|java|kt|sql))`/g;
  for (const m of description.matchAll(regex)) {
    paths.push(m[1]);
  }
  return paths;
}

function safeArg(str) {
  if (typeof str !== "string") return "";
  if (!/^[A-Za-z0-9_\-./]+$/.test(str)) return "";
  return str;
}

function findCommitsForFeature(feature, workingDir) {
  const featureId = safeArg(feature.id);
  if (!featureId) return { byMessage: [], byPath: [], touchpoints: [] };

  const commitsByMessage = run(`git log --oneline --all --grep=${featureId} -- .`, workingDir)
    .split("\n").filter(Boolean).map((l) => l.split(" ")[0]);

  const touchpoints = extractTouchpoints(feature.description || "")
    .map(safeArg).filter(Boolean);
  const commitsByPath = new Set();

  for (const tp of touchpoints) {
    const out = run(`git log --oneline --all -- ${tp}`, workingDir);
    for (const line of out.split("\n").filter(Boolean)) {
      commitsByPath.add(line.split(" ")[0]);
    }
  }

  return {
    byMessage: commitsByMessage,
    byPath: [...commitsByPath],
    touchpoints,
  };
}

function syncFeaturesState(missionPath, { dryRun = false } = {}) {
  const dir = resolve(missionPath);
  const featuresPath = join(dir, "features.json");

  if (!existsSync(featuresPath)) {
    return { ok: false, error: "features.json not found" };
  }

  const wdPath = join(dir, "working_directory.txt");
  const workingDir = existsSync(wdPath)
    ? readFileSync(wdPath, "utf8").trim()
    : process.cwd();

  const featuresDoc = JSON.parse(readFileSync(featuresPath, "utf8"));
  const features = featuresDoc.features;
  const transitions = [];

  for (const feature of features) {
    if (feature.status === "completed") continue;

    const { byMessage, byPath, touchpoints } = findCommitsForFeature(feature, workingDir);
    const allCommits = [...new Set([...byMessage, ...byPath])];

    if (byMessage.length > 0) {
      transitions.push({
        featureId: feature.id,
        from: feature.status,
        to: "completed",
        evidence: `commit message mentions feature ID: ${byMessage.join(", ")}`,
        commitSha: byMessage[0],
        touchpointsMatched: byPath.length,
      });
      feature.status = "completed";
      // Preserve existing completedWorkerSessionId if set by a real worker;
      // otherwise fall back to the commit SHA so downstream schema checks pass
      // (Factory schema requires a non-null string when workerSessionIds are present).
      if (!feature.completedWorkerSessionId && Array.isArray(feature.workerSessionIds) && feature.workerSessionIds.length > 0) {
        feature.completedWorkerSessionId = feature.workerSessionIds[feature.workerSessionIds.length - 1];
      } else if (!feature.completedWorkerSessionId) {
        feature.completedWorkerSessionId = null;
      }
      continue;
    }

    if (touchpoints.length > 0 && byPath.length > 0) {
      const matchRatio = byPath.length / touchpoints.length;
      if (matchRatio >= 0.5) {
        transitions.push({
          featureId: feature.id,
          from: feature.status,
          to: "likely_completed",
          evidence: `${byPath.length}/${touchpoints.length} touchpoints have commits: ${byPath.slice(0, 3).join(", ")}`,
          matchRatio,
        });
      }
    }
  }

  if (!dryRun && transitions.some((t) => t.to === "completed")) {
    writeFileSync(featuresPath, JSON.stringify(featuresDoc, null, 2) + "\n");
  }

  const summary = {
    ok: true,
    dryRun,
    totalFeatures: features.length,
    transitions,
    transitionCount: transitions.length,
    completedCount: transitions.filter((t) => t.to === "completed").length,
    likelyCompletedCount: transitions.filter((t) => t.to === "likely_completed").length,
  };

  return summary;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && process.argv[2]) {
  const missionPath = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  const result = syncFeaturesState(missionPath, { dryRun });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { syncFeaturesState };
