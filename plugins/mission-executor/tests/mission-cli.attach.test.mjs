import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, runCli, readJson } from "./_helpers.mjs";

// v0.5.1: assert auto-emitted progress-log events land for each subcommand.
function readProgressLog(missionPath) {
  const p = join(missionPath, "progress_log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

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

test("is-attached: query-success exit 0 with JSON.attached distinguishing state (0.8.1)", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);

    // Attached: exit 0, JSON.attached=true, missionId set.
    const hit = runCli(s.env, ["is-attached", "--session-id=sidA"]);
    assert.equal(hit.code, 0);
    const hitJson = JSON.parse(hit.stdout);
    assert.equal(hitJson.ok, true);
    assert.equal(hitJson.attached, true);
    assert.ok(typeof hitJson.missionId === "string" && hitJson.missionId.length > 0);

    // Not attached: still exit 0 (query succeeded), JSON.attached=false.
    const miss = runCli(s.env, ["is-attached", "--session-id=sidNope"]);
    assert.equal(miss.code, 0);
    const missJson = JSON.parse(miss.stdout);
    assert.equal(missJson.ok, true);
    assert.equal(missJson.attached, false);

    // Bad input: exit 4, ok:false.
    const bad = runCli(s.env, ["is-attached"]);
    assert.equal(bad.code, 4);
    const badJson = JSON.parse(bad.stdout);
    assert.equal(badJson.ok, false);
    assert.equal(badJson.error, "bad-input");
  } finally { s.cleanup(); }
});

test("v0.5.1: start emits mission_started on fresh mission", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const events = readProgressLog(s.missionPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "mission_started");
    assert.equal(events[0].sessionId, "sidA");
  } finally { s.cleanup(); }
});

test("v0.5.1: start on existing mission emits session_attached", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    runCli(s.env, ["start", s.missionPath, "--session-id=sidB"]);
    const events = readProgressLog(s.missionPath);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "mission_started");
    assert.equal(events[1].type, "session_attached");
    assert.equal(events[1].sessionId, "sidB");
  } finally { s.cleanup(); }
});

test("v0.5.1: phase emits phase_transition with from/to", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    runCli(s.env, ["phase", "3-execute", "--session-id=sidA"]);
    const events = readProgressLog(s.missionPath);
    const pt = events.find((e) => e.type === "phase_transition");
    assert.ok(pt);
    assert.equal(pt.from, "0-validate");
    assert.equal(pt.to, "3-execute");
  } finally { s.cleanup(); }
});

test("v0.5.1: complete emits mission_completed", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    runCli(s.env, ["complete", "--session-id=sidA", "--force"]);
    const events = readProgressLog(s.missionPath);
    const done = events.find((e) => e.type === "mission_completed");
    assert.ok(done);
    assert.equal(done.forced, true);
  } finally { s.cleanup(); }
});

test("v0.5.1: event subcommand emits arbitrary-type event", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runCli(s.env, [
      "event", "worker_started",
      "--session-id=sidA", "--worker=w1", "--feature=F1",
    ]);
    assert.equal(r.code, 0);
    const events = readProgressLog(s.missionPath);
    const ws = events.find((e) => e.type === "worker_started");
    assert.ok(ws);
    assert.equal(ws.workerSessionId, "w1");
    assert.equal(ws.featureId, "F1");
  } finally { s.cleanup(); }
});

test("v0.5.1: event subcommand refuses unattached session (exit 3)", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runCli(s.env, [
      "event", "worker_started",
      "--session-id=sidOther", "--worker=w1",
    ]);
    assert.equal(r.code, 3);
  } finally { s.cleanup(); }
});
