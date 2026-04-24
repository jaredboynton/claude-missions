import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandbox, runCli, readJson, writeJson } from "./_helpers.mjs";

// v0.8.7 (D3): cmdComplete must seal the mission, not just release the
// autopilot Stop-hook. These tests exercise the three gate paths:
//   1. --force with incomplete flags: seals anyway, logs bypass, emits mission_sealed.
//   2. no-force with incomplete flags: exits 8, leaves mission state.json unchanged.
//   3. no-force with complete flags: seals cleanly, exits 0, emits mission_sealed.
// Regression target: mission 3af5aaea observed cmdComplete releasing Stop-hook
// at 02:03 UTC while orchestrator continued writing state for 83+ minutes
// because mission state.json.state stayed "running".

function readProgressLog(missionPath) {
  const p = join(missionPath, "progress_log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("D3: complete --force on incomplete mission writes state.json.state=completed and emits mission_sealed", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);

    // Mission state.json starts as "active" from the sandbox helper — the
    // completion gate requires state=="completed" plus no pending features
    // plus no pending/failed/stale assertions. With a fresh sandbox every
    // one of those checks fails, so --force must bypass all of them.
    const r = runCli(s.env, ["complete", "--session-id=sidA", "--force"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.forced, true);

    // Mission's own state.json was flipped to completed by cmdComplete.
    const missionState = readJson(join(s.missionPath, "state.json"));
    assert.equal(missionState.state, "completed");
    assert.ok(missionState.updatedAt, "updatedAt should be set");

    // Both mission_completed AND mission_sealed land in progress_log.jsonl.
    const events = readProgressLog(s.missionPath);
    const completed = events.find((e) => e.type === "mission_completed");
    const sealed = events.find((e) => e.type === "mission_sealed");
    assert.ok(completed, "mission_completed event expected");
    assert.ok(sealed, "mission_sealed event expected");
    assert.equal(completed.forced, true);
    assert.equal(sealed.forced, true);
    assert.equal(sealed.sessionId, "sidA");
  } finally { s.cleanup(); }
});

test("D3: complete without --force on incomplete mission exits 8 and leaves mission state.json untouched", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);

    const before = readJson(join(s.missionPath, "state.json"));

    const r = runCli(s.env, ["complete", "--session-id=sidA"]);
    assert.equal(r.code, 8, "completion-gate-unmet must exit 8");
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, "completion-gate-unmet");

    // Mission state.json must NOT have been flipped — the gate blocked the write.
    const after = readJson(join(s.missionPath, "state.json"));
    assert.equal(after.state, before.state, "mission state.json must not change when gate rejects");

    // No mission_sealed event should be emitted on rejection.
    const events = readProgressLog(s.missionPath);
    const sealed = events.find((e) => e.type === "mission_sealed");
    assert.equal(sealed, undefined, "no mission_sealed on gate-unmet");
  } finally { s.cleanup(); }
});

test("D3: complete without --force on genuinely-complete mission seals cleanly with exit 0", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);

    // Bring the mission to a clean-completable shape so checkCompletion passes:
    //   - features.json has no pending features
    //   - validation-state.json has no pending/failed/stale/proof-less assertions
    //   - state.json.state already says "completed"
    writeJson(join(s.missionPath, "features.json"), { features: [] });
    writeJson(join(s.missionPath, "validation-state.json"), { assertions: {} });
    writeJson(join(s.missionPath, "state.json"), { state: "completed" });

    const r = runCli(s.env, ["complete", "--session-id=sidA"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.forced, false);

    const missionState = readJson(join(s.missionPath, "state.json"));
    assert.equal(missionState.state, "completed");
    assert.ok(missionState.updatedAt, "updatedAt should be refreshed on seal");

    const events = readProgressLog(s.missionPath);
    const sealed = events.find((e) => e.type === "mission_sealed");
    assert.ok(sealed, "mission_sealed event expected on clean completion");
    assert.equal(sealed.forced, false);
  } finally { s.cleanup(); }
});
