// Stage B safety test for the 0.7.0 recognizer broadening.
//
// The critic's Stage B re-executes a sample of passed assertions with
// CRITIC_SPOT_CHECK=1 set to keep the run non-destructive. The 0.7.0 wiring
// ALSO uses that same env var to skip recognizers so Stage B never sees a
// recognizer-emitted command — Stage B must verify existing passes with
// the same logic that produced them. This file proves that invariant
// holds:
//
//   1. Build a mission whose passed assertion's evidence WOULD match a
//      recognizer. The recognizer-emitted plan WOULD fail (one of its
//      expanded commands points at a file that doesn't exist).
//   2. The basic single-command extractor (tryExtract) on the SAME evidence
//      picks a different command that DOES pass — this is the "critic
//      verifies with the same logic that produced the original pass"
//      condition.
//   3. Run critic-evaluator.mjs twice. Both runs must produce verdict=PASS
//      with stageB.divergences=0 and identical counts — no Math.random
//      flicker from sample shuffling (only one passed assertion; sample
//      size = 1; always selected).
//
// If the gate is ever removed or broken, this test fails: Stage B routes
// through the recognizer, picks up the failing brace-expanded command, and
// flips the verdict to FAIL. That is exactly what the gate exists to
// prevent.
//
// A third "control" test spawns execute-assertion.mjs directly with
// CRITIC_SPOT_CHECK UNSET against a copy of the fixture to confirm that
// the recognizer actually WOULD fail outside the gate. This proves the
// test setup meaningfully exercises the gate rather than passing
// trivially.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import { PLUGIN_ROOT, fixtureEnv, fileSha256 } from "./_mission-fixture.mjs";

const CRITIC = join(PLUGIN_ROOT, "scripts/critic-evaluator.mjs");
const EXECUTE = join(PLUGIN_ROOT, "scripts/execute-assertion.mjs");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// Build a mission with ONE passed assertion whose evidence satisfies:
//
//   (a) Recognizer-parseable: the compound-AND recognizer emits two
//       commands, the second pointing at a file that does NOT exist in
//       the working dir. Recognizer-path outcome = failed.
//   (b) tryExtract-parseable: the basic extractor picks the FIRST backticked
//       runnable command and stops. That command points at a file that
//       DOES exist. tryExtract-path outcome = passed.
//
// Without the gate: Stage B spawns execute-assertion, runs recognizer,
// fails, flags divergence.
// With the gate: Stage B spawns execute-assertion, skips recognizer, runs
// tryExtract on the same evidence, passes, no divergence.
function buildGatedMission() {
  const root = mkdtempSync(join(tmpdir(), "mex-gate-"));
  const workingDir = join(root, "work");
  const missionPath = join(root, "mission");
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(missionPath, { recursive: true });

  // Only hello.txt exists. The second command in the evidence
  // (`test -e bogus-never-exists.txt`) will fail if actually run.
  writeFileSync(join(workingDir, "hello.txt"), "hi\n");

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
  execSync("git init -q -b main", { cwd: workingDir, env });
  execSync("git add -A", { cwd: workingDir, env });
  execSync("git commit -qm init", { cwd: workingDir, env });

  writeFileSync(join(missionPath, "working_directory.txt"), workingDir);
  writeFileSync(join(missionPath, "features.json"),
    JSON.stringify({ features: [] }, null, 2) + "\n");

  const id = "VAL-GATE-001";
  const title = "gate-sensitive evidence";
  const contractBody = [
    `### ${id}: ${title}`,
    "Tool: `shell+test`",
    "Evidence: `test -e hello.txt` AND `test -e bogus-never-exists.txt` — both expected to exit 0.",
    "",
  ].join("\n");
  writeFileSync(join(missionPath, "validation-contract.md"),
    ["## Validation", "", contractBody].join("\n"));

  // Manually-recorded `passed` proof. The command field records what the
  // original run executed (just the first single command, as if an older
  // run wrote it). Stdout/stderr artifacts are empty, hashes match.
  const proofDir = join(missionPath, "validation", "proofs", id);
  mkdirSync(proofDir, { recursive: true });
  const stdoutContent = "";
  const stderrContent = "";
  writeFileSync(join(proofDir, "stdout.txt"), stdoutContent);
  writeFileSync(join(proofDir, "stderr.txt"), stderrContent);
  const recordedCommand =
    "# tool=shell+test (shell-generic dispatch)\ntest -e hello.txt";
  writeFileSync(join(proofDir, "meta.json"), JSON.stringify({
    id, toolType: "cli-binary", command: recordedCommand, exitCode: 0,
    expected: "tool='shell+test' exit=0",
    executedAt: new Date().toISOString(),
  }, null, 2) + "\n");

  const valState = {
    assertions: {
      [id]: {
        status: "passed",
        validatedAtMilestone: "M1",
        evidence: "tool='shell+test' exit=0",
        proof: {
          toolType: "cli-binary",
          command: recordedCommand,
          exitCode: 0,
          stdoutPath: join("validation", "proofs", id, "stdout.txt"),
          stderrPath: join("validation", "proofs", id, "stderr.txt"),
          stdoutSha256: sha256(stdoutContent),
          stderrSha256: sha256(stderrContent),
          touchpoints: ["tree:hello.txt"],
          executedAt: new Date().toISOString(),
          executor: "execute-assertion.mjs",
        },
      },
    },
  };
  const valStatePath = join(missionPath, "validation-state.json");
  writeFileSync(valStatePath, JSON.stringify(valState, null, 2) + "\n");

  return {
    root, missionPath, workingDir, valStatePath,
    assertionId: id,
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch {} },
  };
}

