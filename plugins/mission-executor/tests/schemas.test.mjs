import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validate, workerHandoffSchema, discoveredIssueSchema, endFeatureInputSchema,
} from "../scripts/_lib/schemas.mjs";

const GOOD_HANDOFF = {
  workerSessionId: "sid-worker-1",
  featureId: "VAL-HTTP-001",
  successState: "success",
  salientSummary: "Implemented the POST /api/users handler with validation. All unit tests pass.",
  whatWasDone: ["added handler", "wired validation"],
  commitShas: ["abc1234"],
};

test("workerHandoffSchema: valid payload passes", () => {
  const r = validate(workerHandoffSchema, GOOD_HANDOFF);
  assert.equal(r.ok, true);
});

test("workerHandoffSchema: missing required fields error with paths", () => {
  const r = validate(workerHandoffSchema, { workerSessionId: "x" });
  assert.equal(r.ok, false);
  const msgs = r.errors.join(" | ");
  assert.match(msgs, /\$\.featureId: required/);
  assert.match(msgs, /\$\.successState: required/);
  assert.match(msgs, /\$\.salientSummary: required/);
});

test("workerHandoffSchema: salientSummary <20 chars fails minLength", () => {
  const r = validate(workerHandoffSchema, { ...GOOD_HANDOFF, salientSummary: "tiny" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /\$\.salientSummary.*minLength/);
});

test("workerHandoffSchema: salientSummary >4 sentences fails", () => {
  const five = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
  const r = validate(workerHandoffSchema, { ...GOOD_HANDOFF, salientSummary: five });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /sentence/);
});

test("workerHandoffSchema: successState enum violation", () => {
  const r = validate(workerHandoffSchema, { ...GOOD_HANDOFF, successState: "maybe" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /\$\.successState.*enum/);
});

test("workerHandoffSchema: nested discoveredIssues validated recursively", () => {
  const bad = {
    ...GOOD_HANDOFF,
    discoveredIssues: [{ severity: "unknown", description: "x" }],
  };
  const r = validate(workerHandoffSchema, bad);
  assert.equal(r.ok, false);
  const joined = r.errors.join(" | ");
  assert.match(joined, /discoveredIssues\[0\]\.severity.*enum/);
  assert.match(joined, /discoveredIssues\[0\]\.description.*minLength/);
});

test("workerHandoffSchema: commitShas items validated", () => {
  const bad = { ...GOOD_HANDOFF, commitShas: ["short"] };  // "short" = 5 chars, min 7
  const r = validate(workerHandoffSchema, bad);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /commitShas\[0\].*minLength/);
});

test("workerHandoffSchema: whatWasDone items <5 chars fail", () => {
  const bad = { ...GOOD_HANDOFF, whatWasDone: ["ok", "this is long enough"] };
  const r = validate(workerHandoffSchema, bad);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /whatWasDone\[0\].*minLength/);
});

test("discoveredIssueSchema: standalone use", () => {
  const valid = { severity: "high", description: "Order of operations is wrong in reducer." };
  assert.equal(validate(discoveredIssueSchema, valid).ok, true);
  const missing = { severity: "high" };
  const r = validate(discoveredIssueSchema, missing);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /\$\.description: required/);
});

test("endFeatureInputSchema: happy path", () => {
  const good = {
    featureId: "F1",
    status: "completed",
    summary: "Implemented the feature end-to-end with tests green across browsers.",
    commitShas: ["abc"],
  };
  assert.equal(validate(endFeatureInputSchema, good).ok, true);
});

test("endFeatureInputSchema: rejects bogus status", () => {
  const r = validate(endFeatureInputSchema, {
    featureId: "F1",
    status: "stalled",
    summary: "twenty-char minimum-length summary here ok.",
  });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /status.*enum/);
});

test("validate: unknown/extra properties pass (open schema)", () => {
  const r = validate(workerHandoffSchema, { ...GOOD_HANDOFF, _extra: "anything" });
  assert.equal(r.ok, true);
});

test("validate: null at a required key fails cleanly", () => {
  const r = validate(workerHandoffSchema, { ...GOOD_HANDOFF, featureId: null });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /featureId: required/);
});
