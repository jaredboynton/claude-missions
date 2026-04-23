#!/usr/bin/env node
// Schema + cross-reference validation for a Factory mission directory.
// Port of Factory's harness/mission_analysis.py and mission_contracts.py.
//
// Usage: node validate-schema.mjs <mission-path> [--strict]
// Exit code: 0 if no errors, 1 if errors. Warnings never fail unless --strict.
//
// Checks performed:
//   - state.json: required keys, enum values, type checks
//   - features.json: required keys, enum values, duplicate IDs, worker session refs
//   - validation-state.json: assertion statuses, validatedAtMilestone presence
//   - model-settings.json: allowed keys, type checks
//   - working_directory.txt vs state.json.workingDirectory consistency
//   - feature.fulfills references must exist in validation-state.json
//   - mission state vs feature completion divergence
//   - orphan assertions (warning only)
//   - completedWorkerSessionId presence on completed features (warning only)
//   - assertions validated at milestones not in feature set (warning only)

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

const ALLOWED_MISSION_STATES = new Set(["completed", "orchestrator_turn", "paused", "running"]);
const ALLOWED_FEATURE_STATUSES = new Set(["cancelled", "completed", "in_progress", "pending"]);
// Internal-only statuses: both map to pending for Factory harness
// compatibility (see STALE_STATUS_ERROR_RE / BLOCKED_STATUS_ERROR_RE in
// validate-mission.mjs) but are first-class values here:
//   - "stale"   invalidate-stale-evidence.mjs: proof's contract hash
//               drifted past the current validation-contract.md text.
//   - "blocked" execute-assertion.mjs: dispatcher returned status=blocked
//               because the evidence was narrative-only and no recognizer
//               produced a runnable plan. Recorded (v0.8.1+) so downstream
//               validators report it clearly instead of leaving the
//               assertion silently pending forever.
const ALLOWED_ASSERTION_STATUSES = new Set(["failed", "passed", "pending", "stale", "blocked"]);

const STATE_REQUIRED_KEYS = [
  "missionId",
  "state",
  "workingDirectory",
  "createdAt",
  "updatedAt",
  "lastReviewedHandoffCount",
];

const FEATURE_REQUIRED_KEYS = [
  "id",
  "description",
  "skillName",
  "preconditions",
  "expectedBehavior",
  "verificationSteps",
  "milestone",
  "status",
  "workerSessionIds",
];

const FEATURE_OPTIONAL_KEYS = new Set([
  "fulfills",
  "currentWorkerSessionId",
  "completedWorkerSessionId",
]);

const MODEL_SETTING_KEYS = new Set([
  "workerModel",
  "workerReasoningEffort",
  "validationWorkerModel",
  "validationWorkerReasoningEffort",
  "skipUserTesting",
]);

function loadJson(path, label, errors) {
  if (!existsSync(path)) {
    errors.push(`${label} is missing ${path.split("/").pop()}`);
    return null;
  }
  try {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      errors.push(`${label} must contain a JSON object`);
      return null;
    }
    return payload;
  } catch (err) {
    errors.push(`${label} is not valid JSON: ${err.message}`);
    return null;
  }
}

function loadOptionalJson(path, label, errors) {
  if (!existsSync(path)) return null;
  return loadJson(path, label, errors);
}