function runCritic(fx) {
  const r = spawnSync(
    process.execPath, [CRITIC, fx.missionPath],
    {
      encoding: "utf8",
      env: fixtureEnv(fx),
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

test("critic Stage B with gate: recognizer-parseable passed assertion does not flip verdict", async (t) => {
  const fx = buildGatedMission();
  t.after(() => fx.cleanup());

  const hashBefore = fileSha256(fx.valStatePath);

  const r = runCritic(fx);
  assert.equal(
    r.code, 0,
    `expected PASS exit, got ${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`,
  );
  assert.equal(r.json?.verdict, "PASS");
  assert.equal(r.json?.stageB?.divergences, 0,
    `Stage B divergences > 0 means the gate leaked: ${r.stdout}`);
  assert.ok(
    (r.json?.stageB?.reExecuted ?? 0) >= 1,
    `Stage B must actually re-execute the assertion to prove the gate; reExecuted=${r.json?.stageB?.reExecuted}`,
  );

  const hashAfter = fileSha256(fx.valStatePath);
  assert.equal(hashAfter, hashBefore,
    "validation-state.json was mutated by Stage B (CRITIC_SPOT_CHECK wasn't honored)");
});

test("critic Stage B with gate: two consecutive runs produce identical verdicts (no flicker)", async (t) => {
  const fx = buildGatedMission();
  t.after(() => fx.cleanup());

  const r1 = runCritic(fx);
  const r2 = runCritic(fx);

  assert.equal(r1.code, 0);
  assert.equal(r2.code, 0);
  assert.equal(r1.json?.verdict, "PASS");
  assert.equal(r2.json?.verdict, "PASS");
  assert.deepEqual(
    r1.json?.counts, r2.json?.counts,
    `counts diverged between runs: ${JSON.stringify(r1.json?.counts)} vs ${JSON.stringify(r2.json?.counts)}`,
  );
  assert.equal(r1.json?.stageB?.divergences, 0);
  assert.equal(r2.json?.stageB?.divergences, 0);
});

test("control: WITHOUT the gate, recognizer emits failing commands on the same evidence", async (t) => {
  // Proves our setup meaningfully exercises the gate: remove
  // CRITIC_SPOT_CHECK and the exact same evidence, run through the
  // recognizer path, produces status=failed. If this test ever starts
  // passing (exit 0), our gated-mission fixture has lost the property
  // we built it around and the safety tests above are trivial.
  //
  // Runs against a COPY of the fixture so the main critic-run state is
  // untouched.
  const fx = buildGatedMission();
  t.after(() => fx.cleanup());

  const copyRoot = mkdtempSync(join(tmpdir(), "mex-gate-copy-"));
  t.after(() => { try { rmSync(copyRoot, { recursive: true, force: true }); } catch {} });
  cpSync(fx.root, copyRoot, { recursive: true });
  const copyMission = join(copyRoot, "mission");
  // Re-point working_directory.txt to the copy's work dir.
  writeFileSync(join(copyMission, "working_directory.txt"),
    join(copyRoot, "work"));

  const env = { ...fixtureEnv(fx) };
  delete env.CRITIC_SPOT_CHECK;

  const r = spawnSync(
    process.execPath,
    [EXECUTE, copyMission, `--id=${fx.assertionId}`],
    {
      encoding: "utf8",
      env,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}

  assert.notEqual(
    r.status, 0,
    `without the gate, recognizer should emit a plan that fails; instead got exit 0\nstdout=${r.stdout}\nstderr=${r.stderr}`,
  );
  assert.equal(json?.status, "failed",
    `expected status=failed outside the gate, got ${JSON.stringify(json?.status)}`);
});
