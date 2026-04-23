#!/usr/bin/env node
// Two-stage independent critic for mission validation.
//
// Stage A (structural): for every `passed` assertion, verify that the proof
//   block is present and that recomputed sha256 of stdoutPath/stderrPath
//   still matches the recorded hashes (content-integrity check only).
//
// Stage B (spot re-execute): sample 20% of passed assertions + 100% of any
//   literal-probe assertions; re-run via execute-assertion.mjs with
//   CRITIC_SPOT_CHECK=1 so validation-state.json is not mutated; any
//   divergence is a regression.
//
// v0.6.0: dropped the git-ancestry check (proof.commitSha no longer exists).
// Staleness is now orchestrator-driven: when validation-contract.md changes
// such that an assertion's criteria change, the orchestrator flips that
// assertion to `pending`. See AGENTS.md "Staleness model" + the droid
// upstream convention at organized/uncategorized/0801.js:1649.
//
// The critic emits "all validation criteria have been met" ONLY when both
// stages pass with zero issues. This is the single string the pipeline checks
// to advance from CRITIC to COMPLETE.
//
// Usage:
//   node critic-evaluator.mjs <mission-path> [--sample-rate=0.2] [--skip-stage-b]
//
// Exit: 0 on PASS; 1 on FAIL/INCOMPLETE/STRUCTURAL_ISSUES.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { upgradeLegacy052Proofs } from "./_lib/migrate.mjs";
import { executeAssertionReadOnly } from "./execute-assertion.mjs";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

