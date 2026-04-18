#!/usr/bin/env node
// Evaluate mission validation state and determine pass/fail.
// Usage: node critic-evaluator.mjs <mission-path>
// Outputs: JSON verdict with counts and specific failures.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function evaluateMission(missionPath) {
  const dir = resolve(missionPath);
  const valStatePath = join(dir, "validation-state.json");

  if (!existsSync(valStatePath)) {
    return { verdict: "ERROR", message: "validation-state.json not found", counts: {} };
  }

  const valState = JSON.parse(readFileSync(valStatePath, "utf8"));
  const assertions = valState.assertions || {};

  const counts = { total: 0, passed: 0, failed: 0, pending: 0, blocked: 0 };
  const failures = [];
  const pending = [];

  for (const [id, entry] of Object.entries(assertions)) {
    counts.total++;
    const status = entry.status || "pending";

    switch (status) {
      case "passed":
        counts.passed++;
        break;
      case "failed":
        counts.failed++;
        failures.push({ id, reason: entry.reason || "No reason recorded", evidence: entry.evidence });
        break;
      case "blocked":
        counts.blocked++;
        pending.push({ id, reason: entry.reason || "Blocked - feature not implemented" });
        break;
      default:
        counts.pending++;
        pending.push({ id, reason: "Not yet validated" });
    }
  }

  // Check for evidence files
  const evidenceDir = join(resolve(valState.workingDirectory || "."), ".omc", "validation");
  let evidenceFileCount = 0;
  if (existsSync(evidenceDir)) {
    evidenceFileCount = readdirSync(evidenceDir).filter((f) => f.endsWith(".md")).length;
  }

  const allPassed = counts.failed === 0 && counts.pending === 0 && counts.blocked === 0 && counts.passed === counts.total;

  if (allPassed) {
    return {
      verdict: "PASS",
      message: "all validation criteria have been met",
      counts,
      evidenceFiles: evidenceFileCount,
    };
  }

  const verdict = counts.failed > 0 ? "FAIL" : "INCOMPLETE";

  return {
    verdict,
    message: counts.failed > 0
      ? `BLOCKED: ${failures.map((f) => `${f.id} (${f.reason})`).join(", ")}`
      : `INCOMPLETE: ${counts.pending + counts.blocked} assertions not yet validated`,
    counts,
    failures,
    pending: pending.slice(0, 20),
    evidenceFiles: evidenceFileCount,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && process.argv[2]) {
  const result = evaluateMission(process.argv[2]);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

export { evaluateMission };
