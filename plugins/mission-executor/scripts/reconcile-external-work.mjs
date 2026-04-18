#!/usr/bin/env node
// Reconcile mission state with external work that has already landed in git.
// Runs between INGEST and DECOMPOSE phases. For each feature marked pending
// or in_progress, checks whether its acceptance criteria appear satisfied
// in git HEAD via multiple signals:
//
//   1. Commit messages that mention the feature ID
//   2. Touchpoint files (extracted from description) that have recent commits
//   3. Expected behavior assertions that can be satisfied by grep checks
//
// Features confidently detected as completed are marked in features.json
// so the executor skips them and proceeds directly to verification.
//
// Usage: node reconcile-external-work.mjs <mission-path> [--apply]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { syncFeaturesState } from "./sync-features-state.mjs";
import { detectZombies } from "./detect-zombies.mjs";

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function extractGrepHints(expectedBehavior = []) {
  const hints = [];
  for (const line of expectedBehavior) {
    const quoteMatch = line.match(/`([^`]+)`/g);
    if (quoteMatch) {
      for (const m of quoteMatch) {
        const inner = m.replace(/`/g, "");
        if (/^[A-Za-z_][A-Za-z0-9_]+$/.test(inner) && inner.length > 6) {
          hints.push(inner);
        }
      }
    }
  }
  return hints;
}

let _searchTool = null;
function pickSearchTool() {
  if (_searchTool !== null) return _searchTool;
  try {
    execSync("which rg", { stdio: ["ignore", "pipe", "ignore"] });
    _searchTool = "rg";
  } catch {
    _searchTool = "grep";
  }
  return _searchTool;
}

function safeArg(str) {
  if (typeof str !== "string") return "";
  if (!/^[A-Za-z0-9_\-./]+$/.test(str)) return "";
  return str;
}

function scoreFeatureCompletion(feature, workingDir) {
  let score = 0;
  const signals = [];

  const featureId = safeArg(feature.id);
  const msgCommits = featureId
    ? run(`git log --oneline --all --grep=${featureId} -- .`, workingDir)
        .split("\n").filter(Boolean)
    : [];
  if (msgCommits.length > 0) {
    score += 50;
    signals.push(`commit message: ${msgCommits[0]}`);
  }

  const description = feature.description || "";
  const pathMatches = [...description.matchAll(/`([^`]+\.(ts|tsx|js|jsx|py|go|rs))`/g)].map((m) => m[1]);
  for (const path of pathMatches) {
    const commits = run(`git log --oneline --all --since="30 days ago" -- "${path}"`, workingDir)
      .split("\n").filter(Boolean);
    if (commits.length > 0) {
      score += 10;
      signals.push(`touchpoint ${path}: ${commits.length} recent commits`);
    }
  }

  const grepHints = extractGrepHints(feature.expectedBehavior);
  for (const hint of grepHints) {
    const result = run(
      hint.startsWith("rg ") ? hint : `rg --count "${hint}" -- . 2>/dev/null | head -1`,
      workingDir
    );
    if (result.trim() && !result.startsWith("0")) {
      score += 5;
      signals.push(`grep hit: ${hint}`);
    }
  }

  return { score, signals };
}

function reconcileExternalWork(missionPath, { apply = false } = {}) {
  const dir = resolve(missionPath);
  const featuresPath = join(dir, "features.json");
  const wdPath = join(dir, "working_directory.txt");

  if (!existsSync(featuresPath)) {
    return { ok: false, error: "features.json not found" };
  }

  const workingDir = existsSync(wdPath)
    ? readFileSync(wdPath, "utf8").trim()
    : process.cwd();

  const featuresDoc = JSON.parse(readFileSync(featuresPath, "utf8"));
  const features = featuresDoc.features;

  const zombieReport = detectZombies(dir);
  const syncPreview = syncFeaturesState(dir, { dryRun: true });

  const reconciliation = [];

  for (const feature of features) {
    if (feature.status === "completed") {
      reconciliation.push({
        featureId: feature.id,
        decision: "already-completed",
        score: 100,
      });
      continue;
    }

    const { score, signals } = scoreFeatureCompletion(feature, workingDir);

    let decision;
    if (score >= 50) {
      decision = "mark-completed";
      feature.status = "completed";
      feature.reconciledFrom = "external-work";
    } else if (score >= 20) {
      decision = "likely-done-verify-first";
    } else if (score >= 10) {
      decision = "partial-evidence";
    } else {
      decision = "needs-execution";
    }

    reconciliation.push({
      featureId: feature.id,
      decision,
      score,
      signals: signals.slice(0, 5),
      originalStatus: feature.status === "completed" ? "pending" : feature.status,
    });
  }

  const willMarkCompleted = reconciliation.filter((r) => r.decision === "mark-completed");

  if (apply && willMarkCompleted.length > 0) {
    writeFileSync(featuresPath, JSON.stringify(featuresDoc, null, 2) + "\n");
  }

  return {
    ok: true,
    apply,
    totalFeatures: features.length,
    zombieReport: {
      zombieCount: zombieReport.zombieCount,
      byClassification: zombieReport.byClassification,
    },
    reconciliation,
    summary: {
      markCompleted: willMarkCompleted.length,
      likelyDone: reconciliation.filter((r) => r.decision === "likely-done-verify-first").length,
      partial: reconciliation.filter((r) => r.decision === "partial-evidence").length,
      needsExecution: reconciliation.filter((r) => r.decision === "needs-execution").length,
      alreadyCompleted: reconciliation.filter((r) => r.decision === "already-completed").length,
    },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && process.argv[2]) {
  const missionPath = process.argv[2];
  const apply = process.argv.includes("--apply");
  const result = reconcileExternalWork(missionPath, { apply });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { reconcileExternalWork };
