import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, runCli, readJson } from "./_helpers.mjs";

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
