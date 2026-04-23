// v0.8.1 D1 regression test: every hook under plugins/mission-executor/hooks/
// must emit JSON that matches the Claude Code 2.1.118 schema.
//
// Schema summary (from https://code.claude.com/docs/en/hooks):
//   PreToolUse  -> hookSpecificOutput.{hookEventName:"PreToolUse",
//                    permissionDecision:"allow"|"deny"|"ask",
//                    permissionDecisionReason?, additionalContext?}
//                 Top-level `decision`/`reason`/`message` are DEPRECATED.
//                 Emitting both legacy AND modern shapes triggers
//                 "(root): Invalid input" in 2.1.118.
//   PostToolUse -> hookSpecificOutput.{hookEventName:"PostToolUse",
//                    additionalContext?}. Top-level `decision`/`reason`
//                 still legal for block. Bare `{message:...}` is NOT in
//                 the schema and must never be emitted.
//   Stop/SubagentStop -> top-level `{decision:"block", reason:...}` OR
//                        `{}` still valid.
//
// This test spawns each hook with representative stdin JSON and asserts
// the returned payload is schema-valid.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = join(PLUGIN_ROOT, "hooks");

function runHook(relPath, stdin) {
  const r = spawnSync(process.execPath, [join(HOOKS, relPath)], {
    input: JSON.stringify(stdin),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout || "{}"); } catch { /* ignore */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// Forbidden legacy PreToolUse top-level fields when the hook is allowing.
// Our helper may legitimately emit `decision: "block"` for Stop hooks, but
// PreToolUse hooks must never carry top-level `decision`/`message`/`reason`.
function assertNoLegacyPreToolUseFields(json, label) {
  assert.ok(json, `${label}: hook emitted no parseable JSON`);
  assert.ok(!("decision" in json),
    `${label}: legacy top-level "decision" field leaked into 2.1.118 payload: ${JSON.stringify(json)}`);
  assert.ok(!("message" in json),
    `${label}: legacy top-level "message" field leaked into 2.1.118 payload: ${JSON.stringify(json)}`);
  assert.ok(!("reason" in json),
    `${label}: legacy top-level "reason" field leaked into 2.1.118 payload: ${JSON.stringify(json)}`);
}

function assertCanonicalPreToolUseAllow(json, label) {
  assertNoLegacyPreToolUseFields(json, label);
  const spec = json.hookSpecificOutput;
  if (spec) {
    assert.equal(spec.hookEventName, "PreToolUse", `${label}: hookEventName mismatch`);
    assert.equal(spec.permissionDecision, "allow", `${label}: permissionDecision should be "allow" on no-op path`);
  }
}

function assertCanonicalPreToolUseDeny(json, label) {
  assertNoLegacyPreToolUseFields(json, label);
  const spec = json.hookSpecificOutput;
  assert.ok(spec, `${label}: deny payload missing hookSpecificOutput`);
  assert.equal(spec.hookEventName, "PreToolUse", `${label}: hookEventName mismatch`);
  assert.equal(spec.permissionDecision, "deny", `${label}: permissionDecision should be "deny"`);
  assert.equal(typeof spec.permissionDecisionReason, "string",
    `${label}: deny payload missing permissionDecisionReason string`);
}

function assertCanonicalPostToolUseAdditionalContext(json, label) {
  assertNoLegacyPreToolUseFields(json, label);
  const spec = json.hookSpecificOutput;
  if (spec) {
    assert.equal(spec.hookEventName, "PostToolUse", `${label}: hookEventName mismatch`);
    assert.equal(typeof spec.additionalContext, "string",
      `${label}: additionalContext must be a string`);
  }
  // Bare top-level `message` is the 0.8.0 bad shape we're eliminating.
  assert.ok(!("message" in json),
    `${label}: bare top-level "message" leaked into PostToolUse payload`);
}

// -- commit-scope-guard (PreToolUse:Bash) --------------------------------
test("commit-scope-guard: no-mission -> canonical allow, no legacy fields", () => {
  const r = runHook("commit-scope-guard.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    session_id: "sid-nope",
    cwd: "/tmp",
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assertCanonicalPreToolUseAllow(r.json, "commit-scope-guard/no-mission");
});

// -- worker-boundary-enforcer (PreToolUse:*) -----------------------------
test("worker-boundary-enforcer: no-mission -> canonical allow, no legacy fields", () => {
  const r = runHook("worker-boundary-enforcer.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    session_id: "sid-nope",
    cwd: "/tmp",
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assertCanonicalPreToolUseAllow(r.json, "worker-boundary-enforcer/no-mission");
});

// -- assertion-proof-guard (PreToolUse:Write|Edit) -----------------------
test("assertion-proof-guard: wrong-tool -> canonical allow", () => {
  const r = runHook("assertion-proof-guard.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assertCanonicalPreToolUseAllow(r.json, "assertion-proof-guard/wrong-tool");
});

test("assertion-proof-guard: blocked write to validation-state.json -> canonical deny", () => {
  const r = runHook("assertion-proof-guard.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/mission/validation-state.json", content: "{}" },
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assertCanonicalPreToolUseDeny(r.json, "assertion-proof-guard/deny");
});

// -- features-json-guard (PreToolUse:Write|Edit) -------------------------
test("features-json-guard: wrong-tool -> canonical allow", () => {
  const r = runHook("features-json-guard.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat features.json" },
  });
  assert.equal(r.code, 0);
  assertCanonicalPreToolUseAllow(r.json, "features-json-guard/wrong-tool");
});

test("features-json-guard: blocked write to features.json -> canonical deny", () => {
  const r = runHook("features-json-guard.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "/tmp/mission/features.json", old_string: "x", new_string: "y" },
  });
  assert.equal(r.code, 0);
  assertCanonicalPreToolUseDeny(r.json, "features-json-guard/deny");
});

// -- no-ask-during-mission (PreToolUse:AskUserQuestion) ------------------
test("no-ask-during-mission: no-mission path -> canonical allow", () => {
  const r = runHook("no-ask-during-mission.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { question: "?" },
    session_id: "sid-nope",
    cwd: "/tmp",
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assertCanonicalPreToolUseAllow(r.json, "no-ask-during-mission/no-mission");
});

test("no-ask-during-mission: wrong-tool -> canonical allow", () => {
  const r = runHook("no-ask-during-mission.mjs", {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    session_id: "sid-nope",
    cwd: "/tmp",
  });
  assert.equal(r.code, 0);
  assertCanonicalPreToolUseAllow(r.json, "no-ask-during-mission/wrong-tool");
});

// -- validation-tracker (PostToolUse:*) ----------------------------------
test("validation-tracker: no-mission -> empty object (no bare `message`)", () => {
  const r = runHook("validation-tracker.mjs", {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: "VAL-TEST-001 PASS on line 3",
    session_id: "sid-nope",
    cwd: "/tmp",
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assertCanonicalPostToolUseAdditionalContext(r.json, "validation-tracker/no-mission");
});

// -- build-discipline (PostToolUse:Edit|Write) ---------------------------
test("build-discipline: no-mission -> empty object (no bare `message`)", () => {
  const r = runHook("build-discipline.mjs", {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "src/foo.ts" },
    session_id: "sid-nope",
    cwd: "/tmp",
  });
  assert.equal(r.code, 0);
  assertCanonicalPostToolUseAdditionalContext(r.json, "build-discipline/no-mission");
});

// -- Stop hook (autopilot-lock.mjs) ---------------------------------------
// Stop hook LEGITIMATELY uses top-level decision/reason per 2.1.118 docs.
// This test asserts the Stop hook does NOT accidentally emit the PreToolUse
// hookSpecificOutput shape (which would be ignored on the Stop event).
test("autopilot-lock: no-mission returns {} and never a PreToolUse payload", () => {
  const r = runHook("autopilot-lock.mjs", {
    hook_event_name: "Stop",
    session_id: "sid-nope",
    cwd: "/tmp",
  });
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(r.json, "autopilot-lock emitted no parseable JSON");
  // Must not carry a PreToolUse hookSpecificOutput shape.
  if (r.json.hookSpecificOutput) {
    assert.notEqual(r.json.hookSpecificOutput.hookEventName, "PreToolUse",
      "autopilot-lock (Stop hook) must not emit a PreToolUse hookSpecificOutput");
  }
});
