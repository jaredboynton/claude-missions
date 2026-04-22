import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { sandbox, readJson, HOOKS } from "./_helpers.mjs";

// Spec §8.1 / critic N3: two parallel hooks fire on the same pre-0.5.0
// state file with DIFFERENT session-ids. Both must end up in
// attachedSessions[] (no session loss under stateLockFile contention).

function firePre(hookName, env, payload) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HOOKS, hookName)], { env });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(payload));
  });
}

test("concurrent migration: two sessions both land in attachedSessions[]", async () => {
  const s = sandbox({ layoutRoot: ".omc" });
  try {
    mkdirSync(dirname(s.stateFile), { recursive: true });
    writeFileSync(s.stateFile, JSON.stringify({
      active: true,
      missionPath: s.missionPath,
      workingDirectory: s.root,
      phase: "3-execute",
    }, null, 2));

    await Promise.all([
      firePre("worker-boundary-enforcer.mjs", s.env, {
        session_id: "sidConcA",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: s.root,
      }),
      firePre("worker-boundary-enforcer.mjs", s.env, {
        session_id: "sidConcB",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: s.root,
      }),
    ]);

    const after = readJson(s.stateFile);
    const ids = new Set(after.attachedSessions.map((x) => x.sessionId));
    assert.ok(ids.has("sidConcA"), "sidConcA should have been appended");
    assert.ok(ids.has("sidConcB"), "sidConcB should have been appended");
    assert.equal(after.attachedSessions.length, 2);
    for (const e of after.attachedSessions) {
      assert.equal(e.migratedFromLegacy, true);
    }
  } finally { s.cleanup(); }
});
