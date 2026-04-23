// Defect 3 regression test: cross-repo HEAD awareness.
//
// In a meta-repo workspace (a `.meta` file at root lists child repos with
// separate `.git/`), executeAssertion must tag a proof with the CHILD's
// HEAD SHA when the assertion's touchpoint routes into that child. The
// critic's Stage A ancestry check must then use the child's repo, not
// the workspace root, to resolve ancestry.
//
// Without this behavior (0.4.6 baseline) every proof produced by work
// in a child looks stale to the critic as soon as the workspace root
// advances — the child SHA is from a different history entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { PLUGIN_ROOT } from "./_mission-fixture.mjs";

const EXECUTE = join(PLUGIN_ROOT, "scripts/execute-assertion.mjs");
const CRITIC = join(PLUGIN_ROOT, "scripts/critic-evaluator.mjs");
const INVALIDATE = join(PLUGIN_ROOT, "scripts/invalidate-stale-evidence.mjs");

function gitEnv() {
  return {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
}

function gitInit(dir) {
  const env = { ...process.env, ...gitEnv() };
  execSync("git init -q -b main", { cwd: dir, env });
  execSync("git add -A", { cwd: dir, env });
  execSync("git commit -qm init", { cwd: dir, env });
  return execSync("git rev-parse HEAD", { cwd: dir, env, encoding: "utf8" }).trim();
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

// Build a meta-repo workspace:
//   <root>/
//     work/             (outer git repo, "mek-root")
//       .meta           {"projects":{"cse-tools":"..."}}
//       cse-tools/      (inner git repo with its own .git/)
//         deploy/hello.sh
//       cse-tools-internal/  (sibling with colliding prefix, NO .git/)
//         README.md
//     mission/          (features.json + contract + no proofs yet)
function buildMetaRepo({ withMeta = true, withChildGit = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mex-meta-"));
  const workingDir = join(root, "work");
  const childDir = join(workingDir, "cse-tools");
  const siblingDir = join(workingDir, "cse-tools-internal");
  const missionPath = join(root, "mission");
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(childDir, { recursive: true });
  mkdirSync(join(childDir, "deploy"), { recursive: true });
  mkdirSync(siblingDir, { recursive: true });
  mkdirSync(missionPath, { recursive: true });

  writeFileSync(join(childDir, "deploy", "hello.sh"), "#!/bin/sh\necho hi\n");
  writeFileSync(join(siblingDir, "README.md"), "sibling without .git/\n");

  let childHead = null;
  if (withChildGit) {
    childHead = gitInit(childDir);
  }

  if (withMeta) {
    writeFileSync(join(workingDir, ".meta"), JSON.stringify({
      projects: { "cse-tools": "child repo" },
    }));
  }
  writeFileSync(join(workingDir, "README.md"), "outer\n");

  const rootHead = gitInit(workingDir);

  writeFileSync(join(missionPath, "working_directory.txt"), workingDir);
  writeFileSync(join(missionPath, "features.json"), JSON.stringify({
    features: [
      { id: "F-001", title: "child-repo test", description: "checks `cse-tools/deploy/hello.sh`", fulfills: ["VAL-CHILD-001"], milestone: "M1" },
      { id: "F-002", title: "sibling prefix-collision test", description: "checks `cse-tools-internal/README.md`", fulfills: ["VAL-SIB-001"], milestone: "M1" },
      { id: "F-003", title: "workspace-root test", description: "checks `README.md`", fulfills: ["VAL-ROOT-001"], milestone: "M1" },
    ],
  }, null, 2) + "\n");

  const contract = [
    "## Validation",
    "",
    "### VAL-CHILD-001: hello.sh exists in child",
    "Tool: `shell+test`",
    "Evidence: `test -e cse-tools/deploy/hello.sh` exits 0",
    "",
    "### VAL-SIB-001: sibling (prefix-colliding, no .git) exists",
    "Tool: `shell+test`",
    "Evidence: `test -e cse-tools-internal/README.md` exits 0",
    "",
    "### VAL-ROOT-001: outer README exists",
    "Tool: `shell+test`",
    "Evidence: `test -e README.md` exits 0",
    "",
  ].join("\n");
  writeFileSync(join(missionPath, "validation-contract.md"), contract);
  writeFileSync(join(missionPath, "validation-state.json"),
    JSON.stringify({ assertions: {} }, null, 2) + "\n");

  return {
    root, workingDir, missionPath, childDir, rootHead, childHead,
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch {} },
  };
}

function runExecute(fx, id) {
  const r = spawnSync(process.execPath, [EXECUTE, fx.missionPath, `--id=${id}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: fx.workingDir,
      CLAUDE_WORKING_DIR: fx.workingDir,
      MISSION_EXECUTOR_LAYOUT_ROOT: join(fx.missionPath, "_layout"),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function readProof(fx, id) {
  const vs = JSON.parse(readFileSync(join(fx.missionPath, "validation-state.json"), "utf8"));
  return vs.assertions?.[id]?.proof;
}

test("child-repo touchpoint routes commitSha to child HEAD and tags childRepo", async (t) => {
  const fx = buildMetaRepo();
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-CHILD-001");
  assert.equal(r.code, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.json?.status, "passed");

  const proof = readProof(fx, "VAL-CHILD-001");
  assert.ok(proof, "proof missing");
  assert.equal(proof.childRepo, "cse-tools",
    `expected proof.childRepo=cse-tools, got ${JSON.stringify(proof.childRepo)}`);
  assert.equal(proof.commitSha, fx.childHead,
    `expected proof.commitSha=${fx.childHead} (child HEAD), got ${proof.commitSha}`);
  assert.notEqual(proof.commitSha, fx.rootHead,
    "child proof incorrectly tagged with workspace-root HEAD");
});

test("sibling with colliding prefix but no .git/ is NOT treated as child repo", async (t) => {
  const fx = buildMetaRepo();
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-SIB-001");
  assert.equal(r.code, 0);
  const proof = readProof(fx, "VAL-SIB-001");
  assert.ok(proof);
  assert.equal(proof.childRepo, undefined,
    `cse-tools-internal is not in .meta; must not be tagged as child`);
  assert.equal(proof.commitSha, fx.rootHead, "should fall back to workspace-root HEAD");
});

test("touchpoint outside .meta falls back to workspace-root HEAD", async (t) => {
  const fx = buildMetaRepo();
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-ROOT-001");
  assert.equal(r.code, 0);
  const proof = readProof(fx, "VAL-ROOT-001");
  assert.equal(proof.childRepo, undefined);
  assert.equal(proof.commitSha, fx.rootHead);
});

test("missing .meta leaves 0.4.6 behavior unchanged (no childRepo ever)", async (t) => {
  const fx = buildMetaRepo({ withMeta: false });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-CHILD-001");
  assert.equal(r.code, 0);
  const proof = readProof(fx, "VAL-CHILD-001");
  assert.equal(proof.childRepo, undefined,
    "no .meta means no child-repo routing — schema must stay flat");
  assert.equal(proof.commitSha, fx.rootHead);
});

test("critic ancestry check uses child repo when proof.childRepo set", async (t) => {
  const fx = buildMetaRepo();
  t.after(() => fx.cleanup());

  // First record a passing child-repo proof.
  const exec = runExecute(fx, "VAL-CHILD-001");
  assert.equal(exec.code, 0);

  // Now advance the workspace-root HEAD (but NOT the child). Pre-0.4.7 the
  // critic would flag the child proof as stale because child HEAD is not
  // an ancestor of the advanced root HEAD.
  writeFileSync(join(fx.workingDir, "NEW_OUTER.md"), "bump\n");
  execSync("git add -A && git commit -qm bump", { cwd: fx.workingDir, env: { ...process.env, ...gitEnv() } });

  // Pin known-clean state: only one passed assertion, one proof.
  // Stage A ancestry check happens in critic-evaluator; run it.
  const r = spawnSync(process.execPath, [CRITIC, fx.missionPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: fx.workingDir,
      MISSION_EXECUTOR_LAYOUT_ROOT: join(fx.missionPath, "_layout"),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}

  // Stage A should not flag the child-repo proof as stale-commit.
  const stageAIssues = json?.stageA?.issues || [];
  const staleOnChild = stageAIssues.find((i) => i.id === "VAL-CHILD-001" && i.category === "stale-commit");
  assert.equal(staleOnChild, undefined,
    `child-repo proof flagged stale after outer advance: ${JSON.stringify(staleOnChild)}`);
});

test("invalidate-stale-evidence respects proof.childRepo", async (t) => {
  const fx = buildMetaRepo();
  t.after(() => fx.cleanup());

  // Capture a child-repo proof.
  const exec = runExecute(fx, "VAL-CHILD-001");
  assert.equal(exec.code, 0);

  // Advance the OUTER repo only. The child proof's SHA should remain a
  // valid ancestor of the child's HEAD (unchanged), so invalidation should
  // keep it healthy. Pre-fix: invalidate ran git ops at workingDir only and
  // would mark it stale.
  writeFileSync(join(fx.workingDir, "NEW_OUTER.md"), "bump\n");
  execSync("git add -A && git commit -qm bump", { cwd: fx.workingDir, env: { ...process.env, ...gitEnv() } });

  const r = spawnSync(process.execPath, [INVALIDATE, fx.missionPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: fx.workingDir,
      MISSION_EXECUTOR_LAYOUT_ROOT: join(fx.missionPath, "_layout"),
    },
  });
  assert.equal(r.status, 0, `invalidate failed:\n${r.stdout}\n${r.stderr}`);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  const wasInvalidated = (json?.invalidated || []).find((i) => i.id === "VAL-CHILD-001");
  assert.equal(wasInvalidated, undefined,
    `child-repo proof was invalidated by pre-critic pass: ${JSON.stringify(wasInvalidated)}`);
  assert.equal(json?.healthy, 1,
    `expected 1 healthy assertion (the child-repo proof), got ${json?.healthy}`);
});
