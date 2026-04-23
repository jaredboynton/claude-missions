// End-to-end integration tests for the five evidence-recognizer patterns
// (0.7.0). Each test builds a minimal mission fixture with:
//   - A workingDir populated so the recognizer-emitted commands pass
//   - A contract whose Evidence: line shapes one of the five patterns
// Then spawns execute-assertion.mjs and asserts status: passed with a proof
// recording the recognizer-emitted plan.
//
// These are the "does the whole pipeline actually work for real missions"
// tests. Unit tests in dispatcher-patterns.test.mjs cover pure recognizer
// behavior; these prove the wiring through dispatchShellGeneric -> executePlan
// -> record-assertion -> validation-state.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTE = join(PLUGIN_ROOT, "scripts/execute-assertion.mjs");

function gitEnv() {
  return {
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  };
}

// Build a mission with ONE pending assertion whose contract body is the
// caller-supplied text. Writes caller-supplied files into workingDir so
// recognizer-emitted commands have real targets. Returns a fixture handle.
function buildPatternMission({ id, title, body, files = {} }) {
  const root = mkdtempSync(join(tmpdir(), "mex-broaden-"));
  const workingDir = join(root, "work");
  const missionPath = join(root, "mission");
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(missionPath, { recursive: true });

  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(workingDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const gitRun = { cwd: workingDir, env: { ...process.env, ...gitEnv() } };
  execSync("git init -q -b main", gitRun);
  execSync("git add -A", gitRun);
  execSync("git commit -qm init --allow-empty", gitRun);

  writeFileSync(join(missionPath, "working_directory.txt"), workingDir);

  writeFileSync(join(missionPath, "features.json"), JSON.stringify({
    features: [{
      id: "F-001", title,
      description: `backs \`${id}\``,
      fulfills: [id],
      milestone: "M1",
    }],
  }, null, 2) + "\n");

  // Contract body is caller-supplied — this is where the pattern lives.
  const contract = [
    "## Validation", "",
    `### ${id}: ${title}`,
    body,
    "",
  ].join("\n");
  writeFileSync(join(missionPath, "validation-contract.md"), contract);

  writeFileSync(join(missionPath, "validation-state.json"),
    JSON.stringify({ assertions: {} }, null, 2) + "\n");

  return {
    root, missionPath, workingDir,
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
    cwd: fx.workingDir,
    maxBuffer: 16 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function readProof(fx, id) {
  const vs = JSON.parse(readFileSync(join(fx.missionPath, "validation-state.json"), "utf8"));
  return vs.assertions?.[id];
}

// ---------------------------------------------------------------------------
// Pattern 1: compound-AND
// ---------------------------------------------------------------------------

test("compound-AND: three independent greps, all passing -> passed", async (t) => {
  const fx = buildPatternMission({
    id: "VAL-COMPOUND-AND-001",
    title: "three file-content checks AND-reduce",
    body: [
      "Tool: `shell+grep`",
      "Evidence: `grep -q 'alpha' a.txt` AND `grep -q 'beta' b.txt` AND `grep -q 'gamma' c.txt`",
    ].join("\n"),
    files: {
      "a.txt": "line1\nalpha\n",
      "b.txt": "beta\nother\n",
      "c.txt": "pre\ngamma\npost\n",
    },
  });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-COMPOUND-AND-001");
  assert.equal(r.code, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);
  const entry = readProof(fx, "VAL-COMPOUND-AND-001");
  assert.equal(entry?.status, "passed");
  assert.match(entry.proof.command, /evidence-recognizer: compound-and/);
  // All three commands should be in the record for audit.
  assert.match(entry.proof.command, /alpha/);
  assert.match(entry.proof.command, /beta/);
  assert.match(entry.proof.command, /gamma/);
});

test("compound-AND: second command fails -> failed (AND-reduce)", async (t) => {
  const fx = buildPatternMission({
    id: "VAL-COMPOUND-AND-002",
    title: "second command fails",
    body: [
      "Tool: `shell+grep`",
      "Evidence: `grep -q 'alpha' a.txt` AND `grep -q 'not-there' b.txt` AND `grep -q 'gamma' c.txt`",
    ].join("\n"),
    files: { "a.txt": "alpha\n", "b.txt": "beta\n", "c.txt": "gamma\n" },
  });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-COMPOUND-AND-002");
  // Exit 1 (failed)
  assert.equal(r.code, 1);
  const entry = readProof(fx, "VAL-COMPOUND-AND-002");
  assert.equal(entry?.status, "failed");
});

// ---------------------------------------------------------------------------
// Pattern 2: brace expansion
// ---------------------------------------------------------------------------

test("brace expansion: all absent paths -> passed (VAL-CLEANUP-001 repro)", async (t) => {
  // Target pattern from handoff: `test ! -e cse-tools/deploy/{Dockerfile,entrypoint.sh,crontab}`
  // The assertion passes when NONE of the paths exist.
  const fx = buildPatternMission({
    id: "VAL-BRACE-001",
    title: "no legacy deploy artifacts remain",
    body: [
      "Tool: `shell+test`",
      "Evidence: `test ! -e deploy/{Dockerfile,entrypoint.sh,crontab}`",
    ].join("\n"),
    files: {}, // none of the braced paths exist
  });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-BRACE-001");
  assert.equal(r.code, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);
  const entry = readProof(fx, "VAL-BRACE-001");
  assert.equal(entry?.status, "passed");
  assert.match(entry.proof.command, /evidence-recognizer: brace-expansion/);
});

test("brace expansion: one path exists -> failed", async (t) => {
  const fx = buildPatternMission({
    id: "VAL-BRACE-002",
    title: "Dockerfile should not exist",
    body: [
      "Tool: `shell+test`",
      "Evidence: `test ! -e deploy/{Dockerfile,entrypoint.sh}`",
    ].join("\n"),
    files: { "deploy/Dockerfile": "FROM alpine\n" },
  });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-BRACE-002");
  assert.equal(r.code, 1);
  const entry = readProof(fx, "VAL-BRACE-002");
  assert.equal(entry?.status, "failed");
});

// ---------------------------------------------------------------------------
// Pattern 3: list-as-anchor
// ---------------------------------------------------------------------------

test("list-anchor: all scripts executable under path prefix -> passed (VAL-PACKER-002 repro)", async (t) => {
  const fx = buildPatternMission({
    id: "VAL-LIST-ANCHOR-001",
    title: "all packer scripts are executable",
    body: [
      "Tool: `shell+test`",
      "Evidence: `install-packages.sh, install-agents.sh, install-systemd.sh`",
      "Each script must be `test -x` under `deploy/packer/scripts/`.",
    ].join("\n"),
    files: {
      "deploy/packer/scripts/install-packages.sh": "#!/bin/sh\n",
      "deploy/packer/scripts/install-agents.sh": "#!/bin/sh\n",
      "deploy/packer/scripts/install-systemd.sh": "#!/bin/sh\n",
    },
  });
  t.after(() => fx.cleanup());

  // Make the scripts executable so `test -x` passes.
  execSync("chmod +x deploy/packer/scripts/*.sh", { cwd: fx.workingDir });

  const r = runExecute(fx, "VAL-LIST-ANCHOR-001");
  assert.equal(r.code, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);
  const entry = readProof(fx, "VAL-LIST-ANCHOR-001");
  assert.equal(entry?.status, "passed");
  assert.match(entry.proof.command, /evidence-recognizer: list-anchor/);
});

// ---------------------------------------------------------------------------
// Pattern 4: alternation-as-grep (the VAL-PACKER-019 flaw #2 repro)
// ---------------------------------------------------------------------------

test("alternation-grep: banned tokens absent from target file -> passed", async (t) => {
  // VAL-PACKER-019 repro: the draft couldn't handle this because it rejected
  // blocks whose first token matched EXEC_PREFIX (cp). 0.7.0 splits on `|`
  // first, recognizes this as an alternation pattern, and emits
  // `! grep -qE 'cp -r|tar -xf|rsync' <path>`.
  const fx = buildPatternMission({
    id: "VAL-ALT-001",
    title: "no file-copy commands in packer config",
    body: [
      "Tool: `shell+grep`",
      "Evidence: no `cp -r|tar -xf|rsync` into `deploy/Dockerfile`",
    ].join("\n"),
    files: { "deploy/Dockerfile": "FROM alpine\nRUN echo hello\n" },
  });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-ALT-001");
  assert.equal(r.code, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);
  const entry = readProof(fx, "VAL-ALT-001");
  assert.equal(entry?.status, "passed");
  assert.match(entry.proof.command, /evidence-recognizer: alternation-grep/);
});

test("alternation-grep: a banned token IS present -> failed", async (t) => {
  const fx = buildPatternMission({
    id: "VAL-ALT-002",
    title: "no file-copy commands in packer config",
    body: [
      "Tool: `shell+grep`",
      "Evidence: no `cp -r|tar -xf|rsync` into `deploy/Dockerfile`",
    ].join("\n"),
    files: { "deploy/Dockerfile": "FROM alpine\nRUN tar -xf foo.tar\n" },
  });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-ALT-002");
  assert.equal(r.code, 1);
  const entry = readProof(fx, "VAL-ALT-002");
  assert.equal(entry?.status, "failed");
});

// ---------------------------------------------------------------------------
// Pattern 5: negation list (VAL-CI-004 repro)
// ---------------------------------------------------------------------------

test("negation-list: no env-var leaks in config file -> passed", async (t) => {
  // NOTE: target file is config/bake.yml rather than .github/workflows/*.yml
  // to avoid tripping the sandbox's actionlint pre-commit hook on staging.
  // Semantically identical for the recognizer — the path hint is just a
  // backticked string the recognizer passes to grep.
  const fx = buildPatternMission({
    id: "VAL-NEG-001",
    title: "no AWS keys hard-coded in CI",
    body: [
      "Tool: `shell+grep`",
      "Evidence: `AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN` contains no in `config/bake.yml`",
    ].join("\n"),
    files: {
      "config/bake.yml": "name: bake\non: push\njobs: {}\n",
    },
  });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-NEG-001");
  assert.equal(r.code, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);
  const entry = readProof(fx, "VAL-NEG-001");
  assert.equal(entry?.status, "passed");
  assert.match(entry.proof.command, /evidence-recognizer: negation-list/);
});

test("negation-list: key leak present -> failed", async (t) => {
  const fx = buildPatternMission({
    id: "VAL-NEG-002",
    title: "no AWS keys hard-coded in CI",
    body: [
      "Tool: `shell+grep`",
      "Evidence: `AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY` contains no in `config/bake.yml`",
    ].join("\n"),
    files: {
      "config/bake.yml": "env:\n  AWS_ACCESS_KEY_ID: $X\n",
    },
  });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-NEG-002");
  assert.equal(r.code, 1);
  const entry = readProof(fx, "VAL-NEG-002");
  assert.equal(entry?.status, "failed");
});

// ---------------------------------------------------------------------------
// Fall-through: plain single-command evidence still works (0.6.0 behavior)
// ---------------------------------------------------------------------------

test("fall-through: single-command evidence falls through to tryExtract (0.6.0 compat)", async (t) => {
  const fx = buildPatternMission({
    id: "VAL-FALLTHRU-001",
    title: "basic test-e still works",
    body: [
      "Tool: `shell+test`",
      "Evidence: `test -e hello.txt` exits 0",
    ].join("\n"),
    files: { "hello.txt": "hi\n" },
  });
  t.after(() => fx.cleanup());

  const r = runExecute(fx, "VAL-FALLTHRU-001");
  assert.equal(r.code, 0, `execute failed:\n${r.stdout}\n${r.stderr}`);
  const entry = readProof(fx, "VAL-FALLTHRU-001");
  assert.equal(entry?.status, "passed");
  // Recognizer did NOT match — the command record should lack the
  // "evidence-recognizer:" prefix and use the legacy shell-generic marker.
  assert.doesNotMatch(entry.proof.command, /evidence-recognizer:/);
  assert.match(entry.proof.command, /shell-generic dispatch/);
});
