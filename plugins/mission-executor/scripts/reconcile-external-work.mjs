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
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

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

// Assertion-proof-first scoring. Commit titles are narrative and can lie
// (see bee21e7c's nav-missing-mission-scoping-route commit landing while the
// feature was still `// TODO`). Status flip to completed requires actual
// assertion proofs on HEAD.
//
// Weights:
//   commit message mentions feature id        -> 0   (audit tag only)
//   every declared touchpoint has >=1 commit  -> 15
//   >=1 linked assertion has `passed` proof   -> 25
//   ALL linked assertions have `passed` proof -> 60
//   expected-behavior literal present in HEAD -> 5 per hit, max 15
//
// mark-completed requires score >= 50, which is unreachable without
// assertion proofs.
function scoreFeatureCompletion(feature, workingDir, validationState) {
  let score = 0;
  const signals = [];

  // Audit-only: record that commits mention the feature id, without scoring.
  const featureId = safeArg(feature.id);
  const msgCommits = featureId
    ? run(`git log --oneline --all --grep=${featureId} -- .`, workingDir)
        .split("\n").filter(Boolean)
    : [];
  if (msgCommits.length > 0) {
    signals.push(`audit: commit message references ${featureId}: ${msgCommits[0]}`);
  }

  // Touchpoint coverage: every declared source file has >=1 commit.
  const description = feature.description || "";
  const pathMatches = [...description.matchAll(/`([^`]+\.(ts|tsx|js|jsx|py|go|rs|sql))`/g)].map((m) => m[1]);
  const coveredPaths = [];
  for (const path of pathMatches) {
    const commits = run(`git log --oneline --all -- "${path}"`, workingDir)
      .split("\n").filter(Boolean);
    if (commits.length > 0) coveredPaths.push(path);
  }
  if (pathMatches.length > 0 && coveredPaths.length === pathMatches.length) {
    score += 15;
    signals.push(`touchpoint-coverage: ${coveredPaths.length}/${pathMatches.length} paths have commits`);
  } else if (coveredPaths.length > 0) {
    signals.push(`touchpoint-partial: ${coveredPaths.length}/${pathMatches.length} paths have commits`);
  }

  // Assertion proof lookup. A feature's linked assertions come from
  // feature.fulfills. Proofs are authoritative: only execute-assertion.mjs
  // can record them.
  const linkedAssertions = Array.isArray(feature.fulfills) ? feature.fulfills : [];
  if (linkedAssertions.length > 0 && validationState) {
    const assertions = validationState.assertions || {};
    const passedWithProof = linkedAssertions.filter((aid) => {
      const a = assertions[aid];
      return a && a.status === "passed" && a.proof && a.proof.commitSha;
    });
    const failedOrStale = linkedAssertions.filter((aid) => {
      const a = assertions[aid];
      return a && (a.status === "failed" || a.status === "stale");
    });
    if (passedWithProof.length === linkedAssertions.length) {
      score += 60;
      signals.push(`all ${linkedAssertions.length} linked assertions have passed proofs`);
    } else if (passedWithProof.length >= 1) {
      score += 25;
      signals.push(`${passedWithProof.length}/${linkedAssertions.length} linked assertions have passed proofs`);
    }
    if (failedOrStale.length > 0) {
      signals.push(`${failedOrStale.length} linked assertion(s) failed or stale: ${failedOrStale.slice(0, 3).join(", ")}`);
    }
  }

  // Expected-behavior literal hits: 5 per match, max 15.
  const grepHints = extractGrepHints(feature.expectedBehavior);
  let literalHits = 0;
  const literalTool = pickSearchTool();
  for (const hint of grepHints) {
    if (literalHits >= 3) break;
    const cmd = literalTool === "rg"
      ? `rg --fixed-strings --count "${hint.replace(/"/g, '\\"')}" -- . 2>/dev/null | head -1`
      : `grep -RF --include='*.ts' --include='*.tsx' --include='*.js' --include='*.tsx' -c "${hint.replace(/"/g, '\\"')}" . 2>/dev/null | head -1`;
    const result = run(cmd, workingDir);
    if (result.trim() && !/^0$|:0$/.test(result.trim())) {
      score += 5;
      literalHits += 1;
      signals.push(`literal hit: ${hint}`);
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

  // Load validation-state.json so the scorer can consult assertion proofs.
  // Without proofs, the scorer cannot reach the mark-completed threshold.
  const vsPath = join(dir, "validation-state.json");
  const validationState = existsSync(vsPath)
    ? JSON.parse(readFileSync(vsPath, "utf8"))
    : null;

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

    const { score, signals } = scoreFeatureCompletion(feature, workingDir, validationState);

    let decision;
    if (score >= 50) {
      decision = "mark-completed";
      feature.status = "completed";
      // Do not add non-schema keys here. Reconciliation provenance is returned
      // in the script output; if persistence is needed later, extend the
      // schema upstream first.
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

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain && process.argv[2]) {
  const missionPath = process.argv[2];
  const apply = process.argv.includes("--apply");
  const result = reconcileExternalWork(missionPath, { apply });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { reconcileExternalWork };
