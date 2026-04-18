#!/usr/bin/env node
// Detect zombie worker sessions: workers marked as in_progress whose
// actual work has already landed in git HEAD (making them no-ops to resume)
// OR whose session IDs no longer point to live processes.
//
// Usage: node detect-zombies.mjs <mission-path>
// Outputs: JSON with zombie classifications.
//
// Classifications:
// - "dead-work-landed": in_progress feature whose commits are already in HEAD
// - "dead-no-session": in_progress feature with workerSessionIds but no active session
// - "stale-paused": feature in paused state with no recent activity
// - "healthy": feature correctly tracked

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function gitContainsFeature(featureId, workingDir) {
  const out = run(`git log --oneline --all --grep="${featureId}" -- .`, workingDir);
  const commits = out.split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
  return { found: commits.length > 0, commits };
}

function parseProgressLog(missionPath) {
  const logPath = join(missionPath, "progress_log.jsonl");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function detectZombies(missionPath) {
  const dir = resolve(missionPath);
  const featuresPath = join(dir, "features.json");
  const wdPath = join(dir, "working_directory.txt");

  if (!existsSync(featuresPath)) {
    return { ok: false, error: "features.json not found" };
  }

  const features = JSON.parse(readFileSync(featuresPath, "utf8")).features;
  const workingDir = existsSync(wdPath)
    ? readFileSync(wdPath, "utf8").trim()
    : process.cwd();

  const progressLog = parseProgressLog(dir);

  const deadSessions = new Set();
  for (const entry of progressLog) {
    if (entry.type === "worker_paused" || entry.type === "mission_paused") {
      if (entry.workerSessionId) deadSessions.add(entry.workerSessionId);
    }
  }

  const classifications = [];

  for (const feature of features) {
    const { id, status, workerSessionIds = [] } = feature;
    const gitCheck = gitContainsFeature(id, workingDir);

    if (status === "in_progress") {
      if (gitCheck.found) {
        classifications.push({
          featureId: id,
          classification: "dead-work-landed",
          reason: `status=in_progress but git already contains commits mentioning this feature`,
          commits: gitCheck.commits,
          action: "mark completed, skip execution",
          workerSessionIds,
        });
        continue;
      }

      const liveWorkers = workerSessionIds.filter((w) => !deadSessions.has(w));
      if (workerSessionIds.length > 0 && liveWorkers.length === 0) {
        classifications.push({
          featureId: id,
          classification: "dead-no-session",
          reason: `all workers (${workerSessionIds.length}) are marked paused in progress_log`,
          action: "reset status to pending, clear workerSessionIds, re-dispatch",
          deadWorkers: workerSessionIds,
        });
        continue;
      }

      if (workerSessionIds.length === 0) {
        classifications.push({
          featureId: id,
          classification: "dead-no-session",
          reason: `in_progress with no worker session IDs recorded`,
          action: "reset to pending, re-dispatch",
        });
        continue;
      }

      classifications.push({
        featureId: id,
        classification: "healthy",
        reason: `in_progress with ${liveWorkers.length} live worker(s)`,
      });
      continue;
    }

    if (status === "pending" && gitCheck.found) {
      classifications.push({
        featureId: id,
        classification: "pending-but-landed",
        reason: `status=pending but git contains feature commits (external completion)`,
        commits: gitCheck.commits,
        action: "mark completed via sync-features-state",
      });
      continue;
    }

    classifications.push({
      featureId: id,
      classification: "healthy",
      reason: `status=${status}, no anomalies`,
    });
  }

  const summary = {
    ok: true,
    totalFeatures: features.length,
    zombieCount: classifications.filter((c) => c.classification.startsWith("dead-") || c.classification === "pending-but-landed").length,
    classifications,
    byClassification: {
      "dead-work-landed": classifications.filter((c) => c.classification === "dead-work-landed").map((c) => c.featureId),
      "dead-no-session": classifications.filter((c) => c.classification === "dead-no-session").map((c) => c.featureId),
      "pending-but-landed": classifications.filter((c) => c.classification === "pending-but-landed").map((c) => c.featureId),
      "healthy": classifications.filter((c) => c.classification === "healthy").map((c) => c.featureId),
    },
  };

  return summary;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && process.argv[2]) {
  const result = detectZombies(process.argv[2]);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { detectZombies };
