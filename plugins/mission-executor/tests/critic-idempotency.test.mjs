// Defect 2 regression test: running critic-evaluator.mjs twice on a
// known-green mission MUST produce identical counts.passed AND leave
// validation-state.json byte-for-byte unchanged.
//
// Pre-fix behavior (0.4.6): Stage B calls execute-assertion.mjs which
// rewrites validation-state.json on every re-run (new executedAt at
// minimum, and if the evidence string is dispatcher-unfriendly the
// previously-passed assertion flips to failed).
//
// Post-fix behavior (0.4.7): Stage B spawns the child with
// CRITIC_SPOT_CHECK=1; execute-assertion.mjs computes the verdict but
// short-circuits before recordAssertion, leaving state untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { buildGreenMission, fixtureEnv, fileSha256, PLUGIN_ROOT } from "./_mission-fixture.mjs";

const CRITIC = join(PLUGIN_ROOT, "scripts/critic-evaluator.mjs");

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

  const run2 = runCritic(fx);
  assert.equal(run2.code, 0, `second critic run failed:\n${run2.stdout}\n${run2.stderr}`);
  assert.equal(run2.json?.verdict, "PASS");
  const passed2 = run2.json.counts.passed;

  assert.equal(passed2, passed1,
    `critic idempotency violated: run1 passed=${passed1}, run2 passed=${passed2}`);

  const hashAfterRun2 = fileSha256(fx.valStatePath);
  assert.equal(hashAfterRun2, hashBefore,
    "validation-state.json diverged between critic runs (byte-for-byte mismatch)");
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
