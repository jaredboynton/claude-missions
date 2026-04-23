// v0.8.1 D3/D4 regression tests for scripts/validate-schema.mjs.
//
// D3 hook: "blocked" must be accepted as a valid assertion status.
// D4 hook: summarize() must emit one message per entry (not a
//          cross-mission roll-up), and harmless drift warnings must
//          route into an `infos` bucket, not `warnings`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateMissionSchema } from "../scripts/validate-schema.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function scaffoldMission({ assertions, features, missionState = "running", workingDir, completedRef = null }) {
  const root = mkdtempSync(join(tmpdir(), "mex-vs-"));
  const missionPath = join(root, "abc12345");
  mkdirSync(missionPath, { recursive: true });
  const wd = workingDir || join(root, "work");
  mkdirSync(wd, { recursive: true });
  writeFileSync(join(missionPath, "working_directory.txt"), wd);

  const state = {
    missionId: "abc12345",
    state: missionState,
    workingDirectory: wd,
    createdAt: "2026-04-22T00:00:00Z",
    updatedAt: "2026-04-22T00:00:00Z",
    lastReviewedHandoffCount: 0,
  };
  writeFileSync(join(missionPath, "state.json"), JSON.stringify(state, null, 2));

  writeFileSync(join(missionPath, "features.json"),
    JSON.stringify({ features }, null, 2));

  writeFileSync(join(missionPath, "validation-state.json"),
    JSON.stringify({ assertions }, null, 2));

  return {
    missionPath,
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch {} },
  };
}

test("blocked is accepted as a valid assertion status (no error emitted)", (t) => {
  const fx = scaffoldMission({
    assertions: {
      "VAL-A-001": { status: "blocked", evidence: "narrative-only" },
      "VAL-A-002": { status: "pending" },
    },
    features: [{
      id: "F-001", description: "d", skillName: "s",
      preconditions: [], expectedBehavior: [], verificationSteps: [],
      milestone: "M1", status: "pending", workerSessionIds: [],
      fulfills: ["VAL-A-001", "VAL-A-002"],
    }],
  });
  t.after(() => fx.cleanup());

  const r = validateMissionSchema(fx.missionPath);
  const blockedErrors = r.errors.filter((e) => /invalid status 'blocked'/.test(e));
  assert.equal(blockedErrors.length, 0,
    `blocked must not be rejected; errors: ${JSON.stringify(r.errors)}`);
  assert.equal(r.metrics.assertionStatuses.blocked, 1,
    "blocked count must appear in metrics.assertionStatuses");
});

test("warnings emit one message per entry (no 'across N mission(s)' roll-up)", (t) => {
  // Two assertions with missing proof -> should emit TWO warning lines,
  // not a single "2 passed assertions are missing `proof`" summary.
  const fx = scaffoldMission({
    assertions: {
      "VAL-A-001": { status: "passed", validatedAtMilestone: "M1" }, // no proof
      "VAL-A-002": { status: "passed", validatedAtMilestone: "M1" }, // no proof
    },
    features: [{
      id: "F-001", description: "d", skillName: "s",
      preconditions: [], expectedBehavior: [], verificationSteps: [],
      milestone: "M1", status: "completed", workerSessionIds: [],
      fulfills: ["VAL-A-001", "VAL-A-002"],
    }],
  });
  t.after(() => fx.cleanup());

  const r = validateMissionSchema(fx.missionPath);
  const proofWarnings = r.warnings.filter((w) => /missing a `proof` block/.test(w));
  assert.equal(proofWarnings.length, 2,
    `expected per-entry emission (2 warnings), got: ${JSON.stringify(proofWarnings)}`);
  for (const w of proofWarnings) {
    assert.doesNotMatch(w, /across \d+ mission/,
      `no 'across N mission(s)' fan-out should remain: ${w}`);
    assert.match(w, /missions\/[^\s/]+\/VAL-A-00\d/,
      `per-entry message must name the assertion id: ${w}`);
  }
});

test("missingValidatedAt / orphan / unresolved-session-refs go to infos, not warnings", (t) => {
  // One passed assertion with proof but NO validatedAtMilestone (missingValidatedAt)
  // PLUS an orphan assertion not fulfilled by any feature.
  const fx = scaffoldMission({
    assertions: {
      "VAL-A-001": {
        status: "passed",
        proof: {
          toolType: "cli-binary", command: "true", exitCode: 0,
          stdoutPath: "v/p/VAL-A-001/stdout.txt", stderrPath: "v/p/VAL-A-001/stderr.txt",
          stdoutSha256: "x", stderrSha256: "y",
          touchpoints: ["x"], executedAt: "2026-04-22T00:00:00Z",
          executor: "execute-assertion.mjs",
        },
        // validatedAtMilestone intentionally omitted -> goes to infos.
      },
      "VAL-ORPHAN-001": { status: "pending" }, // not in any feature.fulfills
    },
    features: [{
      id: "F-001", description: "d", skillName: "s",
      preconditions: [], expectedBehavior: [], verificationSteps: [],
      milestone: "M1", status: "completed", workerSessionIds: [],
      fulfills: ["VAL-A-001"],
    }],
  });
  t.after(() => fx.cleanup());

  const r = validateMissionSchema(fx.missionPath);
  assert.ok(Array.isArray(r.infos), "validateMissionSchema must return an `infos` bucket");

  const hasOrphanInInfos = r.infos.some((m) => /VAL-ORPHAN-001/.test(m) && /orphan/.test(m));
  const hasOrphanInWarnings = r.warnings.some((m) => /VAL-ORPHAN-001/.test(m));
  assert.ok(hasOrphanInInfos, `orphan assertion must route to infos: ${JSON.stringify(r.infos)}`);
  assert.equal(hasOrphanInWarnings, false, "orphan assertion must NOT be in warnings");

  const hasMissingValidatedAtInInfos = r.infos.some(
    (m) => /VAL-A-001/.test(m) && /validatedAtMilestone/.test(m));
  const hasMissingValidatedAtInWarnings = r.warnings.some(
    (m) => /VAL-A-001/.test(m) && /validatedAtMilestone/.test(m));
  assert.ok(hasMissingValidatedAtInInfos,
    `missingValidatedAtMilestone must route to infos: ${JSON.stringify(r.infos)}`);
  assert.equal(hasMissingValidatedAtInWarnings, false,
    "missingValidatedAtMilestone must NOT be in warnings");
});

test("missingProof + completion-state divergence still go to warnings (trust signals)", (t) => {
  // Passed assertion with NO proof block + mission-state divergence
  // (state=completed but features not all completed).
  const fx = scaffoldMission({
    assertions: {
      "VAL-A-001": { status: "passed", validatedAtMilestone: "M1" }, // no proof
    },
    features: [{
      id: "F-001", description: "d", skillName: "s",
      preconditions: [], expectedBehavior: [], verificationSteps: [],
      milestone: "M1", status: "pending", workerSessionIds: [],
      fulfills: ["VAL-A-001"],
    }],
    missionState: "completed",
  });
  t.after(() => fx.cleanup());

  const r = validateMissionSchema(fx.missionPath);
  const hasProofInWarnings = r.warnings.some(
    (m) => /VAL-A-001/.test(m) && /missing a `proof` block/.test(m));
  assert.ok(hasProofInWarnings,
    `missingProof must stay in warnings: ${JSON.stringify(r.warnings)}`);

  const hasDivergenceInWarnings = r.warnings.some(
    (m) => /completion state diverges/.test(m));
  assert.ok(hasDivergenceInWarnings,
    `completion-state divergence must stay in warnings: ${JSON.stringify(r.warnings)}`);
});