function loadSessionIndexIds(missionPath) {
  // sessions-index.json lives at the Factory root (parent of missions/).
  // Walk up from the mission dir looking for it.
  let current = resolve(missionPath);
  for (let i = 0; i < 6; i++) {
    const candidate = join(current, "sessions-index.json");
    if (existsSync(candidate)) {
      try {
        const payload = JSON.parse(readFileSync(candidate, "utf8"));
        const entries = Array.isArray(payload?.entries) ? payload.entries : [];
        return new Set(
          entries
            .filter((e) => e && typeof e.sessionId === "string")
            .map((e) => e.sessionId),
        );
      } catch {
        return new Set();
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return new Set();
}

function isStringList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateState(missionName, state) {
  const label = `missions/${missionName}/state.json`;
  const errors = [];
  for (const key of STATE_REQUIRED_KEYS) {
    if (!(key in state)) errors.push(`${label} is missing required key '${key}'`);
  }
  let missionState = state.state;
  const updatedAt = state.updatedAt;
  let workingDirectory = state.workingDirectory;

  if (missionState !== undefined && typeof missionState !== "string") {
    errors.push(`${label} key 'state' must be a string`);
    missionState = null;
  } else if (missionState && !ALLOWED_MISSION_STATES.has(missionState)) {
    errors.push(`${label} has invalid state '${missionState}'`);
  }

  if (workingDirectory !== undefined && typeof workingDirectory !== "string") {
    errors.push(`${label} key 'workingDirectory' must be a string`);
    workingDirectory = null;
  }
  if (updatedAt !== undefined && typeof updatedAt !== "string") {
    errors.push(`${label} key 'updatedAt' must be a string`);
  }
  if ("lastReviewedHandoffCount" in state && !Number.isInteger(state.lastReviewedHandoffCount)) {
    errors.push(`${label} key 'lastReviewedHandoffCount' must be an integer`);
  }
  for (const key of ["missionId", "createdAt"]) {
    if (key in state && typeof state[key] !== "string") {
      errors.push(`${label} key '${key}' must be a string`);
    }
  }
  return { errors, missionState: missionState || null, workingDirectory: workingDirectory || null };
}

function validateModelSettings(missionName, payload) {
  const label = `missions/${missionName}/model-settings.json`;
  const errors = [];
  const unknown = Object.keys(payload).filter((k) => !MODEL_SETTING_KEYS.has(k));
  if (unknown.length) {
    errors.push(`${label} has unknown keys: [${unknown.sort().map((k) => `'${k}'`).join(", ")}]`);
  }
  for (const [key, value] of Object.entries(payload)) {
    if (key === "skipUserTesting") {
      if (typeof value !== "boolean") errors.push(`${label} key 'skipUserTesting' must be a boolean`);
    } else if (typeof value !== "string") {
      errors.push(`${label} key '${key}' must be a string`);
    }
  }
  return errors;
}

function validateFeatures(missionName, payload, sessionIndexIds) {
  const label = `missions/${missionName}/features.json`;
  const errors = [];
  const metrics = {
    featureStatuses: {},
    milestones: new Set(),
    fulfilledAssertions: new Set(),
    allFeaturesCompleted: false,
    missingCompletedRefs: [],
    unresolvedSessionRefs: [],
    workerSessionRefTotal: 0,
    workerSessionRefMatched: 0,
  };

  const features = payload.features;
  if (!Array.isArray(features)) {
    errors.push(`${label} key 'features' must be a list`);
    return { errors, metrics };
  }

  const seenIds = new Set();
  metrics.allFeaturesCompleted = features.length > 0;

  features.forEach((feature, index) => {
    const prefix = `${label} feature[${index}]`;
    if (typeof feature !== "object" || feature === null || Array.isArray(feature)) {
      errors.push(`${prefix} must be an object`);
      metrics.allFeaturesCompleted = false;
      return;
    }

    const knownKeys = new Set([...FEATURE_REQUIRED_KEYS, ...FEATURE_OPTIONAL_KEYS]);
    const unknown = Object.keys(feature).filter((k) => !knownKeys.has(k));
    if (unknown.length) {
      errors.push(`${prefix} has unknown keys: [${unknown.sort().map((k) => `'${k}'`).join(", ")}]`);
    }
    for (const key of FEATURE_REQUIRED_KEYS) {
      if (!(key in feature)) errors.push(`${prefix} is missing required key '${key}'`);
    }

    const featureId = feature.id;
    if (typeof featureId !== "string") {
      errors.push(`${prefix} key 'id' must be a string`);
    } else if (seenIds.has(featureId)) {
      errors.push(`${label} has duplicate feature id '${featureId}'`);
    } else {
      seenIds.add(featureId);
    }

    for (const key of ["description", "skillName", "milestone"]) {
      if (key in feature && typeof feature[key] !== "string") {
        errors.push(`${prefix} key '${key}' must be a string`);
      }
    }

    const status = feature.status;
    if (typeof status !== "string") {
      errors.push(`${prefix} key 'status' must be a string`);
      metrics.allFeaturesCompleted = false;
    } else {
      metrics.featureStatuses[status] = (metrics.featureStatuses[status] || 0) + 1;
      if (!ALLOWED_FEATURE_STATUSES.has(status)) {
        errors.push(`${prefix} has invalid feature status '${status}'`);
      }
      if (status !== "completed") metrics.allFeaturesCompleted = false;
    }

    for (const key of ["preconditions", "expectedBehavior", "verificationSteps", "workerSessionIds"]) {
      if (key in feature && !isStringList(feature[key])) {
        errors.push(`${prefix} key '${key}' must be a list of strings`);
      }
    }

    const fulfills = feature.fulfills;
    if (fulfills !== undefined && fulfills !== null && !isStringList(fulfills)) {
      errors.push(`${prefix} key 'fulfills' must be a list of strings`);
    } else if (Array.isArray(fulfills)) {
      fulfills.forEach((f) => metrics.fulfilledAssertions.add(f));
    }

    if (typeof feature.milestone === "string") metrics.milestones.add(feature.milestone);

    const workerSessionIds = feature.workerSessionIds;
    if (Array.isArray(workerSessionIds)) {
      for (const sid of workerSessionIds) {
        metrics.workerSessionRefTotal += 1;
        if (sessionIndexIds.has(sid)) {
          metrics.workerSessionRefMatched += 1;
        } else if (sessionIndexIds.size > 0) {
          // Only flag if we actually have an index to check against.
          metrics.unresolvedSessionRefs.push([missionName, featureId || `feature[${index}]`, sid]);
        }
      }
    }

    const completedRef = feature.completedWorkerSessionId;
    if (completedRef !== undefined && completedRef !== null && typeof completedRef !== "string") {
      errors.push(`${prefix} key 'completedWorkerSessionId' must be a string or null`);
    }
    const currentRef = feature.currentWorkerSessionId;
    if ("currentWorkerSessionId" in feature && currentRef !== null && typeof currentRef !== "string") {
      errors.push(`${prefix} key 'currentWorkerSessionId' must be a string or null`);
    }
    if (status === "completed" && Array.isArray(workerSessionIds) && workerSessionIds.length > 0 && !completedRef) {
      metrics.missingCompletedRefs.push([missionName, featureId || `feature[${index}]`]);
    }
  });

  return { errors, metrics };
}

function validateValidationState(missionName, payload) {
  const label = `missions/${missionName}/validation-state.json`;
  const errors = [];
  const metrics = {
    assertionNames: new Set(),
    assertionStatuses: {},
    missingValidatedAt: [],
    missingProof: [],
    validatedAt: [],
  };

  const assertions = payload.assertions;
  if (typeof assertions !== "object" || assertions === null || Array.isArray(assertions)) {
    errors.push(`${label} key 'assertions' must be an object`);
    return { errors, metrics };
  }

  for (const [assertionId, assertion] of Object.entries(assertions)) {
    metrics.assertionNames.add(assertionId);
    if (typeof assertion !== "object" || assertion === null || Array.isArray(assertion)) {
      errors.push(`${label} assertion '${assertionId}' must be an object`);
      continue;
    }
    const status = assertion.status;
    if (typeof status !== "string") {
      errors.push(`${label} assertion '${assertionId}' must have string status`);
      continue;
    }
    metrics.assertionStatuses[status] = (metrics.assertionStatuses[status] || 0) + 1;
    if (!ALLOWED_ASSERTION_STATUSES.has(status)) {
      errors.push(`${label} assertion '${assertionId}' has invalid status '${status}'`);
    }
    const validatedAt = assertion.validatedAtMilestone;
    if (validatedAt !== undefined && validatedAt !== null && typeof validatedAt !== "string") {
      errors.push(`${label} assertion '${assertionId}' key 'validatedAtMilestone' must be a string`);
    }
    if (status === "passed" && !validatedAt) {
      metrics.missingValidatedAt.push([missionName, assertionId]);
    }
    // A passed assertion without a `proof` block is the bee21e7c failure
    // mode: status seeded from prior-session text instead of a live execute.
    // Warn here so operators notice even if they bypass the critic.
    // v0.6.0: dropped the commitSha check; proof block must exist with a
    // toolType + command (the minimum shape recordAssertion now writes).
    if (status === "passed" && (!assertion.proof || !assertion.proof.toolType || !assertion.proof.command)) {
      metrics.missingProof.push([missionName, assertionId]);
    }
    if (typeof validatedAt === "string") {
      metrics.validatedAt.push([assertionId, validatedAt]);
    }
  }
  return { errors, metrics };
}

// v0.8.1: emit per-entry lines instead of a single "N across M mission(s)"
// roll-up. This scope runs inside a single mission (validate-mission.mjs
// scoped the harness call with targetMissionId), so the cross-mission
// pluralization ("across N mission(s)") always said "across 1 mission(s)"
// -- pure noise that crowded out real signal. Per-entry output lets the
// operator triage warnings one-by-one and keeps the CI-friendly format
// (one emitted warning per concrete issue).
//
// Each entry is an Array whose non-null components are joined with "/".
// Typical shapes:
//   [missionName, assertionId]             -> "missions/<name>/<id> <label>"
//   [missionName, assertionId, milestone]  -> "missions/<name>/<id> <label> (<milestone>)"
//   [missionName, featureOrAssertionId]    -> "missions/<name>/<id> <label>"
function summarize(label, entries, note) {
  if (!entries.length) return [];
  const suffix = note ? ` -- ${note}` : "";
  return entries.map((e) => {
    const parts = (Array.isArray(e) ? e : [e]).filter((p) => p != null && p !== "");
    const qualifier = parts.length > 0 ? `missions/${parts.join("/")} ` : "";
    return `${qualifier}${label}${suffix}`;
  });
}

function validateMissionSchema(missionPath) {
  const dir = resolve(missionPath);
  if (!existsSync(dir)) {
    return { ok: false, errors: [`Mission path not found: ${dir}`], warnings: [], metrics: null };
  }
  const missionName = dir.split("/").pop();
  const errors = [];
  const warnings = [];

  const sessionIndexIds = loadSessionIndexIds(dir);

  const state = loadJson(join(dir, "state.json"), `missions/${missionName}`, errors);
  const featuresDoc = loadJson(join(dir, "features.json"), `missions/${missionName}`, errors);
  const validationState = loadJson(join(dir, "validation-state.json"), `missions/${missionName}`, errors);
  const modelSettings = loadOptionalJson(join(dir, "model-settings.json"), `missions/${missionName}`, errors);

  const workingDirPath = join(dir, "working_directory.txt");
  let workingDirText = "";
  if (existsSync(workingDirPath)) {
    workingDirText = readFileSync(workingDirPath, "utf8").trim();
  } else {
    errors.push(`missions/${missionName} is missing working_directory.txt`);
  }

  let missionState = null;
  let workingDirState = null;
  if (state) {
    const r = validateState(missionName, state);
    errors.push(...r.errors);
    missionState = r.missionState;
    workingDirState = r.workingDirectory;
  }
  if (workingDirText && workingDirState && workingDirText !== workingDirState) {
    errors.push(`missions/${missionName}/working_directory.txt does not match state.json.workingDirectory`);
  }

  let featureMetrics = { featureStatuses: {}, milestones: new Set(), fulfilledAssertions: new Set(), allFeaturesCompleted: false, missingCompletedRefs: [], unresolvedSessionRefs: [], workerSessionRefTotal: 0, workerSessionRefMatched: 0 };
  if (featuresDoc) {
    const r = validateFeatures(missionName, featuresDoc, sessionIndexIds);
    errors.push(...r.errors);
    featureMetrics = r.metrics;
  }

  let assertionMetrics = { assertionNames: new Set(), assertionStatuses: {}, missingValidatedAt: [], missingProof: [], validatedAt: [] };
  if (validationState) {
    const r = validateValidationState(missionName, validationState);
    errors.push(...r.errors);
    assertionMetrics = r.metrics;
  }

  // feature.fulfills must reference existing assertions
  const missingRefs = [...featureMetrics.fulfilledAssertions].filter((a) => !assertionMetrics.assertionNames.has(a)).sort();
  for (const assertionId of missingRefs) {
    errors.push(`missions/${missionName}/features.json references missing assertion '${assertionId}' in validation-state.json`);
  }

  // Orphan assertions: in validation-state but not referenced by any feature
  const orphans = [...assertionMetrics.assertionNames].filter((a) => !featureMetrics.fulfilledAssertions.has(a)).sort();
  const orphanEntries = orphans.map((a) => [missionName, a]);

  // assertions validated at a milestone not in feature set
  const unknownMilestones = assertionMetrics.validatedAt
    .filter(([, m]) => !featureMetrics.milestones.has(m))
    .map(([a, m]) => [missionName, a, m]);

  // completion state divergence
  const divergence = [];
  if (missionState && Object.keys(featureMetrics.featureStatuses).length > 0) {
    if (featureMetrics.allFeaturesCompleted && missionState !== "completed") {
      divergence.push([missionName, missionState, "all features completed"]);
    }
    if (missionState === "completed" && !featureMetrics.allFeaturesCompleted) {
      divergence.push([missionName, missionState, "features still incomplete"]);
    }
  }

  if (modelSettings) {
    errors.push(...validateModelSettings(missionName, modelSettings));
  }

  // v0.8.1: bucket by severity.
  //   warnings -- real signal, operator should investigate before completion
  //   infos    -- cosmetic drift / bookkeeping gaps that don't compromise
  //              evidence integrity (proof-bearing assertions or completion
  //              correctness). Still surfaced so nothing is silently hidden.
  //
  // Routing rationale:
  //   - missingValidatedAt / orphanEntries / unresolvedSessionRefs /
  //     missingCompletedRefs are metadata gaps; they don't affect whether
  //     recorded proofs are trustworthy.
  //   - missingProof / unknownMilestones / divergence ARE trust signals:
  //     the proof block is the integrity handle (bee21e7c regression); a
  //     feature/mission-state mismatch flags a sync bug somewhere.
  const infos = [];
  warnings.push(...summarize("passed assertion missing a `proof` block (not execute-assertion.mjs output)", assertionMetrics.missingProof, "not trusted by the two-stage critic"));
  warnings.push(...summarize("assertion references a milestone not present in mission features", unknownMilestones));
  warnings.push(...summarize("mission completion state diverges from feature completion", divergence));
  infos.push(...summarize("passed assertion missing validatedAtMilestone", assertionMetrics.missingValidatedAt));
  infos.push(...summarize("completed feature with workerSessionIds lacks a non-null completedWorkerSessionId", featureMetrics.missingCompletedRefs));
  infos.push(...summarize("assertion is not fulfilled by any feature (orphan)", orphanEntries));
  infos.push(...summarize("worker session reference does not resolve in sessions-index.json", featureMetrics.unresolvedSessionRefs, "info only until session retention policy is defined"));

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    infos,
    metrics: {
      missionName,
      missionState,
      workingDirectory: workingDirState || workingDirText,
      featureStatuses: featureMetrics.featureStatuses,
      assertionStatuses: assertionMetrics.assertionStatuses,
      allFeaturesCompleted: featureMetrics.allFeaturesCompleted,
      milestones: [...featureMetrics.milestones],
      assertionCount: assertionMetrics.assertionNames.size,
      fulfilledCount: featureMetrics.fulfilledAssertions.size,
      orphanAssertionCount: orphans.length,
      divergenceDetected: divergence.length > 0,
      completionDivergence: divergence,
      missingValidatedAtCount: assertionMetrics.missingValidatedAt.length,
    },
  };
}

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain && process.argv[2]) {
  const strict = process.argv.includes("--strict");
  const result = validateMissionSchema(process.argv[2]);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  const failed = !result.ok || (strict && result.warnings.length > 0);
  process.exit(failed ? 1 : 0);
} else if (isMain) {
  process.stderr.write("Usage: node validate-schema.mjs <mission-path> [--strict]\n");
  process.exit(1);
}

export { validateMissionSchema };
