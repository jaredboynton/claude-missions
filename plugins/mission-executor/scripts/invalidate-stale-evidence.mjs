#!/usr/bin/env node
// Invalidate assertions whose proof is no longer fresh.
//
// Runs at the start of VERIFY and again before CRITIC. For each `passed`
// assertion, downgrade to `stale` (internal) and archive the proof bundle
// when either:
//   - proof.commitSha is no longer an ancestor of HEAD (e.g., force-push,
//     detached branch), OR
//   - any declared touchpoint has a commit newer than proof.commitSha.
//
// Usage: node invalidate-stale-evidence.mjs <mission-path> [--dry-run]
// Outputs: JSON summary { totalPassed, invalidated: [...], healthy: [...] }
// Exit: 0 always (this is a cleanup pass; failures are reported in JSON).
//
// "stale" is an internal status. validate-schema.mjs / validate-mission.mjs
// treat it as `pending` for Factory-harness compatibility.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { proofsDir } from "../hooks/_lib/paths.mjs";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// Defect 3 (0.4.7): mirror critic-evaluator's meta-repo-aware ancestry check.
// When proof.childRepo is set, ancestry lives in that child's git history,
// not the workspace-root repo. Without this, the pre-critic invalidation
// pass downgrades healthy child-repo proofs whenever the outer repo advances.
function childCwd(workingDir, childRepo) {
  return childRepo ? resolve(workingDir, childRepo) : workingDir;
}

function isAncestor(sha, workingDir, childRepo) {
  const cwd = childCwd(workingDir, childRepo);
  try {
    execSync(`git merge-base --is-ancestor ${sha} HEAD`, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function newestCommitForPath(path, workingDir, childRepo) {
  // For child-repo proofs, strip the child-dir prefix from the touchpoint so
  // git log runs on the path as the child sees it.
  const cwd = childCwd(workingDir, childRepo);
  const relPath = childRepo && path.startsWith(`${childRepo}/`) ? path.slice(childRepo.length + 1) : path;
  return run(`git log -1 --format=%H -- "${relPath}"`, cwd);
}

function touchpointChangedSince(touchpoints, proofSha, workingDir, childRepo) {
  if (!touchpoints || touchpoints.length === 0) return false;
  const cwd = childCwd(workingDir, childRepo);
  for (const tp of touchpoints) {
    // Skip synthetic annotations we attach when no real path is known.
    if (tp.startsWith("assertion:")) continue;
    // tree: prefix is execute-assertion's command-inferred form; strip for git.
    const cleaned = tp.replace(/^tree:/, "");
    const newest = newestCommitForPath(cleaned, workingDir, childRepo);
    if (!newest) continue;
    // If the newest commit touching this path is NOT an ancestor of proofSha,
    // the path was modified after the proof was captured.
    try {
      execSync(`git merge-base --is-ancestor ${newest} ${proofSha}`, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return true;
    }
  }
  return false;
}

function archiveBundle(missionDir, assertionId, proofSha) {
  // v0.5.0: proofs live at layoutRoot()/validation/proofs/<id>/ (via paths.mjs).
  // missionDir is kept as the arg for backward-compat call signature but is
  // no longer used to derive the proof location.
  const base = proofsDir(assertionId);
  if (!existsSync(base)) return null;
  const archive = join(base, "archive", proofSha || "unknown");
  mkdirSync(archive, { recursive: true });
  for (const name of readdirSync(base)) {
    if (name === "archive") continue;
    const src = join(base, name);
    const dst = join(archive, name);
    try {
      if (statSync(src).isFile()) renameSync(src, dst);
    } catch {
      // best-effort
    }
  }
  return archive;
}

function invalidateStaleEvidence(missionPath, { dryRun = false } = {}) {
  const dir = resolve(missionPath);
  const vpath = join(dir, "validation-state.json");
  const wdPath = join(dir, "working_directory.txt");
  if (!existsSync(vpath)) return { ok: false, error: "validation-state.json not found" };
  const workingDir = existsSync(wdPath) ? readFileSync(wdPath, "utf8").trim() : process.cwd();

  const vs = JSON.parse(readFileSync(vpath, "utf8"));
  const assertions = vs.assertions || {};
  const invalidated = [];
  const healthy = [];
  const missingProof = [];
  let totalPassed = 0;

  for (const [id, entry] of Object.entries(assertions)) {
    if (entry.status !== "passed") continue;
    totalPassed += 1;
    const proof = entry.proof;

    if (!proof || !proof.commitSha) {
      // A `passed` status without a proof is already illegitimate; flag and
      // flip to stale so critic treats it as pending.
      missingProof.push({ id, reason: "no proof block" });
      if (!dryRun) {
        entry.status = "stale";
        delete entry.proof;
      }
      continue;
    }

    const ancestor = isAncestor(proof.commitSha, workingDir, proof.childRepo);
    const tpChanged = touchpointChangedSince(proof.touchpoints || [], proof.commitSha, workingDir, proof.childRepo);

    if (!ancestor || tpChanged) {
      const scope = proof.childRepo ? `${proof.childRepo} HEAD` : "HEAD";
      const reason = !ancestor
        ? `proof.commitSha ${proof.commitSha.slice(0, 12)} not ancestor of ${scope}`
        : `touchpoint changed since ${proof.commitSha.slice(0, 12)}`;
      invalidated.push({ id, reason, proofSha: proof.commitSha });
      if (!dryRun) {
        archiveBundle(dir, id, proof.commitSha);
        entry.status = "stale";
        delete entry.proof;
      }
    } else {
      healthy.push({ id, proofSha: proof.commitSha.slice(0, 12) });
    }
  }

  if (!dryRun && (invalidated.length > 0 || missingProof.length > 0)) {
    writeFileSync(vpath, JSON.stringify(vs, null, 2) + "\n");
  }

  return {
    ok: true,
    dryRun,
    totalPassed,
    healthy: healthy.length,
    invalidated,
    missingProof,
  };
}

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain && process.argv[2]) {
  const dryRun = process.argv.includes("--dry-run");
  const result = invalidateStaleEvidence(process.argv[2], { dryRun });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { invalidateStaleEvidence };
