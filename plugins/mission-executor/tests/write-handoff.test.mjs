import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ROOT } from "./_helpers.mjs";

const WH = join(PLUGIN_ROOT, "scripts/write-handoff.mjs");

function mkMission() {
  const root = mkdtempSync(join(tmpdir(), "wh-test-"));
  const missionPath = join(root, "mission");
  mkdirSync(missionPath, { recursive: true });
  return { root, missionPath, cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function runWH({ missionPath, json, args = [] }) {
  const r = spawnSync(process.execPath, [WH, missionPath, ...args], {
    encoding: "utf8",
    input: json !== undefined ? (typeof json === "string" ? json : JSON.stringify(json)) : "",
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Stdout may be (a) a single-line JSON on success, or (b) a multi-line
  // pretty-printed error JSON. Try parsing the whole blob first, then fall
  // back to the last line.
  let out = null;
  try { out = JSON.parse(r.stdout.trim()); }
  catch {
    try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out };
}

const GOOD = {
  workerSessionId: "sid-w-1",
  featureId: "VAL-X",
  successState: "success",
  salientSummary: "Implemented the POST handler with validation. All tests pass.",
  commitShas: ["abc1234"],
};

test("valid handoff -> exit 0, file + progress_log entry", () => {
  const m = mkMission();
  try {
    const r = runWH({ missionPath: m.missionPath, json: GOOD });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out.ok, true);
    assert.ok(r.out.outPath.endsWith(".json"));
    assert.ok(existsSync(r.out.outPath));
    const body = JSON.parse(readFileSync(r.out.outPath, "utf8"));
    assert.equal(body.workerSessionId, "sid-w-1");
    assert.equal(body.featureId, "VAL-X");
    // Progress log exists + has the handoff_written entry
    const log = readFileSync(join(m.missionPath, "progress_log.jsonl"), "utf8").trim().split("\n");
    const entry = JSON.parse(log[log.length - 1]);
    assert.equal(entry.type, "handoff_written");
    assert.equal(entry.featureId, "VAL-X");
  } finally { m.cleanup(); }
});

test("invalid handoff -> exit 1, no file, no log entry", () => {
  const m = mkMission();
  try {
    const r = runWH({ missionPath: m.missionPath, json: { workerSessionId: "x" } });
    assert.equal(r.code, 1);
    assert.equal(r.out.ok, false);
    assert.ok(Array.isArray(r.out.errors));
    // No handoffs dir populated
    const handoffsDir = join(m.missionPath, "handoffs");
    const entries = existsSync(handoffsDir) ? readdirSync(handoffsDir) : [];
    assert.equal(entries.length, 0);
    // No progress_log
    assert.equal(existsSync(join(m.missionPath, "progress_log.jsonl")), false);
  } finally { m.cleanup(); }
});

test("duplicate filename refused via preferredFilePath", () => {
  const m = mkMission();
  try {
    const pref = join(m.missionPath, "handoffs", "fixed.json");
    const first = runWH({ missionPath: m.missionPath, json: { ...GOOD, preferredFilePath: pref } });
    assert.equal(first.code, 0);
    assert.equal(first.out.outPath, pref);
    // Second attempt with same preferredFilePath
    const second = runWH({
      missionPath: m.missionPath,
      json: { ...GOOD, workerSessionId: "sid-w-2", preferredFilePath: pref },
    });
    assert.equal(second.code, 2);
    assert.match(second.stderr, /refusing to overwrite/);
  } finally { m.cleanup(); }
});

test("--force-skip-validation bypasses schema; _unverified tagged", () => {
  const m = mkMission();
  try {
    const r = runWH({
      missionPath: m.missionPath,
      json: { workerSessionId: "sid-w-bad", featureId: "fbad" },  // invalid (missing successState/salientSummary)
      args: ["--force-skip-validation"],
    });
    assert.equal(r.code, 0);
    assert.equal(r.out.unverified, true);
    const body = JSON.parse(readFileSync(r.out.outPath, "utf8"));
    assert.equal(body._unverified, true);
    // Progress log: entry flagged unverified
    const log = readFileSync(join(m.missionPath, "progress_log.jsonl"), "utf8").trim().split("\n");
    const entry = JSON.parse(log[log.length - 1]);
    assert.equal(entry.type, "handoff_written");
    assert.equal(entry.unverified, true);
  } finally { m.cleanup(); }
});

test("--handoff-json=<file> loads from disk", async () => {
  const m = mkMission();
  try {
    const { writeFileSync } = await import("node:fs");
    const jsonPath = join(m.root, "handoff.json");
    writeFileSync(jsonPath, JSON.stringify(GOOD));
    const r = runWH({ missionPath: m.missionPath, args: [`--handoff-json=${jsonPath}`] });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.out.ok, true);
    assert.ok(existsSync(r.out.outPath));
  } finally { m.cleanup(); }
});

test("missing mission-path arg -> exit 2", () => {
  const r = spawnSync(process.execPath, [WH], { encoding: "utf8" });
  assert.equal(r.status, 2);
});

test("nonexistent mission-path -> exit 2", () => {
  const r = runWH({ missionPath: "/nonexistent/path-xyz", json: GOOD });
  assert.equal(r.code, 2);
});
