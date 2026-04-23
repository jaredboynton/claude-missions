// Defect 2 regression test: running critic-evaluator.mjs twice on a
// known-green mission MUST produce identical counts.passed AND leave
// validation-state.json + proof-bundle files byte-for-byte unchanged.
//
// Pre-fix behavior (0.4.6): Stage B calls execute-assertion.mjs which
// rewrites validation-state.json on every re-run.
//
// Post-fix behavior (0.4.7): Stage B spawns the child with
// CRITIC_SPOT_CHECK=1; validation-state.json is spared BUT
// writeProofBundle still ran before the early-return, so stdout.txt /
// stderr.txt / meta.json were rewritten on every critic run — Stage A
// on the next invocation observed a hash-mismatch and flipped assertions.
//
// Post-fix behavior (0.8.1): the CRITIC_SPOT_CHECK gate moved BEFORE
// writeProofBundle, and critic-evaluator now calls
// executeAssertionReadOnly() in-process (no spawn, no env propagation
// hazard). Both validation-state.json AND the proof bundles are
// untouched across critic runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildGreenMission, fixtureEnv, fileSha256, PLUGIN_ROOT } from "./_mission-fixture.mjs";

const CRITIC = join(PLUGIN_ROOT, "scripts/critic-evaluator.mjs");

// Build a map from proof-file path -> sha256(content) for every file
// under <missionPath>/validation/proofs/**/*. Used to assert that the
// critic leaves the proof bundles untouched.
function proofBundleSnapshot(missionPath) {
  const root = join(missionPath, "validation", "proofs");
  const out = {};
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const s = statSync(abs);
      if (s.isDirectory()) walk(abs);
      else out[abs] = fileSha256(abs);
    }
  }
  try { walk(root); } catch { /* no proofs */ }
  return out;
}

function runCritic(fx) {
  const r = spawnSync(process.execPath, [CRITIC, fx.missionPath], {
    encoding: "utf8",
    env: fixtureEnv(fx),
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* ignore */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

test("critic Stage B is non-destructive — two runs produce identical state", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  const hashBefore = fileSha256(fx.valStatePath);
  const proofsBefore = proofBundleSnapshot(fx.missionPath);

  const run1 = runCritic(fx);
  assert.equal(run1.code, 0, `first critic run failed:\n${run1.stdout}\n${run1.stderr}`);
  assert.equal(run1.json?.verdict, "PASS", `expected PASS, got ${run1.json?.verdict}`);
  const passed1 = run1.json.counts.passed;

  const hashAfterRun1 = fileSha256(fx.valStatePath);
  assert.equal(
    hashAfterRun1,
    hashBefore,
    "validation-state.json was mutated by critic Stage B — the spot-check must not write.",
  );

  // v0.8.1 D2 regression: proof bundles under validation/proofs/<id>/
  // must be byte-identical after Stage B re-exec. Pre-fix, writeProofBundle
  // ran BEFORE the CRITIC_SPOT_CHECK gate and overwrote stdout/stderr/meta;
  // Stage A on a subsequent run then observed hash-mismatches.
  const proofsAfterRun1 = proofBundleSnapshot(fx.missionPath);
  for (const [p, before] of Object.entries(proofsBefore)) {
    assert.equal(
      proofsAfterRun1[p], before,
      `proof file ${p} was rewritten by critic Stage B — writeProofBundle must be gated BEFORE the CRITIC_SPOT_CHECK early-return`,
    );
  }

  const run2 = runCritic(fx);
  assert.equal(run2.code, 0, `second critic run failed:\n${run2.stdout}\n${run2.stderr}`);
  assert.equal(run2.json?.verdict, "PASS");
  const passed2 = run2.json.counts.passed;

  assert.equal(passed2, passed1,
    `critic idempotency violated: run1 passed=${passed1}, run2 passed=${passed2}`);

  const hashAfterRun2 = fileSha256(fx.valStatePath);
  assert.equal(hashAfterRun2, hashBefore,
    "validation-state.json diverged between critic runs (byte-for-byte mismatch)");

  const proofsAfterRun2 = proofBundleSnapshot(fx.missionPath);
  for (const [p, before] of Object.entries(proofsBefore)) {
    assert.equal(
      proofsAfterRun2[p], before,
      `proof file ${p} drifted across two critic runs (Stage B idempotency violation)`,
    );
  }
});

test("executeAssertionReadOnly direct import does not write validation-state or proofs", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  const hashBefore = fileSha256(fx.valStatePath);
  const proofsBefore = proofBundleSnapshot(fx.missionPath);

  // Dynamic import so the test stays in node:test with no build step.
  // Use a fresh module graph per test by appending a throwaway query param.
  const mod = await import(join(PLUGIN_ROOT, "scripts/execute-assertion.mjs") + `?t=${Date.now()}`);
  assert.equal(typeof mod.executeAssertionReadOnly, "function",
    "execute-assertion.mjs must export executeAssertionReadOnly");

  const prevWd = process.env.CLAUDE_WORKING_DIR;
  process.env.CLAUDE_WORKING_DIR = fx.workingDir;
  try {
    const result = mod.executeAssertionReadOnly(fx.missionPath, { id: fx.assertionIds[0] });
    assert.ok(result, "executeAssertionReadOnly must return a result");
    assert.equal(result.spotCheckOnly, true,
      "executeAssertionReadOnly result must carry spotCheckOnly: true");
  } finally {
    if (prevWd === undefined) delete process.env.CLAUDE_WORKING_DIR;
    else process.env.CLAUDE_WORKING_DIR = prevWd;
  }

  assert.equal(fileSha256(fx.valStatePath), hashBefore,
    "executeAssertionReadOnly mutated validation-state.json");
  const proofsAfter = proofBundleSnapshot(fx.missionPath);
  for (const [p, before] of Object.entries(proofsBefore)) {
    assert.equal(proofsAfter[p], before,
      `executeAssertionReadOnly rewrote proof file ${p}`);
  }
});

test("critic Stage B still runs re-execution — not skipped entirely", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  const r = runCritic(fx);
  assert.equal(r.code, 0);
  assert.ok(
    r.json?.stageB?.reExecuted >= 1,
    `expected Stage B to re-execute at least one assertion, got ${JSON.stringify(r.json?.stageB)}`,
  );
  assert.equal(r.json?.stageB?.divergences, 0);
});
