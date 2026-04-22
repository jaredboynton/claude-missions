import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, runCli, runHook } from "./_helpers.mjs";

test("autopilot-lock: unattached session -> allows stop (empty {})", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runHook(s.env, "autopilot-lock.mjs", {
      session_id: "sidOther", stop_hook_active: false, cwd: s.root,
    });
    assert.equal(r.stdout.trim(), "{}");
  } finally { s.cleanup(); }
});

test("autopilot-lock: attached session -> blocks with reason", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runHook(s.env, "autopilot-lock.mjs", {
      session_id: "sidA", stop_hook_active: false, cwd: s.root,
    });
    assert.equal(r.out.decision, "block");
    assert.match(r.out.reason, /Mission not complete/);
  } finally { s.cleanup(); }
});

test("autopilot-lock: missing session_id -> allows (never false-positive)", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runHook(s.env, "autopilot-lock.mjs", {
      stop_hook_active: false, cwd: s.root,
    });
    assert.equal(r.stdout.trim(), "{}");
  } finally { s.cleanup(); }
});

test("no-ask-during-mission: attached -> blocks AskUserQuestion", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runHook(s.env, "no-ask-during-mission.mjs", {
      session_id: "sidA", tool_name: "AskUserQuestion", cwd: s.root,
    });
    assert.equal(r.out.decision, "block");
  } finally { s.cleanup(); }
});

test("no-ask-during-mission: unattached -> allows", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runHook(s.env, "no-ask-during-mission.mjs", {
      session_id: "sidOther", tool_name: "AskUserQuestion", cwd: s.root,
    });
    assert.equal(r.out.decision, "allow");
  } finally { s.cleanup(); }
});

test("stop_hook_active=true short-circuits to allow (no recursion)", () => {
  const s = sandbox();
  try {
    runCli(s.env, ["start", s.missionPath, "--session-id=sidA"]);
    const r = runHook(s.env, "autopilot-lock.mjs", {
      session_id: "sidA", stop_hook_active: true, cwd: s.root,
    });
    assert.equal(r.stdout.trim(), "{}");
  } finally { s.cleanup(); }
});
