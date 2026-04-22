import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sandbox, runCli } from "./_helpers.mjs";

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
