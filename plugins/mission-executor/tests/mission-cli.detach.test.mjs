import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, runCli, readJson } from "./_helpers.mjs";

function readProgressLog(missionPath) {
  const p = join(missionPath, "progress_log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("detach of non-attached session -> exit 3", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runCli(s.env, ["detach", "--session-id=sidNope"]);
    assert.equal(r.code, 3);
  } finally { s.cleanup(); }
});

test("detach of non-last driver without heartbeat -> OK", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    runCli(s.env, ["start", s.missionPath, "--session-id=sidB"]);
    const r = runCli(s.env, ["detach", "--session-id=sidA"]);
    assert.equal(r.code, 0);
    const state = readJson(s.stateFile);
    assert.equal(state.attachedSessions.length, 1);
    assert.equal(state.attachedSessions[0].sessionId, "sidB");
    // v0.5.1: emits session_detached
    const events = readProgressLog(s.missionPath);
    const det = events.find((e) => e.type === "session_detached");
    assert.ok(det);
    assert.equal(det.sessionId, "sidA");
    assert.equal(det.remaining, 1);
  } finally { s.cleanup(); }
});

test("last-session detach blocked -> exit 7", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runCli(s.env, ["detach", "--session-id=sidA"]);
    assert.equal(r.code, 7);
    assert.match(r.stdout, /Last-session detach blocked/);
  } finally { s.cleanup(); }
});

test("driver-detach-blocked: heartbeat fresh -> exit 7", async () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    runCli(s.env, ["start", s.missionPath, "--session-id=sidB"]);
    // Touch heartbeat for sidA
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const hb = join(s.layoutRootAbs, "state", "driver-sidA.heartbeat");
    mkdirSync(join(s.layoutRootAbs, "state"), { recursive: true });
    writeFileSync(hb, new Date().toISOString());
    const r = runCli(s.env, ["detach", "--session-id=sidA"]);
    assert.equal(r.code, 7);
    assert.match(r.stdout, /driver-detach-blocked/);
  } finally { s.cleanup(); }
});
