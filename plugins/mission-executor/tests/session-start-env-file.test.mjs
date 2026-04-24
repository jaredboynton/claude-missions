// Guards the SessionStart hook's $CLAUDE_ENV_FILE export of
// CLAUDE_CODE_SESSION_ID (anthropics/claude-code#25642 workaround).
//
// Bash-tool calls source $CLAUDE_ENV_FILE on every invocation (at least
// until upstream exposes CLAUDE_SESSION_ID natively); the plugin writes
// the active session-id into that file from its SessionStart hook so
// downstream scripts can read `$CLAUDE_CODE_SESSION_ID` directly instead
// of scanning state files. Slash-command `!cmd` template-expansion does
// NOT source the env file (anthropics/claude-code#49780) — that path
// continues to rely on the .active-file fallback covered by
// resolve-sid.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(__dirname);
const HOOK = join(PLUGIN_ROOT, "hooks/session-start-record.mjs");

function runHook(env, payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    env, encoding: "utf8", input: JSON.stringify(payload),
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "me-ssh-"));
  const proj = mkdtempSync(join(tmpdir(), "me-ssp-"));
  const envFile = join(proj, ".me-env");
  return {
    home, proj, envFile,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: proj,
      CLAUDE_WORKING_DIR: proj,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      CLAUDE_ENV_FILE: envFile,
      MISSION_EXECUTOR_LAYOUT_ROOT: join(proj, ".me-state"),
    },
    cleanup() {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
      try { rmSync(proj, { recursive: true, force: true }); } catch {}
    },
  };
}

test("SessionStart writes `export CLAUDE_CODE_SESSION_ID=<sid>` to $CLAUDE_ENV_FILE", () => {
  const s = sandbox();
  try {
    const r = runHook(s.env, { session_id: "abc-123" });
    assert.equal(r.code, 0, `hook exited ${r.code}: ${r.stderr}`);
    assert.ok(existsSync(s.envFile), "env file should exist after hook");
    const body = readFileSync(s.envFile, "utf8");
    assert.match(body, /export CLAUDE_CODE_SESSION_ID="abc-123"/);
  } finally { s.cleanup(); }
});

test("SessionStart does NOT duplicate the export when env file already has it (resume/continue)", () => {
  const s = sandbox();
  try {
    // Simulate a prior session that already wrote the line.
    writeFileSync(s.envFile, 'export CLAUDE_CODE_SESSION_ID="old-sid"\n');
    const r = runHook(s.env, { session_id: "new-sid" });
    assert.equal(r.code, 0);
    const body = readFileSync(s.envFile, "utf8");
    // Must not stack duplicates; the grep guard should preserve the prior
    // line (or at least not append another export).
    const matches = body.match(/export CLAUDE_CODE_SESSION_ID=/g) || [];
    assert.equal(matches.length, 1, `expected 1 export line, got ${matches.length}: ${body}`);
  } finally { s.cleanup(); }
});

test("SessionStart hook is a no-op when CLAUDE_ENV_FILE is unset", () => {
  const s = sandbox();
  try {
    const env = { ...s.env };
    delete env.CLAUDE_ENV_FILE;
    const r = runHook(env, { session_id: "no-env-file" });
    assert.equal(r.code, 0, "hook must succeed even without env file");
    // No env file was set, so nothing to verify beyond the exit code.
  } finally { s.cleanup(); }
});

test("SessionStart tolerates missing session_id without erroring", () => {
  const s = sandbox();
  try {
    const r = runHook(s.env, {});
    assert.equal(r.code, 0);
    // Env file should NOT be written when there's no sid.
    assert.equal(existsSync(s.envFile), false);
  } finally { s.cleanup(); }
});
