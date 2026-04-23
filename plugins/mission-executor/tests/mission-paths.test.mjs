// Unit tests for scripts/_lib/mission-paths.mjs (0.6.0).
//
// These are trivial path joiners, but pinning them means future callers
// can't accidentally re-anchor a path to layoutRoot() and re-introduce the
// "proofs live in the workingDir" problem that 0.6.0 just fixed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  validationDir, proofsDir, proofStdoutPath, proofStderrPath, proofMetaPath,
  handoffsDir, progressLogPath, workingDirectoryPath,
  featuresPath, validationStatePath, validationContractPath, statePath,
  relativeProofPath,
} from "../scripts/_lib/mission-paths.mjs";

const MP = "/tmp/mission-fixture/mis_abc";

test("every path is anchored at missionPath (absolute missionPath)", () => {
  assert.equal(validationDir(MP), join(MP, "validation"));
  assert.equal(proofsDir(MP, "VAL-X-001"), join(MP, "validation/proofs/VAL-X-001"));
  assert.equal(proofStdoutPath(MP, "VAL-X-001"), join(MP, "validation/proofs/VAL-X-001/stdout.txt"));
  assert.equal(proofStderrPath(MP, "VAL-X-001"), join(MP, "validation/proofs/VAL-X-001/stderr.txt"));
  assert.equal(proofMetaPath(MP, "VAL-X-001"), join(MP, "validation/proofs/VAL-X-001/meta.json"));
  assert.equal(handoffsDir(MP), join(MP, "handoffs"));
  assert.equal(progressLogPath(MP), join(MP, "progress_log.jsonl"));
  assert.equal(workingDirectoryPath(MP), join(MP, "working_directory.txt"));
  assert.equal(featuresPath(MP), join(MP, "features.json"));
  assert.equal(validationStatePath(MP), join(MP, "validation-state.json"));
  assert.equal(validationContractPath(MP), join(MP, "validation-contract.md"));
  assert.equal(statePath(MP), join(MP, "state.json"));
});

test("relativeProofPath returns a missionPath-relative string (no absolute anchor)", () => {
  assert.equal(relativeProofPath("VAL-X-001", "stdout"), "validation/proofs/VAL-X-001/stdout.txt");
  assert.equal(relativeProofPath("VAL-X-001", "stderr"), "validation/proofs/VAL-X-001/stderr.txt");
});

test("no helper uses layoutRoot() or process.env — paths are pure functions of missionPath", async () => {
  // Strip comments before grepping so the prose in the module header doesn't
  // trip the check. If any live code re-couples to the project-scoped layout
  // cache, that's a regression.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join: pJoin } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(pJoin(here, "../scripts/_lib/mission-paths.mjs"), "utf8");
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")   // strip /* ... */ blocks
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // strip // line comments (but keep http://)
  assert.ok(!code.includes("hooks/_lib/paths"), "mission-paths.mjs must not import from hooks/_lib/paths.mjs");
  assert.ok(!/\blayoutRoot\s*\(/.test(code), "mission-paths.mjs must not call layoutRoot()");
  assert.ok(!code.includes("process.env"), "mission-paths.mjs must not read process.env");
});

test("handles missionPath with trailing slashes idempotently", () => {
  const mpTrail = "/tmp/mission-fixture/mis_abc/";
  // join() normalizes trailing slashes. Both forms should produce the same result.
  assert.equal(proofsDir(mpTrail, "VAL-X"), proofsDir(MP, "VAL-X"));
});
