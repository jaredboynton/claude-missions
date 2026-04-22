import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync, rmSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import { sandbox, runCli, readJson, MCLI } from "./_helpers.mjs";

function startAsync(env, missionPath, sid) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MCLI, "start", missionPath, `--session-id=${sid}`], { env });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("concurrent attach from many sessions all land in attachedSessions[]", async () => {
  const s = sandbox();
  try {
    const N = 8;
    const tasks = [];
    for (let i = 0; i < N; i++) tasks.push(startAsync(s.env, s.missionPath, `conc-${i}`));
    const results = await Promise.all(tasks);
    for (const r of results) assert.equal(r.code, 0, `conc exit: ${r.out}`);
    const state = readJson(s.stateFile);
    assert.equal(state.attachedSessions.length, N, "all sessions should appear");
    const ids = new Set(state.attachedSessions.map((x) => x.sessionId));
    for (let i = 0; i < N; i++) assert.ok(ids.has(`conc-${i}`), `missing conc-${i}`);
  } finally { s.cleanup(); }
});

test("stale lockfile recovery: dead-pid lock > 30s old is removed on retry", () => {
  const s = sandbox();
  try {
    mkdirSync(dirname(s.registryFile), { recursive: true });
    const lock = s.registryFile + ".lock";
    writeFileSync(lock, JSON.stringify({ pid: 999999, ts: "2020-01-01T00:00:00Z" }));
    // Backdate mtime to ~60s ago to trigger stale-recovery heuristic.
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    // Run start. Lockfile protocol should detect stale (pid 999999 not alive
    // + mtime > 30s), unlink, retry, succeed.
    const r = runCli(s.env, ["start", s.missionPath, "--session-id=sidStale"]);
    assert.equal(r.code, 0, `expected success, got: ${r.stderr}`);
  } finally { s.cleanup(); }
});

test("orphan GC: state file deleted, registry entry auto-dropped on next start", () => {
  const s1 = sandbox();
  try {
    runCli(s1.env, ["start", s1.missionPath, "--session-id=sid1"]);
    try { unlinkSync(s1.stateFile); } catch {}

    // Second sandbox, same fake HOME so we share the registry.
    const root2Sandbox = sandbox();
    try {
      const env = { ...root2Sandbox.env, HOME: s1.home };
      runCli(env, ["start", root2Sandbox.missionPath, "--session-id=sid2"]);
      const registryPath = env.HOME + "/.claude/mission-executor/registry.json";
      const reg = readJson(registryPath);
      const keys = Object.keys(reg.missions || {});
      // Only the new mission should remain; the orphan was GC'd.
      assert.equal(keys.length, 1);
      assert.equal(keys[0], "mission");
    } finally { root2Sandbox.cleanup(); }
  } finally {
    try { rmSync(s1.root, { recursive: true, force: true }); } catch {}
    try { rmSync(s1.home, { recursive: true, force: true }); } catch {}
  }
});
