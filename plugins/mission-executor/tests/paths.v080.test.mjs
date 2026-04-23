// v0.8.0: layoutRoot() default moved from <cwd>/.mission-executor to
// ~/.claude/mission-executor/projects/<slug>/. The .omc/state/ autodetect
// branch was removed — it was what created the cwd-pollution we fixed.
//
// These tests cover only the 0.8.0 additions/changes. The older tier-1/tier-2
// assertions live in paths.test.mjs and continue to pass because the env-var
// escape hatches are unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadPaths() {
  const mod = await import(`../hooks/_lib/paths.mjs?v=${Date.now()}${Math.random()}`);
  return mod;
}

function mkSandbox() {
  const root = mkdtempSync(join(tmpdir(), "paths-v8-proj-"));
  const home = mkdtempSync(join(tmpdir(), "paths-v8-home-"));
  return {
    root, home,
    cleanup: () => {
      try { rmSync(root, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

test("Default (no env, no config): layoutRoot = ~/.claude/mission-executor/projects/<slug>", async () => {
  const s = mkSandbox();
  try {
    const saved = { ...process.env };
    process.env.CLAUDE_PROJECT_DIR = s.root;
    process.env.HOME = s.home;
    delete process.env.MISSION_EXECUTOR_LAYOUT_ROOT;
    delete process.env.MISSION_EXECUTOR_STATE_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const { layoutRoot, projectSlug, userBase, __resetForTest } = await loadPaths();
    __resetForTest();
    const expected = join(s.home, ".claude/mission-executor/projects", projectSlug(s.root));
    assert.equal(layoutRoot(), expected);
    assert.equal(userBase(), join(s.home, ".claude/mission-executor"));
    Object.assign(process.env, saved);
  } finally { s.cleanup(); }
});

test(".omc/state/ autodetect is REMOVED (regression guard against cwd pollution)", async () => {
  const s = mkSandbox();
  try {
    // Plant a 0.5.x-style legacy sentinel; the pre-0.8.0 path.mjs would have
    // picked it up and returned <root>/.omc. The 0.8.0 resolver ignores it
    // and returns the user-global default.
    mkdirSync(join(s.root, ".omc/state"), { recursive: true });
    writeFileSync(join(s.root, ".omc/state/mission-executor-state.json"), "{}");
    const saved = { ...process.env };
    process.env.CLAUDE_PROJECT_DIR = s.root;
    process.env.HOME = s.home;
    delete process.env.MISSION_EXECUTOR_LAYOUT_ROOT;
    delete process.env.MISSION_EXECUTOR_STATE_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const { layoutRoot, projectSlug, __resetForTest } = await loadPaths();
    __resetForTest();
    assert.equal(layoutRoot(), join(s.home, ".claude/mission-executor/projects", projectSlug(s.root)));
    assert.notEqual(layoutRoot(), join(s.root, ".omc"));
    Object.assign(process.env, saved);
  } finally { s.cleanup(); }
});

test("projectSlug: absolute path -> path with slashes replaced by dashes", async () => {
  const { projectSlug } = await loadPaths();
  assert.equal(projectSlug("/a/b/c"), "-a-b-c");
  assert.equal(
    projectSlug("/Users/jaredboynton/__void/tech-talks/tech-talk-2026-04-23"),
    "-Users-jaredboynton---void-tech-talks-tech-talk-2026-04-23",
  );
});

test("projectSlug: rejects relative or empty input", async () => {
  const { projectSlug } = await loadPaths();
  assert.throws(() => projectSlug("relative/path"), /expected absolute path/);
  assert.throws(() => projectSlug(""), /expected absolute path string/);
  assert.throws(() => projectSlug(null), /expected absolute path string/);
  assert.throws(() => projectSlug(undefined), /expected absolute path string/);
});

test("userBase(): honors $HOME override", async () => {
  const saved = { ...process.env };
  try {
    process.env.HOME = "/tmp/fakehome-v8";
    const { userBase, __resetForTest } = await loadPaths();
    __resetForTest();
    assert.equal(userBase(), "/tmp/fakehome-v8/.claude/mission-executor");
  } finally { Object.assign(process.env, saved); }
});

test("registryFile(): lives under userBase (top-level, not projects/)", async () => {
  const saved = { ...process.env };
  try {
    process.env.HOME = "/tmp/fakehome-v8";
    const { registryFile, __resetForTest } = await loadPaths();
    __resetForTest();
    assert.equal(registryFile(), "/tmp/fakehome-v8/.claude/mission-executor/registry.json");
  } finally { Object.assign(process.env, saved); }
});

test("env override still wins: MISSION_EXECUTOR_LAYOUT_ROOT beats the user-global default", async () => {
  const s = mkSandbox();
  try {
    const saved = { ...process.env };
    process.env.CLAUDE_PROJECT_DIR = s.root;
    process.env.HOME = s.home;
    process.env.MISSION_EXECUTOR_LAYOUT_ROOT = ".opt-in-local";
    delete process.env.MISSION_EXECUTOR_STATE_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const { layoutRoot, __resetForTest } = await loadPaths();
    __resetForTest();
    assert.equal(layoutRoot(), join(s.root, ".opt-in-local"));
    Object.assign(process.env, saved);
  } finally { s.cleanup(); }
});
