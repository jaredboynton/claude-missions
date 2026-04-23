import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import fresh each time to bust the module cache, which paths.mjs uses
// internally to cache layoutRoot(). __resetForTest() also exists.
async function loadPaths() {
  const mod = await import(`../hooks/_lib/paths.mjs?v=${Date.now()}${Math.random()}`);
  return mod;
}

function mkProject() {
  const root = mkdtempSync(join(tmpdir(), "paths-test-"));
  return { root, cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch {} } };
}

test("Tier 1: MISSION_EXECUTOR_LAYOUT_ROOT env overrides everything", async () => {
  const p = mkProject();
  try {
    const saved = { ...process.env };
    process.env.CLAUDE_PROJECT_DIR = p.root;
    process.env.MISSION_EXECUTOR_LAYOUT_ROOT = ".custom";
    delete process.env.MISSION_EXECUTOR_STATE_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const { layoutRoot, stateFile, validationDir, __resetForTest } = await loadPaths();
    __resetForTest();
    assert.equal(layoutRoot(), join(p.root, ".custom"));
    assert.equal(stateFile(), join(p.root, ".custom/state/mission-executor-state.json"));
    assert.equal(validationDir(), join(p.root, ".custom/validation"));
    Object.assign(process.env, saved);
  } finally { p.cleanup(); }
});

test("Tier 2: MISSION_EXECUTOR_STATE_DIR back-compat strips /state suffix", async () => {
  const p = mkProject();
  try {
    const saved = { ...process.env };
    process.env.CLAUDE_PROJECT_DIR = p.root;
    delete process.env.MISSION_EXECUTOR_LAYOUT_ROOT;
    process.env.MISSION_EXECUTOR_STATE_DIR = ".omc/state";
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const { layoutRoot, __resetForTest } = await loadPaths();
    __resetForTest();
    assert.equal(layoutRoot(), join(p.root, ".omc"));
    Object.assign(process.env, saved);
  } finally { p.cleanup(); }
});

test("Tier 2: MISSION_EXECUTOR_STATE_DIR without trailing /state THROWS loudly (v4 N1a)", async () => {
  const p = mkProject();
  try {
    const saved = { ...process.env };
    process.env.CLAUDE_PROJECT_DIR = p.root;
    delete process.env.MISSION_EXECUTOR_LAYOUT_ROOT;
    process.env.MISSION_EXECUTOR_STATE_DIR = "foo";
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const { layoutRoot, __resetForTest } = await loadPaths();
    __resetForTest();
    assert.throws(() => layoutRoot(), /requires a path ending in "\/state"/);
    Object.assign(process.env, saved);
  } finally { p.cleanup(); }
});

// v0.8.0 replaced two pre-existing tests here:
//   - "Legacy autodetect: .omc/state/ exists -> layoutRoot=.omc"
//   - "Default: no env, no config, no legacy -> .mission-executor"
// Both asserted pre-0.8.0 behavior that was intentionally removed (cwd
// pollution). Coverage for the 0.8.0 defaults, the .omc autodetect
// regression guard, and the new user-global layout lives in
// tests/paths.v080.test.mjs.

test("projectRoot throws on '/' (N5 fix)", async () => {
  const saved = { ...process.env };
  try {
    process.env.CLAUDE_PROJECT_DIR = "/";
    process.env.CLAUDE_WORKING_DIR = "/";
    delete process.env.MISSION_EXECUTOR_LAYOUT_ROOT;
    delete process.env.MISSION_EXECUTOR_STATE_DIR;
    const { layoutRoot, __resetForTest } = await loadPaths();
    __resetForTest();
    const origCwd = process.cwd;
    process.cwd = () => "/";
    try {
      assert.throws(() => layoutRoot(), /project root not resolvable/);
    } finally { process.cwd = origCwd; }
  } finally { Object.assign(process.env, saved); }
});

test("Every subdir is a direct child of layoutRoot (no sibling parent-dir games)", async () => {
  const p = mkProject();
  try {
    const saved = { ...process.env };
    process.env.CLAUDE_PROJECT_DIR = p.root;
    process.env.MISSION_EXECUTOR_LAYOUT_ROOT = ".x";
    delete process.env.MISSION_EXECUTOR_STATE_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const {
      layoutRoot, stateBase, validationDir, workerSkillsDir,
      __resetForTest,
    } = await loadPaths();
    __resetForTest();
    const root = layoutRoot();
    assert.equal(stateBase(), join(root, "state"));
    assert.equal(validationDir(), join(root, "validation"));
    assert.equal(workerSkillsDir(), join(root, "skills"));
    Object.assign(process.env, saved);
  } finally { p.cleanup(); }
});
