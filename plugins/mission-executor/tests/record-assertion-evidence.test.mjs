// Defect 4 regression test: --evidence propagation.
//
// The handoff author observed cases where a subsequent record-assertion
// invocation's --evidence string did not replace the previously-recorded
// value. The code at record-assertion.mjs:155 ("if (evidence) entry.evidence
// = evidence;") SHOULD overwrite when evidence is non-empty. This test
// pins the behavior so any future regression is caught deterministically.
//
// Also verifies that recording --status=passed without --evidence emits a
// stderr warning — stale evidence should never be silent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGreenMission, fixtureEnv, PLUGIN_ROOT } from "./_mission-fixture.mjs";

const RECORD = join(PLUGIN_ROOT, "scripts/record-assertion.mjs");

function runRecord(fx, args, extraEnv = {}) {
  const flags = Object.entries(args).map(([k, v]) => `--${k}=${v}`);
  return spawnSync(process.execPath, [RECORD, fx.missionPath, ...flags], {
    encoding: "utf8",
    env: fixtureEnv(fx, { MISSION_EXECUTOR_WRITER: "1", ...extraEnv }),
  });
}

function readVal(fx) {
  return JSON.parse(readFileSync(fx.valStatePath, "utf8"));
}

test("--evidence replaces prior value on second passed-record", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  // Re-record VAL-TEST-001 with evidence "A"
  const proofDir = join(fx.missionPath, ".omc", "validation", "proofs", "VAL-TEST-001");
  const r1 = runRecord(fx, {
    id: "VAL-TEST-001",
    status: "passed",
    evidence: "first-evidence-A",
    "commit-sha": fx.headSha,
    "tool-type": "cli-binary",
    command: "test -e hello.txt",
    "exit-code": "0",
    "stdout-path": join(proofDir, "stdout.txt"),
    "stderr-path": join(proofDir, "stderr.txt"),
    touchpoints: "tree:hello.txt",
  });
  assert.equal(r1.status, 0, `record A failed:\n${r1.stdout}\n${r1.stderr}`);
  assert.equal(readVal(fx).assertions["VAL-TEST-001"].evidence, "first-evidence-A");

  // Re-record with evidence "B"
  const r2 = runRecord(fx, {
    id: "VAL-TEST-001",
    status: "passed",
    evidence: "second-evidence-B",
    "commit-sha": fx.headSha,
    "tool-type": "cli-binary",
    command: "test -e hello.txt",
    "exit-code": "0",
    "stdout-path": join(proofDir, "stdout.txt"),
    "stderr-path": join(proofDir, "stderr.txt"),
    touchpoints: "tree:hello.txt",
  });
  assert.equal(r2.status, 0, `record B failed:\n${r2.stdout}\n${r2.stderr}`);

  const finalEvidence = readVal(fx).assertions["VAL-TEST-001"].evidence;
  assert.equal(finalEvidence, "second-evidence-B",
    `evidence was not replaced: got '${finalEvidence}', expected 'second-evidence-B'`);
});

test("--evidence omitted on passed-record preserves prior evidence and emits WARN", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  const proofDir = join(fx.missionPath, ".omc", "validation", "proofs", "VAL-TEST-001");
  // Omit --evidence
  const r = runRecord(fx, {
    id: "VAL-TEST-001",
    status: "passed",
    "commit-sha": fx.headSha,
    "tool-type": "cli-binary",
    command: "test -e hello.txt",
    "exit-code": "0",
    "stdout-path": join(proofDir, "stdout.txt"),
    "stderr-path": join(proofDir, "stderr.txt"),
    touchpoints: "tree:hello.txt",
  });
  assert.equal(r.status, 0, `record failed:\n${r.stdout}\n${r.stderr}`);

  // Evidence from fixture ("tool='shell+test' exit=0") should be preserved.
  const ev = readVal(fx).assertions["VAL-TEST-001"].evidence;
  assert.ok(ev && ev.includes("shell+test"),
    `prior evidence was lost when --evidence omitted: got ${JSON.stringify(ev)}`);

  assert.match(r.stderr, /record-assertion.*warn.*--evidence/i,
    `expected stderr warning when --status=passed recorded without --evidence; got: ${JSON.stringify(r.stderr)}`);
});

test("--evidence flag does not affect non-passed status writes", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  const r = runRecord(fx, {
    id: "VAL-TEST-001",
    status: "failed",
    evidence: "explicit-fail-reason",
  });
  assert.equal(r.status, 0);
  const entry = readVal(fx).assertions["VAL-TEST-001"];
  assert.equal(entry.status, "failed");
  assert.equal(entry.evidence, "explicit-fail-reason");
  // Non-passed must clear stale proof block.
  assert.equal(entry.proof, undefined);
});
