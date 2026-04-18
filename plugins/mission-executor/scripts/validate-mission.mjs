#!/usr/bin/env node
// Combined mission validator.
//
// Runs two passes against a mission directory:
//   1. Native JS schema validation (validate-schema.mjs) -- always runs.
//   2. Factory's Python harness (python3 -m harness.check_missions) -- when available.
//
// The Python harness lives at .factory/scripts/harness/ relative to some ancestor.
// We try to locate it; if found, we shell out for a second opinion. If not, we
// proceed with JS-only validation.
//
// Usage: node validate-mission.mjs <mission-path> [--strict] [--json]
// Exit code: 0 if no errors from either pass, 1 otherwise.

import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { execSync } from "node:child_process";

import { validateMissionSchema } from "./validate-schema.mjs";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

function findFactoryHarness(missionPath) {
  // Walk up from the mission dir looking for .factory/scripts/harness/ or scripts/harness/.
  let current = resolve(missionPath);
  for (let i = 0; i < 8; i++) {
    for (const candidate of [
      join(current, ".factory", "scripts", "harness", "check_missions.py"),
      join(current, "scripts", "harness", "check_missions.py"),
    ]) {
      if (existsSync(candidate)) {
        return { harnessPath: candidate, harnessRoot: dirname(dirname(candidate)) };
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function runPythonHarness(harnessRoot, targetMissionId = null) {
  // harnessRoot is .factory/scripts/. The Python module is scripts.harness.check_missions
  // so we cd to the Factory root (parent of scripts/) and run `python3 -m scripts.harness.check_missions`.
  const factoryRoot = dirname(harnessRoot);
  try {
    const out = execSync("python3 -m scripts.harness.check_missions", {
      cwd: factoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = parseHarnessOutput(out, targetMissionId);
    return { ok: parsed.errors.length === 0, output: out, errors: parsed.errors, warnings: parsed.warnings };
  } catch (err) {
    const stdout = err.stdout?.toString() || "";
    const stderr = err.stderr?.toString() || "";
    const combined = stdout + stderr;
    const parsed = parseHarnessOutput(combined, targetMissionId);
    return { ok: parsed.errors.length === 0, output: combined, errors: parsed.errors, warnings: parsed.warnings };
  }
}

// Factory harness rejects any status not in its allow-list. "stale" is a
// plugin-internal status (see invalidate-stale-evidence.mjs) that maps to
// `pending` for harness compatibility. Filter those errors out so we
// don't double-report them as blockers.
const STALE_STATUS_ERROR_RE = /invalid status 'stale'/;

function parseHarnessOutput(text, targetMissionId = null) {
  // When targetMissionId is provided, only report errors/warnings whose
  // message mentions that mission id. Factory's harness scans every
  // mission in .factory/missions/ and reports errors globally; we only
  // care about the one we're executing.
  const errors = [];
  const warnings = [];
  const mentionsTarget = (msg) => !targetMissionId || msg.includes(targetMissionId);
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("ERROR ")) {
      const msg = t.slice(6);
      if (STALE_STATUS_ERROR_RE.test(msg)) continue;
      if (!mentionsTarget(msg)) continue;
      errors.push(msg);
    } else if (t.startsWith("WARN ")) {
      const msg = t.slice(5);
      if (!mentionsTarget(msg)) continue;
      warnings.push(msg);
    }
  }
  return { errors, warnings };
}

function validateMission(missionPath, options = {}) {
  const strict = !!options.strict;

  // Pass 1: JS schema validation (always runs)
  const js = validateMissionSchema(missionPath);

  // Pass 2: Python harness (if available). Scope to this mission only --
  // Factory's harness scans every mission in .factory/missions/ and reports
  // errors globally, but we only want to block on errors for the mission
  // we're executing.
  const harness = findFactoryHarness(missionPath);
  const targetMissionId = resolve(missionPath).split("/").pop();
  let py = null;
  if (harness) {
    py = runPythonHarness(harness.harnessRoot, targetMissionId);
  }

  const errors = [...js.errors];
  const warnings = [...js.warnings];
  if (py) {
    for (const e of py.errors) if (!errors.includes(e)) errors.push(e);
    for (const w of py.warnings) if (!warnings.includes(w)) warnings.push(w);
  }

  const ok = errors.length === 0 && (!strict || warnings.length === 0);

  return {
    ok,
    passes: {
      js: { ok: js.ok, errors: js.errors, warnings: js.warnings, metrics: js.metrics },
      python: py ? { ok: py.ok, errors: py.errors, warnings: py.warnings, available: true } : { available: false },
    },
    combined: { errors, warnings },
    metrics: js.metrics,
  };
}

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain && process.argv[2]) {
  const strict = process.argv.includes("--strict");
  const jsonOut = process.argv.includes("--json");
  const result = validateMission(process.argv[2], { strict });

  if (jsonOut) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(`SCHEMA: ${result.passes.js.ok ? "ok" : "FAILED"} (${result.passes.js.errors.length} errors, ${result.passes.js.warnings.length} warnings)\n`);
    if (result.passes.python.available) {
      process.stdout.write(`HARNESS: ${result.passes.python.ok ? "ok" : "FAILED"} (${result.passes.python.errors.length} errors, ${result.passes.python.warnings.length} warnings)\n`);
    } else {
      process.stdout.write("HARNESS: not available (Factory harness not found in ancestor path)\n");
    }
    for (const e of result.combined.errors) process.stdout.write(`ERROR ${e}\n`);
    for (const w of result.combined.warnings) process.stdout.write(`WARN  ${w}\n`);
  }

  process.exit(result.ok ? 0 : 1);
} else if (isMain) {
  process.stderr.write("Usage: node validate-mission.mjs <mission-path> [--strict] [--json]\n");
  process.exit(1);
}

export { validateMission };
