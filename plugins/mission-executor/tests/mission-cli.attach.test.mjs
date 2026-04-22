import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { sandbox, runCli, readJson } from "./_helpers.mjs";

test("start: writes state + registry + action=started", () => {
  const s = sandbox();
  try {
    const r = runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.action, "started");
    assert.ok(existsSync(s.stateFile));
    const state = readJson(s.stateFile);
    assert.equal(state.active, true);
    assert.equal(state.attachedSessions.length, 1);
    assert.equal(state.attachedSessions[0].sessionId, "sidA");
    assert.ok(existsSync(s.registryFile));
  } finally { s.cleanup(); }
});

test("start is idempotent: same sid re-attaches without dup", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.action, "attached-to-existing");
    const state = readJson(s.stateFile);
    assert.equal(state.attachedSessions.length, 1);
  } finally { s.cleanup(); }
});

test("start with new sid on existing mission -> attached-to-existing, two sessions", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runCli(s.env, ["start", s.missionPath, "--session-id=sidB"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.action, "attached-to-existing");
    const state = readJson(s.stateFile);
    assert.equal(state.attachedSessions.length, 2);
    assert.deepEqual(
      state.attachedSessions.map((x) => x.sessionId).sort(),
      ["sidA", "sidB"],
    );
  } finally { s.cleanup(); }
});

test("start without --session-id fails with exit 4", () => {
  const s = sandbox();
  try {
    const r = runCli(s.env, ["start", s.missionPath]);
    assert.equal(r.code, 4);
  } finally { s.cleanup(); }
});

test("is-attached: exit 0 when in attachedSessions, exit 1 otherwise", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    assert.equal(runCli(s.env, ["is-attached", "--session-id=sidA"]).code, 0);
    assert.equal(runCli(s.env, ["is-attached", "--session-id=sidNope"]).code, 1);
  } finally { s.cleanup(); }
});
