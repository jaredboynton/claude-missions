import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sandbox, HOOKS, PLUGIN_ROOT } from "./_helpers.mjs";

function resolveSid(env, stdin = null) {
  const cmd = `. "${PLUGIN_ROOT}/scripts/_lib/resolve-sid.sh" && resolve_sid`;
  const r = spawnSync("sh", ["-c", cmd], {
    env, encoding: "utf8",
    input: stdin === null ? "" : stdin,
    stdio: stdin === null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
  return (r.stdout || "").trim();
}

test("Tier 1: CLAUDE_SESSION_ID env wins", () => {
  const s = sandbox();
  try {
    const env = { ...s.env, CLAUDE_SESSION_ID: "from-env" };
    assert.equal(resolveSid(env), "from-env");
  } finally { s.cleanup(); }
});

test("Tier 1: CLAUDE_CODE_SESSION_ID env wins if CLAUDE_SESSION_ID unset", () => {
  const s = sandbox();
  try {
    const env = { ...s.env, CLAUDE_CODE_SESSION_ID: "from-env-code" };
    assert.equal(resolveSid(env), "from-env-code");
  } finally { s.cleanup(); }
});

test("Tier 2: stdin JSON used if Tier 1 absent", () => {
  const s = sandbox();
  try {
    const env = { ...s.env };
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    const sid = resolveSid(env, JSON.stringify({ session_id: "from-stdin" }));
    assert.equal(sid, "from-stdin");
  } finally { s.cleanup(); }
});

test("Tier 3a: per-session file used if Tiers 1/2 absent", () => {
  const s = sandbox();
  try {
    mkdirSync(s.sessionIdDir, { recursive: true });
    writeFileSync(join(s.sessionIdDir, "from-file.active"), "2026-04-22");
    const env = { ...s.env };
    delete env.CLAUDE_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    const sid = resolveSid(env, "");  // empty stdin, but pipe it so [-t 0] is false
    assert.equal(sid, "from-file");
  } finally { s.cleanup(); }
});

test("SessionStart hook writes per-session file with session-id as name", () => {
  const s = sandbox();
  try {
    const r = spawnSync(process.execPath, [join(HOOKS, "session-start-record.mjs")], {
      env: s.env, encoding: "utf8",
      input: JSON.stringify({ session_id: "abc-123-xyz" }),
    });
    assert.equal(r.status, 0);
    assert.ok(existsSync(join(s.sessionIdDir, "abc-123-xyz.active")));
  } finally { s.cleanup(); }
});

test("SessionStart: two concurrent sessions create TWO distinct files (N2 fix)", () => {
  const s = sandbox();
  try {
    const p1 = spawnSync(process.execPath, [join(HOOKS, "session-start-record.mjs")], {
      env: s.env, encoding: "utf8", input: JSON.stringify({ session_id: "sess-1" }),
    });
    const p2 = spawnSync(process.execPath, [join(HOOKS, "session-start-record.mjs")], {
      env: s.env, encoding: "utf8", input: JSON.stringify({ session_id: "sess-2" }),
    });
    assert.equal(p1.status, 0);
    assert.equal(p2.status, 0);
    assert.ok(existsSync(join(s.sessionIdDir, "sess-1.active")));
    assert.ok(existsSync(join(s.sessionIdDir, "sess-2.active")));
  } finally { s.cleanup(); }
});
