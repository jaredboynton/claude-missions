#!/usr/bin/env node
// Record an assertion result in validation-state.json with a required `proof`
// object for any `passed` write.
//
// WHY: prior versions let status be set without proof. The bee21e7c mission
// run recorded "critic-confirmed in prior session" as evidence for 95/95
// passed assertions with no executed command. This script now refuses that
// pattern at the API boundary.
//
// Usage:
//   node record-assertion.mjs <mission-path>
//     --id=VAL-XXX-NNN
//     --status=passed|failed|pending|stale
//     [--evidence=<str>]
//
// Additional flags REQUIRED when --status=passed:
//     --commit-sha=<40-char HEAD sha>
//     --tool-type=unit-test|curl|cli-binary|tuistory|literal-probe
//     --command=<exact command string>
//     --exit-code=<int>
//     --stdout-path=<path relative to working-dir or mission-dir>
//     --stderr-path=<path relative to working-dir or mission-dir>
//     --touchpoints=<comma-separated list of source paths>
//
// Optional:
//     --executor=<script name, default "execute-assertion.mjs">
//     --working-dir=<path used to resolve stdout/stderr paths>

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

const REQUIRED_PROOF_FIELDS_ON_PASS = [
  "commit-sha",
  "tool-type",
  "command",
  "exit-code",
  "stdout-path",
  "stderr-path",
  "touchpoints",
];

const ALLOWED_TOOL_TYPES = new Set([
  "unit-test",
  "curl",
  "cli-binary",
  "tuistory",
  "literal-probe",
]);

function buildAssertionMilestoneMap(missionPath) {
  const fp = join(missionPath, "features.json");
  if (!existsSync(fp)) return {};
  const doc = JSON.parse(readFileSync(fp, "utf8"));
  const map = {};
  for (const f of doc.features || []) {
    const milestone = f.milestone;
    if (typeof milestone !== "string") continue;
    for (const aid of f.fulfills || []) {
      if (!map[aid]) map[aid] = milestone;
    }
  }
  return map;
}

function sha256File(path) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

function resolveArtifact(pathArg, workingDir, missionPath) {
  if (!pathArg) return null;
  if (isAbsolute(pathArg)) return pathArg;
  // Prefer workingDir; fall back to missionPath.
  const wdCandidate = workingDir ? join(workingDir, pathArg) : null;
  if (wdCandidate && existsSync(wdCandidate)) return wdCandidate;
  const mpCandidate = join(missionPath, pathArg);
  if (existsSync(mpCandidate)) return mpCandidate;
  return pathArg;
}

function buildProof(args, missionPath) {
  const workingDir = args["working-dir"] || null;
  const stdoutAbs = resolveArtifact(args["stdout-path"], workingDir, missionPath);
  const stderrAbs = resolveArtifact(args["stderr-path"], workingDir, missionPath);

  const stdoutSha = sha256File(stdoutAbs);
  const stderrSha = sha256File(stderrAbs);

  const touchpoints = typeof args.touchpoints === "string"
    ? args.touchpoints.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    commitSha: args["commit-sha"],
    toolType: args["tool-type"],
    command: args.command,
    exitCode: Number(args["exit-code"]),
    stdoutPath: args["stdout-path"],
    stderrPath: args["stderr-path"],
    stdoutSha256: stdoutSha,
    stderrSha256: stderrSha,
    touchpoints,
    executedAt: new Date().toISOString(),
    executor: args.executor || "execute-assertion.mjs",
  };
}

function validateProofArgs(args) {
  const errors = [];
  for (const flag of REQUIRED_PROOF_FIELDS_ON_PASS) {
    if (args[flag] === undefined || args[flag] === "" || args[flag] === true) {
      errors.push(`missing required flag --${flag}`);
    }
  }
  if (args["commit-sha"] && !/^[0-9a-f]{7,40}$/i.test(args["commit-sha"])) {
    errors.push(`--commit-sha must be a hex SHA (7-40 chars), got '${args["commit-sha"]}'`);
  }
  if (args["tool-type"] && !ALLOWED_TOOL_TYPES.has(args["tool-type"])) {
    errors.push(`--tool-type must be one of ${[...ALLOWED_TOOL_TYPES].join("|")}, got '${args["tool-type"]}'`);
  }
  if (args["exit-code"] !== undefined && Number.isNaN(Number(args["exit-code"]))) {
    errors.push(`--exit-code must be an integer, got '${args["exit-code"]}'`);
  }
  return errors;
}

function recordAssertion(missionPath, args) {
  const dir = resolve(missionPath);
  const vpath = join(dir, "validation-state.json");
  if (!existsSync(vpath)) {
    return { ok: false, error: "validation-state.json not found" };
  }
  const { id, status, evidence } = args;

  if (status === "passed") {
    const errors = validateProofArgs(args);
    if (errors.length) {
      return {
        ok: false,
        error: `cannot record '${id}' as passed without proof: ${errors.join("; ")}`,
      };
    }
  }

  const vs = JSON.parse(readFileSync(vpath, "utf8"));
  vs.assertions = vs.assertions || {};

  const milestoneMap = buildAssertionMilestoneMap(dir);
  const entry = vs.assertions[id] || {};
  entry.status = status;
  if (evidence) entry.evidence = evidence;

  if (status === "passed") {
    const milestone = milestoneMap[id];
    if (milestone) entry.validatedAtMilestone = milestone;
    entry.proof = buildProof(args, dir);
  } else {
    // Non-passed statuses clear stale proof so an old proof cannot leak
    // into a subsequent passed write that did not re-execute.
    delete entry.proof;
  }

  vs.assertions[id] = entry;
  writeFileSync(vpath, JSON.stringify(vs, null, 2) + "\n");

  return {
    ok: true,
    id,
    status,
    validatedAtMilestone: entry.validatedAtMilestone || null,
    proofRecorded: !!entry.proof,
  };
}

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain && process.argv[2]) {
  const missionPath = process.argv[2];
  const args = Object.fromEntries(
    process.argv.slice(3).filter((a) => a.startsWith("--")).map((a) => {
      const [k, ...v] = a.substring(2).split("=");
      return [k, v.join("=") || true];
    })
  );
  if (!args.id || !args.status) {
    process.stderr.write(
      "Usage: node record-assertion.mjs <mission-path> --id=VAL-... --status=passed|failed|pending|stale [--evidence=...]\n" +
      "When --status=passed, also required: --commit-sha --tool-type --command --exit-code --stdout-path --stderr-path --touchpoints\n"
    );
    process.exit(1);
  }
  const result = recordAssertion(missionPath, args);
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { recordAssertion };
