// Legacy 0.5.x -> 0.6.0 proof migration tests.
//
// In 0.5.x, proofs were tagged with commitSha + optionally childRepo, and
// proof files lived under <workingDir>/.mission-executor/validation/ or
// <workingDir>/.omc/validation/. 0.6.0 strips the deprecated fields,
// relocates files into the mission dir, and rewrites stored paths to
// be missionDir-relative.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { upgradeLegacy052Proofs } from "../scripts/_lib/migrate.mjs";

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function build052Mission({ proofLocation = "mission-executor" } = {}) {
  // proofLocation: "mission-executor" | "omc" | "missing"
  const root = mkdtempSync(join(tmpdir(), "mex-052-"));
  const workingDir = join(root, "work");
  const missionPath = join(root, "mission");
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(missionPath, { recursive: true });

  writeFileSync(join(missionPath, "working_directory.txt"), workingDir);

  // Write proof files at the 0.5.x location, if any.
  const legacyRel = proofLocation === "omc"
    ? ".omc/validation/proofs"
    : ".mission-executor/validation/proofs";
  const legacyDir = join(workingDir, legacyRel, "VAL-TEST-001");
  const stdoutContent = "";
  const stderrContent = "";
  if (proofLocation !== "missing") {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "stdout.txt"), stdoutContent);
    writeFileSync(join(legacyDir, "stderr.txt"), stderrContent);
  }

  const proof = {
    // 0.5.x fields:
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    childRepo: proofLocation === "omc" ? "cse-tools" : null,
    toolType: "cli-binary",
    command: "test -e hello.txt",
    exitCode: 0,
    stdoutPath: join(legacyRel, "VAL-TEST-001", "stdout.txt"),
    stderrPath: join(legacyRel, "VAL-TEST-001", "stderr.txt"),
    stdoutSha256: sha256(stdoutContent),
    stderrSha256: sha256(stderrContent),
    touchpoints: ["tree:hello.txt"],
    executedAt: new Date().toISOString(),
    executor: "execute-assertion.mjs",
  };
  // Drop null childRepo for cleanliness (matches how 0.5.x actually wrote it).
  if (proof.childRepo === null) delete proof.childRepo;

  writeFileSync(join(missionPath, "validation-state.json"), JSON.stringify({
    assertions: { "VAL-TEST-001": { status: "passed", evidence: "e", proof } },
  }, null, 2) + "\n");

  return {
    root, workingDir, missionPath,
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch {} },
  };
}

function readProof(missionPath) {
  const vs = JSON.parse(readFileSync(join(missionPath, "validation-state.json"), "utf8"));
  return vs.assertions["VAL-TEST-001"].proof;
}

test("0.5.x proof at .mission-executor/validation/ migrates cleanly", async (t) => {
  const fx = build052Mission({ proofLocation: "mission-executor" });
  t.after(() => fx.cleanup());

  const r = upgradeLegacy052Proofs(fx.missionPath);
  assert.equal(r.migrated, 1);
  assert.equal(r.invalidated, 0);

  // Bundle files moved into mission dir.
  assert.ok(existsSync(join(fx.missionPath, "validation/proofs/VAL-TEST-001/stdout.txt")));
  assert.ok(existsSync(join(fx.missionPath, "validation/proofs/VAL-TEST-001/stderr.txt")));
  // Original location emptied (file was renamed, not copied).
  assert.ok(!existsSync(join(fx.workingDir, ".mission-executor/validation/proofs/VAL-TEST-001/stdout.txt")));

  // Deprecated fields stripped, new paths are missionDir-relative.
  const proof = readProof(fx.missionPath);
  assert.equal(proof.commitSha, undefined);
  assert.equal(proof.childRepo, undefined);
  assert.equal(proof.stdoutPath, "validation/proofs/VAL-TEST-001/stdout.txt");
  assert.equal(proof.stderrPath, "validation/proofs/VAL-TEST-001/stderr.txt");
  // Hashes preserved.
  assert.equal(proof.stdoutSha256, sha256(""));
});

