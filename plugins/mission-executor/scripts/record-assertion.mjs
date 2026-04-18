#!/usr/bin/env node
// Record an assertion result in validation-state.json with schema-correct fields.
// Always populates validatedAtMilestone by looking up feature.fulfills in features.json.
//
// Usage:
//   node record-assertion.mjs <mission-path> --id=VAL-XXX-NNN --status=passed|failed|pending [--evidence=<str>]
//
// Without this helper, hand-written writes forget validatedAtMilestone and fail
// Factory harness checks.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

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

function recordAssertion(missionPath, { id, status, evidence }) {
  const dir = resolve(missionPath);
  const vpath = join(dir, "validation-state.json");
  if (!existsSync(vpath)) {
    return { ok: false, error: "validation-state.json not found" };
  }
  const vs = JSON.parse(readFileSync(vpath, "utf8"));
  vs.assertions = vs.assertions || {};

  const milestoneMap = buildAssertionMilestoneMap(dir);
  const entry = vs.assertions[id] || {};
  entry.status = status;
  if (evidence) entry.evidence = evidence;
  if (status === "passed") {
    // validatedAtMilestone is required on passed assertions (Factory harness
    // warning). Only set it if we know the milestone; otherwise leave a note.
    const milestone = milestoneMap[id];
    if (milestone) {
      entry.validatedAtMilestone = milestone;
    }
  }
  vs.assertions[id] = entry;
  writeFileSync(vpath, JSON.stringify(vs, null, 2) + "\n");
  return { ok: true, id, status, validatedAtMilestone: entry.validatedAtMilestone || null };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && process.argv[2]) {
  const missionPath = process.argv[2];
  const args = Object.fromEntries(
    process.argv.slice(3).filter((a) => a.startsWith("--")).map((a) => {
      const [k, ...v] = a.substring(2).split("=");
      return [k, v.join("=") || true];
    })
  );
  if (!args.id || !args.status) {
    process.stderr.write("Usage: node record-assertion.mjs <mission-path> --id=VAL-... --status=passed|failed|pending [--evidence=...]\n");
    process.exit(1);
  }
  const result = recordAssertion(missionPath, { id: args.id, status: args.status, evidence: args.evidence });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}

export { recordAssertion };
