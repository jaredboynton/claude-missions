// v0.8.0 project-state migration: legacy cwd/.mission-executor/state/ and
// cwd/.omc/state/ get copied into ~/.claude/mission-executor/projects/<slug>/
// on first mission-cli start|attach. Originals are never deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadMigrate() {
  const mod = await import(`../scripts/_lib/migrate.mjs?v=${Date.now()}${Math.random()}`);
  return mod;
}

async function loadPaths() {
  const mod = await import(`../hooks/_lib/paths.mjs?v=${Date.now()}${Math.random()}`);
  return mod;
}

function mkSandbox() {
  const root = mkdtempSync(join(tmpdir(), "me-migr-proj-"));
  const home = mkdtempSync(join(tmpdir(), "me-migr-home-"));
  return {
    root, home,
    cleanup: () => {
      try { rmSync(root, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

function plantLegacyState(baseDir, layoutName, contents) {
  const stateDir = join(baseDir, layoutName, "state");
  const sessionsDir = join(stateDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(stateDir, "mission-executor-state.json"), JSON.stringify(contents || {}));
  writeFileSync(join(stateDir, "hook-audit.log"), "{\"ts\":\"2026-04-22T00:00:00Z\",\"hook\":\"test\"}\n");
  writeFileSync(join(sessionsDir, "sid-xyz.active"), "2026-04-22");
  return stateDir;
}

async function callMigrateWithEnv(workingDir, homeDir) {
  const saved = { ...process.env };
  try {
    process.env.HOME = homeDir;
    delete process.env.MISSION_EXECUTOR_LAYOUT_ROOT;
    delete process.env.MISSION_EXECUTOR_STATE_DIR;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const { migrateProjectStateToUserGlobal } = await loadMigrate();
    const { __resetForTest } = await loadPaths();
    __resetForTest();
    return migrateProjectStateToUserGlobal(workingDir);
  } finally { Object.assign(process.env, saved); }
}

test("legacy .mission-executor/state/ copies to user-global projects/<slug>/state/", async () => {
  const s = mkSandbox();
  try {
    const legacy = plantLegacyState(s.root, ".mission-executor", { active: true, missionPath: "/fake/mission" });
    const r = await callMigrateWithEnv(s.root, s.home);
    const slug = s.root.replace(/\//g, "-");
    const expected = join(s.home, ".claude/mission-executor/projects", slug, "state");
    assert.equal(r.migrated, expected);
    assert.ok(existsSync(join(expected, "mission-executor-state.json")));
    assert.ok(existsSync(join(expected, "hook-audit.log")));
    assert.ok(existsSync(join(expected, "sessions/sid-xyz.active")));
    // Originals untouched.
    assert.ok(existsSync(join(legacy, "mission-executor-state.json")));
  } finally { s.cleanup(); }
});

test("legacy .omc/state/ copies too (0.4.x OMC-era installs)", async () => {
  const s = mkSandbox();
  try {
    plantLegacyState(s.root, ".omc", { active: true });
    const r = await callMigrateWithEnv(s.root, s.home);
    const slug = s.root.replace(/\//g, "-");
    const expected = join(s.home, ".claude/mission-executor/projects", slug, "state");
    assert.equal(r.migrated, expected);
    assert.ok(existsSync(join(expected, "mission-executor-state.json")));
  } finally { s.cleanup(); }
});

test("no legacy state -> no-op, returns skipped=no-legacy-state", async () => {
  const s = mkSandbox();
  try {
    const r = await callMigrateWithEnv(s.root, s.home);
    assert.equal(r.migrated, null);
    assert.equal(r.skipped, "no-legacy-state");
  } finally { s.cleanup(); }
});

test("user-global target already populated -> skipped=target-exists, legacy untouched", async () => {
  const s = mkSandbox();
  try {
    const legacy = plantLegacyState(s.root, ".mission-executor", { active: true, missionPath: "legacy" });
    // Pre-populate user-global target so migration should bail.
    const slug = s.root.replace(/\//g, "-");
    const target = join(s.home, ".claude/mission-executor/projects", slug, "state");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "mission-executor-state.json"), JSON.stringify({ active: true, missionPath: "already-migrated" }));

    const r = await callMigrateWithEnv(s.root, s.home);
    assert.equal(r.migrated, null);
    assert.equal(r.skipped, "target-exists");
    // Target file unmodified.
    const contents = JSON.parse(readFileSync(join(target, "mission-executor-state.json"), "utf8"));
    assert.equal(contents.missionPath, "already-migrated");
    // Legacy still present.
    assert.ok(existsSync(join(legacy, "mission-executor-state.json")));
  } finally { s.cleanup(); }
});

test("idempotent: second call after successful migration returns skipped=target-exists", async () => {
  const s = mkSandbox();
  try {
    plantLegacyState(s.root, ".mission-executor", { active: true });
    const r1 = await callMigrateWithEnv(s.root, s.home);
    assert.ok(r1.migrated);
    const r2 = await callMigrateWithEnv(s.root, s.home);
    assert.equal(r2.skipped, "target-exists");
  } finally { s.cleanup(); }
});

test("MISSION_EXECUTOR_LAYOUT_ROOT env override suppresses migration (operator opted out)", async () => {
  const s = mkSandbox();
  try {
    plantLegacyState(s.root, ".mission-executor", { active: true });
    const saved = { ...process.env };
    try {
      process.env.HOME = s.home;
      process.env.MISSION_EXECUTOR_LAYOUT_ROOT = ".me-custom";
      const { migrateProjectStateToUserGlobal } = await loadMigrate();
      const { __resetForTest } = await loadPaths();
      __resetForTest();
      const r = migrateProjectStateToUserGlobal(s.root);
      assert.equal(r.migrated, null);
      assert.equal(r.skipped, "env-override-active");
    } finally { Object.assign(process.env, saved); }
  } finally { s.cleanup(); }
});

test("empty workingDir arg -> skipped=no-working-dir", async () => {
  const { migrateProjectStateToUserGlobal } = await loadMigrate();
  assert.equal(migrateProjectStateToUserGlobal("").skipped, "no-working-dir");
  assert.equal(migrateProjectStateToUserGlobal(null).skipped, "no-working-dir");
  assert.equal(migrateProjectStateToUserGlobal(undefined).skipped, "no-working-dir");
});
