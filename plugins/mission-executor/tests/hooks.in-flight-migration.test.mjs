import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sandbox, runHook, readJson } from "./_helpers.mjs";

// Seed a 0.4.x-shape state file (no attachedSessions[]) and verify that a
// PreToolUse call (a) enforces correctly, (b) migrates the state file in
// place, (c) the second call hits the fast path via the same state file.

test("single-session legacy migration: enforces + migrates atomically", () => {
  const s = sandbox({ layoutRoot: ".omc" });
  try {
    // Seed legacy state (no attachedSessions)
    mkdirSync(dirname(s.stateFile), { recursive: true });
    writeFileSync(s.stateFile, JSON.stringify({
      active: true,
      missionPath: s.missionPath,
      workingDirectory: s.root,
      phase: "3-execute",
      startedAt: "2026-04-20T12:00:00Z",
    }, null, 2));

    // First PreToolUse fires with sidLegacyA.
    runHook(s.env, "worker-boundary-enforcer.mjs", {
      session_id: "sidLegacyA",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: s.root,
    });

    const after = readJson(s.stateFile);
    assert.ok(after.attachedSessions);
    assert.equal(after.attachedSessions.length, 1);
    assert.equal(after.attachedSessions[0].sessionId, "sidLegacyA");
    assert.equal(after.attachedSessions[0].migratedFromLegacy, true);

    // Second call: Stop hook hits the fast path via the local-state fallback.
    const r = runHook(s.env, "autopilot-lock.mjs", {
      session_id: "sidLegacyA",
      stop_hook_active: false,
      cwd: s.root,
    });
    assert.equal(r.out.decision, "block");
  } finally { s.cleanup(); }
});
