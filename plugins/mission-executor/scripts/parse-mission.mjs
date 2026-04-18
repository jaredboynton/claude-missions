#!/usr/bin/env node
// Parse and validate a Factory mission directory.
// Usage: node parse-mission.mjs <mission-path>
// Outputs: JSON with parsed features, assertions, boundaries, and state.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

function parseMission(missionPath) {
  const dir = resolve(missionPath);
  const required = ["features.json", "validation-contract.md", "validation-state.json", "state.json", "AGENTS.md"];
  const missing = required.filter((f) => !existsSync(join(dir, f)));

  if (missing.length > 0) {
    return { ok: false, error: `Missing required files: ${missing.join(", ")}`, path: dir };
  }

  const features = JSON.parse(readFileSync(join(dir, "features.json"), "utf8")).features;
  const valState = JSON.parse(readFileSync(join(dir, "validation-state.json"), "utf8"));
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const agentsMd = readFileSync(join(dir, "AGENTS.md"), "utf8");
  const contract = readFileSync(join(dir, "validation-contract.md"), "utf8");

  let workingDir = null;
  const wdPath = join(dir, "working_directory.txt");
  if (existsSync(wdPath)) {
    workingDir = readFileSync(wdPath, "utf8").trim();
  }

  const milestones = [...new Set(features.map((f) => f.milestone))];
  const milestoneGroups = {};
  for (const m of milestones) {
    milestoneGroups[m] = features.filter((f) => f.milestone === m);
  }

  const assertions = parseAssertions(contract);
  const boundaries = parseBoundaries(agentsMd);
  const buildCommand = extractBuildCommand(agentsMd);
  const protectedPaths = extractProtectedPaths(agentsMd);

  const featureSummary = {
    total: features.length,
    pending: features.filter((f) => f.status === "pending").length,
    in_progress: features.filter((f) => f.status === "in_progress").length,
    completed: features.filter((f) => f.status === "completed").length,
  };

  const assertionSummary = {
    total: Object.keys(valState.assertions || {}).length,
    passed: Object.values(valState.assertions || {}).filter((a) => a.status === "passed").length,
    failed: Object.values(valState.assertions || {}).filter((a) => a.status === "failed").length,
    pending: Object.values(valState.assertions || {}).filter((a) => a.status === "pending").length,
  };

  return {
    ok: true,
    path: dir,
    missionId: state.missionId,
    state: state.state,
    workingDirectory: workingDir || state.workingDirectory,
    features,
    milestones,
    milestoneGroups,
    assertions,
    boundaries,
    buildCommand,
    protectedPaths,
    featureSummary,
    assertionSummary,
    valState,
  };
}

function parseAssertions(contract) {
  const assertions = [];
  const lines = contract.split("\n");
  let current = null;

  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(VAL-[A-Z]+-\d+[a-z]?):\s*(.+)/);
    if (headerMatch) {
      if (current) assertions.push(current);
      current = { id: headerMatch[1], title: headerMatch[2].trim(), tool: null, evidence: null, description: "" };
      continue;
    }

    if (current) {
      const toolMatch = line.match(/^Tool:\s*(.+)/);
      if (toolMatch) {
        current.tool = toolMatch[1].trim();
        continue;
      }
      const evidenceMatch = line.match(/^Evidence:\s*(.+)/);
      if (evidenceMatch) {
        current.evidence = evidenceMatch[1].trim();
        continue;
      }
      if (line.startsWith("---")) {
        assertions.push(current);
        current = null;
        continue;
      }
      if (line.trim()) {
        current.description += line.trim() + " ";
      }
    }
  }
  if (current) assertions.push(current);

  return assertions;
}

function parseBoundaries(agentsMd) {
  const rules = [];
  for (const line of agentsMd.split("\n")) {
    if (/never|NEVER|do not|DO NOT|off-limits|OFF-LIMITS/i.test(line) && line.trim().startsWith("-")) {
      rules.push(line.trim().replace(/^-\s*/, ""));
    }
  }
  return rules;
}

function extractBuildCommand(agentsMd) {
  for (const line of agentsMd.split("\n")) {
    if (/build.*MUST|MUST.*build|non-negotiable.*build/i.test(line)) {
      const cmdMatch = line.match(/`([^`]+)`/);
      if (cmdMatch) return cmdMatch[1];
    }
  }
  return null;
}

function extractProtectedPaths(agentsMd) {
  const paths = [];
  for (const line of agentsMd.split("\n")) {
    if (/never.*stage|off-limits|do not touch|pre-existing/i.test(line)) {
      const matches = line.matchAll(/`([^`]+)`/g);
      for (const m of matches) {
        if (m[1].includes("/") || m[1].includes(".")) paths.push(m[1]);
      }
    }
  }
  return paths;
}

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain) {
  if (process.argv[2]) {
    const result = parseMission(process.argv[2]);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stderr.write("Usage: node parse-mission.mjs <mission-path>\n");
    process.exit(1);
  }
}

export { parseMission };
