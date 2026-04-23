import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { sandbox, runCli } from "./_helpers.mjs";

// Seed a Factory-style mission directory with the minimum files the
// resolver needs to treat the path as existing. realpathSync is the only
// consumer of these files today, but writing them makes the fixture
// behave like a real Factory mission for any future resolver checks.
function seedFactoryMission(missionsRoot, id) {
  const dir = join(missionsRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), '{"state":"paused"}\n');
  writeFileSync(join(dir, "features.json"), '{"features":[]}\n');
  writeFileSync(join(dir, "validation-state.json"), '{"assertions":{}}\n');
  return dir;
}

test("resolve by absolute path returns missionId=basename", () => {
  const s = sandbox();
  try {
    const r = runCli(s.env, ["resolve", s.missionPath]);
    assert.equal(r.code, 0);
    assert.equal(r.json.missionId, "mission");
    assert.ok(r.json.missionPath.endsWith("mission"));
  } finally { s.cleanup(); }
});

test("resolve by symlink collapses via realpath", () => {
  const s = sandbox();
  try {
    const linkPath = join(s.root, "link-to-mission");
    symlinkSync(s.missionPath, linkPath);
    const r = runCli(s.env, ["resolve", linkPath]);
    assert.equal(r.code, 0);
    // Realpath of symlink target equals the original mission dir.
    assert.ok(r.json.missionPath.endsWith("mission"));
  } finally { s.cleanup(); }
});

test("resolve by bare id against registry", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runCli(s.env, ["resolve", "mission"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.missionId, "mission");
  } finally { s.cleanup(); }
});

test("resolve of non-existent id returns exit 3", () => {
  const s = sandbox();
  try {
    const r = runCli(s.env, ["resolve", "does-not-exist"]);
    assert.equal(r.code, 3);
  } finally { s.cleanup(); }
});

test("resolve with no arg returns exit 4", () => {
  const s = sandbox();
  try {
    const r = runCli(s.env, ["resolve"]);
    assert.equal(r.code, 4);
  } finally { s.cleanup(); }
});

// ---- Filesystem-fallback resolution (v0.8.3+) ----
//
// `resolveMission()` falls through to well-known Factory mission roots when
// the registry has never seen a bare id. This covers the user-facing path
// where the Factory CLI has created a mission at `~/.factory/missions/<id>/`
// but the plugin has never been pointed at it before.

test("resolve bare id via $HOME/.factory/missions fallback", () => {
  const s = sandbox();
  try {
    const id = "abcd1234-uuid-fallback";
    seedFactoryMission(join(s.home, ".factory", "missions"), id);
    const r = runCli(s.env, ["resolve", id]);
    assert.equal(r.code, 0);
    assert.equal(r.json.missionId, id);
    assert.ok(r.json.missionPath.endsWith(join(".factory", "missions", id)));
  } finally { s.cleanup(); }
});

test("resolve bare id via $FACTORY_HOME/missions takes precedence over $HOME", () => {
  const s = sandbox();
  const fh = mkdtempSync(join(tmpdir(), "me-fh-"));
  try {
    const id = "precedence-uuid";
    // Seed both roots; FACTORY_HOME must win.
    const homeDir = seedFactoryMission(join(s.home, ".factory", "missions"), id);
    const fhDir = seedFactoryMission(join(fh, "missions"), id);
    assert.notEqual(homeDir, fhDir);

    const env = { ...s.env, FACTORY_HOME: fh };
    const r = runCli(env, ["resolve", id]);
    assert.equal(r.code, 0);
    // realpath-normalize expected: macOS tmpdir is a /var -> /private/var symlink
    // and the resolver calls realpathSync().
    assert.equal(r.json.missionPath, realpathSync(fhDir));
  } finally {
    s.cleanup();
    try { rmSync(fh, { recursive: true, force: true }); } catch {}
  }
});

test("resolve bare id via $CWD/.factory/missions for in-repo missions", () => {
  const s = sandbox();
  try {
    const id = "in-repo-uuid";
    const dir = seedFactoryMission(join(s.root, ".factory", "missions"), id);
    // Neither $HOME nor $FACTORY_HOME contain the id — only CWD does. The
    // resolver uses process.cwd() on the subprocess, which we set via the
    // cwd option below.
    const out = spawnSync(process.execPath, [
      join(s.env.CLAUDE_PLUGIN_ROOT, "scripts/mission-cli.mjs"),
      "resolve", id,
    ], { env: s.env, encoding: "utf8", cwd: s.root });
    assert.equal(out.status, 0);
    const json = JSON.parse(out.stdout.trim().split("\n").pop());
    assert.equal(json.missionPath, realpathSync(dir));
  } finally { s.cleanup(); }
});

test("registry lookup wins over filesystem fallback", () => {
  const s = sandbox();
  try {
    // Register `mission` via start (uses s.missionPath under s.root).
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    // Seed a DIFFERENT directory at $HOME/.factory/missions/mission; the
    // registry-registered path under s.root must still win.
    const shadow = seedFactoryMission(join(s.home, ".factory", "missions"), "mission");
    assert.notEqual(shadow, s.missionPath);

    const r = runCli(s.env, ["resolve", "mission"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.missionId, "mission");
    // Registry stores the realpath of s.missionPath, so normalize before compare.
    assert.equal(r.json.missionPath, realpathSync(s.missionPath));
  } finally { s.cleanup(); }
});

test("resolve of id absent from registry AND filesystem roots returns exit 3", () => {
  const s = sandbox();
  try {
    // Sanity: $HOME/.factory/missions/ doesn't exist, $FACTORY_HOME unset,
    // $CWD (process.cwd()) has no .factory/missions/ with this id.
    const r = runCli(s.env, ["resolve", "does-not-exist-anywhere"]);
    assert.equal(r.code, 3);
  } finally { s.cleanup(); }
});
