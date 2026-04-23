import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PLUGIN_ROOT, sandbox } from "./_helpers.mjs";
import {
  appendEvent, readEvents, deriveWorkerStates, activeWorkerSessionIds,
} from "../scripts/_lib/progress-log.mjs";

function mkMission() {
  const root = mkdtempSync(join(tmpdir(), "pl-test-"));
  const missionPath = join(root, "mission");
  mkdirSync(missionPath, { recursive: true });
  return { root, missionPath, cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch {} } };
}

test("appendEvent round-trip: single event", () => {
  const m = mkMission();
  try {
    const r = appendEvent(m.missionPath, { type: "mission_started", sessionId: "A" });
    assert.equal(r.ok, true);
    assert.ok(existsSync(r.path));
    const events = readEvents(m.missionPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "mission_started");
    assert.equal(events[0].sessionId, "A");
    assert.ok(events[0].timestamp);
  } finally { m.cleanup(); }
});

test("appendEvent refuses empty event / missing type", () => {
  const m = mkMission();
  try {
    const r1 = appendEvent(m.missionPath, null);
    assert.equal(r1.ok, false);
    const r2 = appendEvent(m.missionPath, { sessionId: "X" });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /type/);
  } finally { m.cleanup(); }
});

test("readEvents: skips malformed lines gracefully", async () => {
  const m = mkMission();
  try {
    appendEvent(m.missionPath, { type: "a" });
    // Append a malformed line directly
    const { appendFileSync } = await import("node:fs");
    const { progressLogFile } = await import("../hooks/_lib/paths.mjs");
    appendFileSync(progressLogFile(m.missionPath), "NOT JSON\n");
    appendEvent(m.missionPath, { type: "b" });
    const events = readEvents(m.missionPath);
    // Two valid events survive; the malformed line is dropped.
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "a");
    assert.equal(events[1].type, "b");
  } finally { m.cleanup(); }
});

test("deriveWorkerStates maps start/complete/fail pairs", () => {
  const events = [
    { type: "worker_started", workerSessionId: "w1", timestamp: "t1" },
    { type: "worker_completed", workerSessionId: "w1", timestamp: "t2", exitCode: 0 },
    { type: "worker_started", workerSessionId: "w2", timestamp: "t3" },
    { type: "worker_failed", workerSessionId: "w2", timestamp: "t4", exitCode: 1, reason: "test-red" },
    { type: "worker_started", workerSessionId: "w3", timestamp: "t5" },
  ];
  const states = deriveWorkerStates(events);
  assert.equal(states.w1.startedAt, "t1");
  assert.equal(states.w1.completedAt, "t2");
  assert.equal(states.w1.exitCode, 0);
  assert.equal(states.w2.completedAt, "t4");
  assert.equal(states.w2.failed, true);
  assert.equal(states.w2.reason, "test-red");
  assert.equal(states.w3.startedAt, "t5");
  assert.equal(states.w3.completedAt, undefined);
});

test("activeWorkerSessionIds returns only sessions without a terminal event", () => {
  const events = [
    { type: "worker_started", workerSessionId: "w1", timestamp: "t1" },
    { type: "worker_started", workerSessionId: "w2", timestamp: "t2" },
    { type: "worker_completed", workerSessionId: "w1", timestamp: "t3", exitCode: 0 },
  ];
  assert.deepEqual(activeWorkerSessionIds(events), ["w2"]);
});

test("concurrent appends: 20 parallel writers -> 20 intact lines (POSIX atomic-append)", async () => {
  const m = mkMission();
  try {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        new Promise((resolve) => {
          const p = spawn(process.execPath, [
            "-e",
            `import("${PLUGIN_ROOT}/scripts/_lib/progress-log.mjs").then((m) => { m.appendEvent("${m.missionPath}", { type: "worker_started", workerSessionId: "w${i}" }); });`
          ]);
          p.on("close", () => resolve());
        }),
      ),
    );
    const events = readEvents(m.missionPath);
    assert.equal(events.length, N, `expected ${N} events, got ${events.length}`);
    const ids = new Set(events.map((e) => e.workerSessionId));
    for (let i = 0; i < N; i++) assert.ok(ids.has(`w${i}`), `missing w${i}`);
    // Every line parsed — no torn writes.
    for (const e of events) {
      assert.equal(e.type, "worker_started");
      assert.ok(e.timestamp);
    }
  } finally { m.cleanup(); }
});
