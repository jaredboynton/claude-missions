// Single-repo assumption test (0.6.0).
//
// Droid convention: a mission has exactly one working_directory.txt pointing
// at exactly one git repo. Cross-repo coordination requires multiple
// missions. This test pins that assumption by asserting:
//   1. execute-assertion ignores process.cwd() — it reads working_directory.txt
//   2. Proof bundles land under missionPath regardless of where the process runs
//   3. The proof schema carries no repo-identity fields (no commitSha, no
//      childRepo) that would imply cross-repo awareness

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { buildGreenMission, fixtureEnv, PLUGIN_ROOT } from "./_mission-fixture.mjs";

const EXECUTE = join(PLUGIN_ROOT, "scripts/execute-assertion.mjs");

test("execute-assertion uses working_directory.txt, not process.cwd()", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  // Flip one assertion back to pending so execute-assertion actually runs.
  const vsPath = fx.valStatePath;
  const vs = JSON.parse(readFileSync(vsPath, "utf8"));
  const id = fx.assertionIds[0];
  vs.assertions[id].status = "pending";
  delete vs.assertions[id].proof;
  writeFileSync(vsPath, JSON.stringify(vs, null, 2) + "\n");

  // Run from a completely unrelated cwd. The test file resolves hello.txt
  // as "test -e hello.txt" — relative to workingDir, not the process cwd.
  const unrelatedCwd = mkdtempSync(join(tmpdir(), "unrelated-"));
  t.after(() => { try { rmSync(unrelatedCwd, { recursive: true, force: true }); } catch {} });

  const r = spawnSync(process.execPath, [EXECUTE, fx.missionPath, `--id=${id}`], {
    encoding: "utf8",
    cwd: unrelatedCwd,
    env: fixtureEnv(fx),
  });
  assert.equal(r.status, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);

  // Proof bundle landed in missionDir — not cwd.
  assert.ok(existsSync(join(fx.missionPath, "validation", "proofs", id, "stdout.txt")));
  assert.ok(!existsSync(join(unrelatedCwd, "validation", "proofs", id, "stdout.txt")));
});

test("proof schema carries no cross-repo fields (commitSha / childRepo dropped)", async (t) => {
  const fx = buildGreenMission();
  t.after(() => fx.cleanup());

  const vs = JSON.parse(readFileSync(fx.valStatePath, "utf8"));
  const id = fx.assertionIds[0];
  vs.assertions[id].status = "pending";
  delete vs.assertions[id].proof;
  writeFileSync(fx.valStatePath, JSON.stringify(vs, null, 2) + "\n");

  const r = spawnSync(process.execPath, [EXECUTE, fx.missionPath, `--id=${id}`], {
    encoding: "utf8",
    env: fixtureEnv(fx),
  });
  assert.equal(r.status, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);

  const proof = JSON.parse(readFileSync(fx.valStatePath, "utf8")).assertions[id].proof;
  assert.ok(proof, "proof not written");
  assert.equal(proof.commitSha, undefined, "0.6.0 proofs must not carry commitSha");
  assert.equal(proof.childRepo, undefined, "0.6.0 proofs must not carry childRepo");
});

test("no mission-executor script imports meta-repo.mjs (helper deleted)", async () => {
  // Grep equivalent — walk scripts/ for any `meta-repo` import. Hard failure
  // if someone re-adds it, since meta-repo awareness is structurally
  // incompatible with the 0.6.0 single-repo model.
  const { readdirSync } = await import("node:fs");
  const scriptsDir = join(PLUGIN_ROOT, "scripts");
  const visited = new Set();
  function walk(d) {
    if (visited.has(d)) return;
    visited.add(d);
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) {
        const src = readFileSync(full, "utf8");
        assert.ok(!/from\s+["']\.[/\w-]*meta-repo/.test(src),
          `${full} imports meta-repo.mjs — which was deleted in 0.6.0`);
      }
    }
  }
  walk(scriptsDir);
});

test("critic-evaluator does not run any git command (execSync removed)", async () => {
  const src = readFileSync(join(PLUGIN_ROOT, "scripts/critic-evaluator.mjs"), "utf8");
  // Strip comments so the 0.6.0 design note doesn't trip the check.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/\bexecSync\s*\(/.test(code),
    "critic-evaluator.mjs must not call execSync in 0.6.0 — no git ancestry");
  assert.ok(!/merge-base|is-ancestor/.test(code),
    "critic-evaluator.mjs must not reference git ancestry in 0.6.0");
});