test("0.5.x proof at .omc/validation/ migrates too (legacy OMC users)", async (t) => {
  const fx = build052Mission({ proofLocation: "omc" });
  t.after(() => fx.cleanup());

  const r = upgradeLegacy052Proofs(fx.missionPath);
  assert.equal(r.migrated, 1);
  assert.ok(existsSync(join(fx.missionPath, "validation/proofs/VAL-TEST-001/stdout.txt")));
  const proof = readProof(fx.missionPath);
  assert.equal(proof.childRepo, undefined, "childRepo must be dropped");
});

test("0.5.x proof with MISSING bundle files -> invalidated to pending", async (t) => {
  const fx = build052Mission({ proofLocation: "missing" });
  t.after(() => fx.cleanup());

  const r = upgradeLegacy052Proofs(fx.missionPath);
  assert.equal(r.migrated, 0);
  assert.equal(r.invalidated, 1);

  const vs = JSON.parse(readFileSync(join(fx.missionPath, "validation-state.json"), "utf8"));
  const entry = vs.assertions["VAL-TEST-001"];
  assert.equal(entry.status, "pending");
  assert.equal(entry.proof, undefined);
});

test("migration is idempotent — second call is a no-op", async (t) => {
  const fx = build052Mission();
  t.after(() => fx.cleanup());

  upgradeLegacy052Proofs(fx.missionPath);
  const r2 = upgradeLegacy052Proofs(fx.missionPath);
  assert.equal(r2.migrated, 0, "second call should find no deprecated fields");
  assert.equal(r2.invalidated, 0);
});

test("0.6.0 proof (no deprecated fields, new paths) is left untouched", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mex-060-"));
  const missionPath = join(root, "mission");
  mkdirSync(missionPath, { recursive: true });
  mkdirSync(join(missionPath, "validation/proofs/VAL-X"), { recursive: true });
  writeFileSync(join(missionPath, "validation/proofs/VAL-X/stdout.txt"), "");
  writeFileSync(join(missionPath, "validation/proofs/VAL-X/stderr.txt"), "");
  writeFileSync(join(missionPath, "validation-state.json"), JSON.stringify({
    assertions: {
      "VAL-X": {
        status: "passed",
        proof: {
          toolType: "cli-binary",
          command: "true",
          exitCode: 0,
          stdoutPath: "validation/proofs/VAL-X/stdout.txt",
          stderrPath: "validation/proofs/VAL-X/stderr.txt",
          stdoutSha256: sha256(""),
          stderrSha256: sha256(""),
          touchpoints: ["tree:something"],
          executedAt: new Date().toISOString(),
          executor: "execute-assertion.mjs",
        },
      },
    },
  }, null, 2) + "\n");
  const before = readFileSync(join(missionPath, "validation-state.json"), "utf8");

  const r = upgradeLegacy052Proofs(missionPath);
  assert.equal(r.migrated, 0);
  assert.equal(r.invalidated, 0);

  const after = readFileSync(join(missionPath, "validation-state.json"), "utf8");
  assert.equal(after, before, "0.6.0 proof should not be rewritten");

  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

test("executeAssertion calls migration on entry — 0.5.x fixture upgrades transparently", async (t) => {
  const fx = build052Mission();
  t.after(() => fx.cleanup());

  // Also write the contract + features so executeAssertion can actually run.
  writeFileSync(join(fx.missionPath, "validation-contract.md"),
    ["## Validation", "", "### VAL-TEST-001: hello.txt",
      "Tool: `shell+test`", "Evidence: `test -e hello.txt` exits 0", ""].join("\n"));
  writeFileSync(join(fx.missionPath, "features.json"),
    JSON.stringify({ features: [{ id: "F-001", title: "t", description: "", fulfills: ["VAL-TEST-001"], milestone: "M1" }] }, null, 2));
  // Add a hello.txt to workingDir so the assertion can actually pass.
  writeFileSync(join(fx.workingDir, "hello.txt"), "hi\n");

  // Invoke executeAssertion via the script so migration runs on entry.
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const EXECUTE = join(here, "../scripts/execute-assertion.mjs");
  const r = spawnSync(process.execPath, [EXECUTE, fx.missionPath, "--id=VAL-TEST-001"], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: fx.workingDir },
  });
  assert.equal(r.status, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);

  const proof = readProof(fx.missionPath);
  assert.equal(proof.commitSha, undefined, "migration should have stripped commitSha");
  // After a fresh execute, the proof carries the new schema + contractSha256.
  assert.match(proof.contractSha256 || "", /^[0-9a-f]{64}$/);
});