function sha256File(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveArtifact(artifactPath, missionDir) {
  if (!artifactPath) return null;
  if (isAbsolute(artifactPath)) return artifactPath;
  return join(missionDir, artifactPath);
}

function stageAStructural(missionDir, assertions) {
  const issues = [];
  const ok = [];
  let checked = 0;

  for (const [id, entry] of Object.entries(assertions)) {
    if (entry.status !== "passed") continue;
    checked += 1;
    const proof = entry.proof;

    if (!proof) {
      issues.push({ id, category: "missing-proof", detail: "no `proof` block on passed assertion" });
      continue;
    }

    // v0.6.0: commitSha dropped from required fields. childRepo dropped
    // entirely. The critic no longer consults git history.
    const required = ["toolType", "command", "exitCode", "stdoutPath", "stderrPath", "touchpoints", "executedAt"];
    const missing = required.filter((k) => proof[k] === undefined || proof[k] === null);
    if (missing.length > 0) {
      issues.push({ id, category: "incomplete-proof", detail: `missing fields: ${missing.join(", ")}` });
      continue;
    }

    const stdoutAbs = resolveArtifact(proof.stdoutPath, missionDir);
    const stderrAbs = resolveArtifact(proof.stderrPath, missionDir);
    const stdoutSha = sha256File(stdoutAbs);
    const stderrSha = sha256File(stderrAbs);

    if (proof.stdoutSha256 && stdoutSha !== proof.stdoutSha256) {
      issues.push({ id, category: "hash-mismatch", detail: `stdout sha256 mismatch at ${proof.stdoutPath}` });
      continue;
    }
    if (proof.stderrSha256 && stderrSha !== proof.stderrSha256) {
      issues.push({ id, category: "hash-mismatch", detail: `stderr sha256 mismatch at ${proof.stderrPath}` });
      continue;
    }

    ok.push(id);
  }

  return { checked, ok, issues };
}

function stageBSpotCheck(missionDir, assertions, sampleRate) {
  const issues = [];
  const reExecuted = [];

  const passedIds = Object.entries(assertions)
    .filter(([, a]) => a.status === "passed" && a.proof)
    .map(([id]) => id);

  const literalProbeIds = Object.entries(assertions)
    .filter(([, a]) => a.status === "passed" && a.proof?.toolType === "literal-probe")
    .map(([id]) => id);

  // Sample 20% of passed + 100% of literal-probe.
  const sampleCount = Math.max(1, Math.ceil(passedIds.length * sampleRate));
  const shuffled = [...passedIds].sort(() => Math.random() - 0.5);
  const sample = new Set([...shuffled.slice(0, sampleCount), ...literalProbeIds]);

  for (const id of sample) {
    reExecuted.push(id);
    // v0.8.1: call executeAssertionReadOnly() in-process instead of
    // spawning node on execute-assertion.mjs. The read-only variant sets
    // CRITIC_SPOT_CHECK=1 for the duration of the call, which makes the
    // gate in executeAssertion() return BEFORE writeProofBundle — so no
    // stdout.txt / stderr.txt / meta.json under
    // <missionDir>/validation/proofs/<id>/ is rewritten by the critic.
    // Prior implementation spawned node and depended on CRITIC_SPOT_CHECK
    // env propagation; the gate also fired AFTER writeProofBundle, so the
    // proofs were overwritten even though validation-state.json was spared.
    // Stage A on the next run then observed a hash-mismatch and flipped
    // the assertion -- defect 2 (0.4.7) re-opened and now fully closed.
    let result;
    try {
      result = executeAssertionReadOnly(missionDir, { id });
    } catch (e) {
      issues.push({ id, category: "re-execute-divergence", detail: `critic re-exec threw: ${e.message}` });
      continue;
    }
    // Verdict shape matches the prior spawnSync contract:
    //   status "passed" -> pass; "blocked"/"infra" -> best-effort skip;
    //   "failed" or anything else -> regression.
    if (result.status === "passed") continue;
    if (result.status === "blocked" || result.status === "infra") continue;
    const detail = `re-execute failed: expected=${result.expected || "?"} observed exit=${result.observed?.exitCode ?? "?"}`;
    issues.push({ id, category: "re-execute-divergence", detail });
  }

  return { reExecuted, issues };
}

function evaluateMission(missionPath, opts = {}) {
  const sampleRate = opts.sampleRate ?? 0.2;
  const skipStageB = !!opts.skipStageB;

  const dir = resolve(missionPath);
  const valStatePath = join(dir, "validation-state.json");
  if (!existsSync(valStatePath)) {
    return { verdict: "ERROR", message: "validation-state.json not found", counts: {} };
  }

  // One-shot migration of 0.5.x proofs to the 0.6.0 schema + path layout.
  // Idempotent: no-op once migrated.
  try { upgradeLegacy052Proofs(missionPath); } catch { /* never fatal */ }

  const valState = JSON.parse(readFileSync(valStatePath, "utf8"));
  const assertions = valState.assertions || {};

  const counts = { total: 0, passed: 0, failed: 0, pending: 0, stale: 0, blocked: 0 };
  const failures = [];
  const pending = [];

  for (const [id, entry] of Object.entries(assertions)) {
    counts.total++;
    const status = entry.status || "pending";
    switch (status) {
      case "passed": counts.passed++; break;
      case "failed":
        counts.failed++;
        failures.push({ id, evidence: entry.evidence || null });
        break;
      case "stale":
        counts.stale++;
        pending.push({ id, reason: "stale (proof invalidated)" });
        break;
      case "blocked":
        counts.blocked++;
        pending.push({ id, reason: "blocked" });
        break;
      default:
        counts.pending++;
        pending.push({ id, reason: "not yet validated" });
    }
  }

  // Stage A: structural
  const stageA = stageAStructural(dir, assertions);

  // Stage B: only if A is clean
  let stageB = { reExecuted: [], issues: [] };
  if (!skipStageB && stageA.issues.length === 0) {
    stageB = stageBSpotCheck(dir, assertions, sampleRate);
  }

  const allPassed =
    counts.failed === 0 &&
    counts.pending === 0 &&
    counts.stale === 0 &&
    counts.blocked === 0 &&
    counts.passed === counts.total;

  const structuralClean = stageA.issues.length === 0;
  const spotCheckClean = stageB.issues.length === 0;

  if (allPassed && structuralClean && spotCheckClean) {
    return {
      verdict: "PASS",
      message: "all validation criteria have been met",
      counts,
      stageA: { checked: stageA.checked, ok: stageA.ok.length },
      stageB: { reExecuted: stageB.reExecuted.length, divergences: 0 },
    };
  }

  const reasons = [];
  if (!allPassed) {
    if (counts.failed > 0) reasons.push(`${counts.failed} failed`);
    if (counts.stale > 0) reasons.push(`${counts.stale} stale`);
    if (counts.pending > 0) reasons.push(`${counts.pending} pending`);
    if (counts.blocked > 0) reasons.push(`${counts.blocked} blocked`);
  }
  if (!structuralClean) reasons.push(`stageA: ${stageA.issues.length} structural issue(s)`);
  if (!spotCheckClean) reasons.push(`stageB: ${stageB.issues.length} re-execute divergence(s)`);

  const verdict = counts.failed > 0 || !spotCheckClean ? "FAIL" : "INCOMPLETE";

  return {
    verdict,
    message: reasons.join("; "),
    counts,
    stageA: {
      checked: stageA.checked,
      ok: stageA.ok.length,
      issues: stageA.issues.slice(0, 25),
    },
    stageB: {
      reExecuted: stageB.reExecuted.length,
      divergences: stageB.issues.length,
      issues: stageB.issues.slice(0, 25),
    },
    failures: failures.slice(0, 25),
    pending: pending.slice(0, 25),
  };
}

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain && process.argv[2]) {
  const opts = {};
  for (const a of process.argv.slice(3)) {
    if (a === "--skip-stage-b") opts.skipStageB = true;
    const m = a.match(/^--sample-rate=([0-9.]+)$/);
    if (m) opts.sampleRate = Number(m[1]);
  }
  const result = evaluateMission(process.argv[2], opts);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.verdict === "PASS" ? 0 : 1);
}

export { evaluateMission };
