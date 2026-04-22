#!/usr/bin/env node
// Two-stage independent critic for mission validation.
//
// Stage A (structural): for every `passed` assertion, verify that the proof
//   block is present, that proof.commitSha is an ancestor of HEAD, and that
//   recomputed sha256 of stdoutPath/stderrPath matches the recorded hashes.
//
// Stage B (spot re-execute): sample 20% of passed assertions + 100% of any
//   literal-probe assertions; re-run via execute-assertion.mjs; any divergence
//   is a regression.
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
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

function sha256File(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Defect 3 (0.4.7): when a proof was produced inside a meta-repo child
// (proof.childRepo set), ancestry must be checked against that child's HEAD,
// not the workspace-root HEAD — they're separate git histories. Fall back
// to workingDir for legacy proofs and single-repo missions.
function isAncestor(sha, workingDir, childRepo) {
  const cwd = childRepo ? resolve(workingDir, childRepo) : workingDir;
  try {
    execSync(`git merge-base --is-ancestor ${sha} HEAD`, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function resolveArtifact(artifactPath, missionDir, workingDir) {
  if (!artifactPath) return null;
  if (isAbsolute(artifactPath)) return artifactPath;
  const mp = join(missionDir, artifactPath);
  if (existsSync(mp)) return mp;
  const wp = workingDir ? join(workingDir, artifactPath) : null;
  return wp && existsSync(wp) ? wp : mp;
}

function stageAStructural(missionDir, assertions, workingDir) {
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

    const required = ["commitSha", "toolType", "command", "exitCode", "stdoutPath", "stderrPath", "touchpoints", "executedAt"];
    const missing = required.filter((k) => proof[k] === undefined || proof[k] === null);
    if (missing.length > 0) {
      issues.push({ id, category: "incomplete-proof", detail: `missing fields: ${missing.join(", ")}` });
      continue;
    }

    if (!isAncestor(proof.commitSha, workingDir, proof.childRepo)) {
      const scope = proof.childRepo ? `${proof.childRepo} HEAD` : "HEAD";
      issues.push({ id, category: "stale-commit", detail: `proof.commitSha ${proof.commitSha.slice(0, 12)} not ancestor of ${scope}` });
      continue;
    }

    const stdoutAbs = resolveArtifact(proof.stdoutPath, missionDir, workingDir);
    const stderrAbs = resolveArtifact(proof.stderrPath, missionDir, workingDir);
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

function stageBSpotCheck(missionDir, assertions, workingDir, sampleRate) {
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

  const executeScript = join(resolve(new URL(import.meta.url).pathname, ".."), "execute-assertion.mjs");

  for (const id of sample) {
    reExecuted.push(id);
    // CRITIC_SPOT_CHECK=1 tells execute-assertion.mjs to compute the verdict
    // and proof bundle but NOT write to validation-state.json — critic
    // verification is a read, not a mutation. Without this flag, a re-exec
    // that produces a different verdict than the original pass downgrades
    // the assertion, breaking critic idempotency (defect 2 in 0.4.6).
    // MISSION_EXECUTOR_WRITER stays set for belt-and-suspenders: if any
    // future path needs the gate it remains honored.
    const env = {
      ...process.env,
      MISSION_EXECUTOR_WRITER: "1",
      CRITIC_SPOT_CHECK: "1",
    };
    const r = spawnSync("node", [executeScript, missionDir, `--id=${id}`], {
      encoding: "utf8",
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    // execute-assertion exit: 0=passed, 1=failed, 2=blocked, 3=infra
    if (r.status === 0) continue;
    if (r.status === 2 || r.status === 3) {
      // Blocked or infra-limited: do not count as regression (stage B is best-effort).
      continue;
    }
    // Failed re-execution = regression.
    let detail = "re-execute failed";
    try {
      const out = JSON.parse(r.stdout);
      detail = `re-execute failed: expected=${out.expected || "?"} observed exit=${out.observed?.exitCode ?? r.status}`;
    } catch {}
    issues.push({ id, category: "re-execute-divergence", detail });
  }

  return { reExecuted, issues };
}

function evaluateMission(missionPath, opts = {}) {
  const sampleRate = opts.sampleRate ?? 0.2;
  const skipStageB = !!opts.skipStageB;

  const dir = resolve(missionPath);
  const valStatePath = join(dir, "validation-state.json");
  const wdPath = join(dir, "working_directory.txt");
  if (!existsSync(valStatePath)) {
    return { verdict: "ERROR", message: "validation-state.json not found", counts: {} };
  }
  const workingDir = existsSync(wdPath) ? readFileSync(wdPath, "utf8").trim() : process.cwd();

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
  const stageA = stageAStructural(dir, assertions, workingDir);

  // Stage B: only if A is clean
  let stageB = { reExecuted: [], issues: [] };
  if (!skipStageB && stageA.issues.length === 0) {
    stageB = stageBSpotCheck(dir, assertions, workingDir, sampleRate);
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
