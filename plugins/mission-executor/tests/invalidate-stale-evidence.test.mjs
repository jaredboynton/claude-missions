// Contract-change detector tests (0.6.0).
//
// invalidate-stale-evidence.mjs no longer consults git. It hashes each
// passed assertion's block in validation-contract.md and compares against
// the recorded proof.contractSha256. Drift = stale. Assertion absent from
// contract = stale. Legacy proofs without contractSha256 = unchecked
// (will get a hash on next execute-assertion run).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildGreenMission } from "./_mission-fixture.mjs";
import { invalidateStaleEvidence, extractAssertionBlock } from "../scripts/invalidate-stale-evidence.mjs";

function readVal(fx) {
  return JSON.parse(readFileSync(fx.valStatePath, "utf8"));
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function stampContractHashes(fx) {
  // Populate proof.contractSha256 on every passed assertion by reading the
  // current contract. Matches what execute-assertion.mjs writes in 0.6.0.
  const contract = readFileSync(join(fx.missionPath, "validation-contract.md"), "utf8");
  const vs = readVal(fx);
  for (const [id, entry] of Object.entries(vs.assertions)) {
    if (entry.status !== "passed" || !entry.proof) continue;
    const block = extractAssertionBlock(contract, id);
    if (block) entry.proof.contractSha256 = sha256(block);
  }
  writeFileSync(fx.valStatePath, JSON.stringify(vs, null, 2) + "\n");
}

test("unchanged contract -> all passed assertions stay healthy", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());
  stampContractHashes(fx);

  const r = invalidateStaleEvidence(fx.missionPath);
  assert.equal(r.ok, true);
  assert.equal(r.invalidated.length, 0);
  assert.equal(r.missingProof.length, 0);
  assert.equal(r.healthy, fx.assertionIds.length);

  // State unchanged
  for (const id of fx.assertionIds) {
    assert.equal(readVal(fx).assertions[id].status, "passed");
  }
});

test("contract block edited -> assertion flipped to stale + proof archived", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());
  stampContractHashes(fx);

  // Mutate the first assertion's block.
  const contractPath = join(fx.missionPath, "validation-contract.md");
  const original = readFileSync(contractPath, "utf8");
  const targetId = fx.assertionIds[0];
  const mutated = original.replace(
    new RegExp(`### ${targetId}: .+`),
    `### ${targetId}: mutated title`,
  );
  assert.notEqual(mutated, original, "contract mutation did not take effect");
  writeFileSync(contractPath, mutated);

  const r = invalidateStaleEvidence(fx.missionPath);
  assert.equal(r.invalidated.length, 1, JSON.stringify(r));
  assert.equal(r.invalidated[0].id, targetId);
  assert.match(r.invalidated[0].reason, /contract-hash drift/);

  const post = readVal(fx);
  assert.equal(post.assertions[targetId].status, "stale");
  assert.equal(post.assertions[targetId].proof, undefined, "stale assertion should have proof deleted");
  // Sibling assertion untouched.
  const other = fx.assertionIds[1];
  assert.equal(post.assertions[other].status, "passed");
});

test("assertion removed from contract entirely -> flipped to stale", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());
  stampContractHashes(fx);

  const contractPath = join(fx.missionPath, "validation-contract.md");
  const original = readFileSync(contractPath, "utf8");
  const targetId = fx.assertionIds[0];
  // Strip the whole block.
  const block = extractAssertionBlock(original, targetId);
  assert.ok(block, "fixture block missing");
  const mutated = original.replace(block, "");
  writeFileSync(contractPath, mutated);

  const r = invalidateStaleEvidence(fx.missionPath);
  const match = r.invalidated.find((x) => x.id === targetId);
  assert.ok(match, `expected ${targetId} in invalidated, got ${JSON.stringify(r.invalidated)}`);
  assert.match(match.reason, /absent from validation-contract/);
});

test("legacy proof without contractSha256 -> unchecked, not invalidated", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());
  // Do NOT call stampContractHashes — legacy 0.5.x proofs have no contract hash.

  const r = invalidateStaleEvidence(fx.missionPath);
  assert.equal(r.invalidated.length, 0);
  assert.equal(r.healthy, 0);
  assert.equal(r.unchecked.length, fx.assertionIds.length);
  for (const u of r.unchecked) {
    assert.match(u.reason, /predates contractSha256/);
  }

  // State unchanged
  for (const id of fx.assertionIds) {
    assert.equal(readVal(fx).assertions[id].status, "passed");
  }
});

test("passed assertion with no proof block -> flipped to stale", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  const vs = readVal(fx);
  delete vs.assertions[fx.assertionIds[0]].proof;
  writeFileSync(fx.valStatePath, JSON.stringify(vs, null, 2) + "\n");

  const r = invalidateStaleEvidence(fx.missionPath);
  assert.equal(r.missingProof.length, 1);
  assert.equal(r.missingProof[0].id, fx.assertionIds[0]);
  assert.equal(readVal(fx).assertions[fx.assertionIds[0]].status, "stale");
});

test("dry-run flag reports but does not mutate state", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());
  stampContractHashes(fx);

  const contractPath = join(fx.missionPath, "validation-contract.md");
  const original = readFileSync(contractPath, "utf8");
  const targetId = fx.assertionIds[0];
  writeFileSync(contractPath, original.replace(`### ${targetId}:`, `### ${targetId}: CHANGED`));

  const r = invalidateStaleEvidence(fx.missionPath, { dryRun: true });
  assert.equal(r.invalidated.length, 1);
  // State unchanged despite drift detected.
  assert.equal(readVal(fx).assertions[targetId].status, "passed");
  assert.ok(readVal(fx).assertions[targetId].proof, "proof should not be stripped on dry-run");
});

test("execute-assertion populates proof.contractSha256 on 0.6.0+", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  // Flip one assertion to pending then re-execute — the resulting proof
  // should carry contractSha256.
  const vs = readVal(fx);
  const id = fx.assertionIds[0];
  vs.assertions[id].status = "pending";
  delete vs.assertions[id].proof;
  writeFileSync(fx.valStatePath, JSON.stringify(vs, null, 2) + "\n");

  const { spawnSync } = await import("node:child_process");
  const { fixtureEnv, PLUGIN_ROOT } = await import("./_mission-fixture.mjs");
  const EXECUTE = join(PLUGIN_ROOT, "scripts/execute-assertion.mjs");
  const r = spawnSync(process.execPath, [EXECUTE, fx.missionPath, `--id=${id}`], {
    encoding: "utf8",
    env: fixtureEnv(fx),
  });
  assert.equal(r.status, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);

  const proof = readVal(fx).assertions[id].proof;
  assert.ok(proof, "proof not written");
  assert.match(proof.contractSha256 || "", /^[0-9a-f]{64}$/,
    `expected 64-char hex contractSha256, got ${JSON.stringify(proof.contractSha256)}`);
});
