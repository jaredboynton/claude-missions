#!/usr/bin/env node
// Invalidate passed assertions whose contract text has changed.
//
// v0.6.0: dropped the git-ancestry staleness model (proof.commitSha is gone).
// The new detector is contract-driven: for each `passed` assertion, hash the
// assertion block in validation-contract.md; on next run, if the hash no
// longer matches the recorded `proof.contractSha256`, flip the assertion to
// `stale` and archive the proof bundle. This matches droid's orchestrator-
// driven invalidation at organized/uncategorized/0801.js:1649: "If the
// change invalidates a previous `"passed"` result ... reset the status to
// `"pending"`."
//
// Runs at the start of VERIFY and again before CRITIC. Assertions whose
// proof predates the contract-hash field (legacy 0.5.x or earlier) are
// left alone — they'll pick up a contractSha256 on their next re-execute
// through execute-assertion.mjs.
//
// Usage: node invalidate-stale-evidence.mjs <mission-path> [--dry-run]
// Outputs: JSON summary { totalPassed, invalidated: [...], healthy, missingProof }
// Exit: 0 always (this is a cleanup pass; failures are reported in JSON).
//
// "stale" is an internal status. validate-schema.mjs / validate-mission.mjs
// treat it as `pending` for Factory-harness compatibility.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { proofsDir } from "./_lib/mission-paths.mjs";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

// Extract an assertion block from validation-contract.md. Matches the same
// heuristic execute-assertion.mjs `parseAssertion` uses so hashes stay in
// sync across the two scripts.
function extractAssertionBlock(contract, id) {
  const idPattern = new RegExp(`###\\s+${id.replace(/[-.]/g, "\\$&")}[:.\\s]`, "m");
  const match = contract.match(idPattern);
  if (!match) return null;
  const start = match.index;
  const rest = contract.slice(start + match[0].length);
  const nextH3 = rest.search(/^###\s+/m);
  const nextH2 = rest.search(/^##\s+/m);
  let next = -1;
  if (nextH3 !== -1 && nextH2 !== -1) next = Math.min(nextH3, nextH2);
  else if (nextH3 !== -1) next = nextH3;
  else if (nextH2 !== -1) next = nextH2;
  const block = next === -1 ? rest : rest.slice(0, next);
  return contract.slice(start, start + match[0].length + block.length).trim();
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function archiveBundle(missionDir, assertionId, tag) {
  const base = proofsDir(missionDir, assertionId);
  if (!existsSync(base)) return null;
  const archive = join(base, "archive", tag || "stale");
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
  const cpath = join(dir, "validation-contract.md");
  if (!existsSync(vpath)) return { ok: false, error: "validation-state.json not found" };
  const contract = existsSync(cpath) ? readFileSync(cpath, "utf8") : null;

  const vs = JSON.parse(readFileSync(vpath, "utf8"));
  const assertions = vs.assertions || {};
  const invalidated = [];
  const healthy = [];
  const missingProof = [];
  const unchecked = [];
  let totalPassed = 0;

  for (const [id, entry] of Object.entries(assertions)) {
    if (entry.status !== "passed") continue;
    totalPassed += 1;
    const proof = entry.proof;

    if (!proof) {
      // A `passed` status without a proof is illegitimate (bee21e7c failure
      // mode); flip to stale so the critic treats it as pending.
      missingProof.push({ id, reason: "no proof block" });
      if (!dryRun) {
        entry.status = "stale";
      }
      continue;
    }

    // Legacy proofs (0.5.x) have no contractSha256 field. Leave them alone;
    // they'll pick up the new field on next execute-assertion run.
    if (!proof.contractSha256) {
      unchecked.push({ id, reason: "proof predates contractSha256 field; will be hashed on next execute" });
      continue;
    }

    if (!contract) {
      unchecked.push({ id, reason: "validation-contract.md missing; cannot hash" });
      continue;
    }

    const block = extractAssertionBlock(contract, id);
    if (!block) {
      // Assertion removed from contract entirely — orchestrator deleted it.
      // Flip to stale (operator cleanup will drop the entry).
      invalidated.push({ id, reason: "assertion absent from validation-contract.md" });
      if (!dryRun) {
        archiveBundle(dir, id, "contract-removed");
        entry.status = "stale";
        delete entry.proof;
      }
      continue;
    }

    const currentSha = sha256(block);
    if (currentSha !== proof.contractSha256) {
      invalidated.push({
        id,
        reason: `contract-hash drift: recorded=${proof.contractSha256.slice(0, 12)} current=${currentSha.slice(0, 12)}`,
      });
      if (!dryRun) {
        archiveBundle(dir, id, "contract-changed");
        entry.status = "stale";
        delete entry.proof;
      }
    } else {
      healthy.push({ id, contractSha256: currentSha.slice(0, 12) });
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
    unchecked,
  };
}

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain && process.argv[2]) {
  const dryRun = process.argv.includes("--dry-run");
  const result = invalidateStaleEvidence(process.argv[2], { dryRun });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { invalidateStaleEvidence, extractAssertionBlock };
