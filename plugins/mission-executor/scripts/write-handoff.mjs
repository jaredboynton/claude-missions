#!/usr/bin/env node
// Worker-return handoff writer (v0.5.1 — schema-validated).
//
// Replaces the v0.4.x stub with a real implementation backed by
// scripts/_lib/schemas.mjs (workerHandoffSchema). Writes a droid-compatible
// JSON file and appends a `handoff_written` event to the mission's
// progress_log.jsonl.
//
// Usage:
//   node write-handoff.mjs <mission-path> [--handoff-json=<file>] [--force-skip-validation]
//   echo '<json>' | node write-handoff.mjs <mission-path>
//
// Input JSON shape (see scripts/_lib/schemas.mjs > workerHandoffSchema):
//   {
//     "workerSessionId":  "sid-worker-1",   (required)
//     "featureId":        "VAL-X",          (required)
//     "milestone":        "M1",
//     "successState":     "success|partial|failure", (required)
//     "salientSummary":   "20-500 chars, 1-4 sentences",  (required)
//     "whatWasDone":      ["..."],
//     "whatWasLeftUndone":["..."],
//     "discoveredIssues": [{ severity, description, suggestedFix? }],
//     "commitShas":       ["abc1234"],
//     "returnToOrchestrator": "...",
//     "preferredFilePath": "/abs/path/inside/handoffs"     (optional override)
//   }
//
// Output: <missionPath>/handoffs/<ts>__<featureId>__<workerSessionId>.json
//         (or the preferredFilePath if it's inside the handoffs dir)
//
// Emits: `handoff_written` event on the mission's progress_log. The event
//        carries { featureId, workerSessionId, outPath, unverified? }.
//
// Exit codes:
//   0  success
//   1  validation failure (schema errors printed as JSON; no file written)
//   2  bad args (missing mission-path, unreadable --handoff-json, bad JSON)

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute, normalize, sep } from "node:path";
import { validate, workerHandoffSchema } from "./_lib/schemas.mjs";
import { appendEvent } from "./_lib/progress-log.mjs";

function sanitizeTimestamp(iso) { return iso.replace(/[:.]/g, "-"); }
function sanitizeFileName(s) {
  return String(s)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else out.flags[a.slice(2)] = true;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function die(msg, code = 2) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv);
  const missionPath = args.positional[0];
  if (!missionPath) die("usage: write-handoff.mjs <mission-path> [--handoff-json=<file>]");

  const forceSkip = args.flags["force-skip-validation"] === true || args.flags["force-skip-validation"] === "1";

  // Load JSON: file flag takes precedence over stdin.
  let raw;
  if (args.flags["handoff-json"]) {
    const p = String(args.flags["handoff-json"]);
    try { raw = readFileSync(p, "utf8"); }
    catch (e) { die(`--handoff-json: cannot read ${p}: ${e.message}`); }
  } else {
    raw = await readStdin();
    if (!raw || !raw.trim()) {
      die("no input: pass --handoff-json=<file> or pipe JSON via stdin");
    }
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { die(`input is not valid JSON: ${e.message}`); }

  // Validate (unless explicitly bypassed).
  let unverified = false;
  if (forceSkip) {
    unverified = true;
  } else {
    const r = validate(workerHandoffSchema, parsed);
    if (!r.ok) {
      process.stdout.write(JSON.stringify({ ok: false, errors: r.errors }, null, 2) + "\n");
      process.exit(1);
    }
  }

  // Resolve mission path; refuse to write outside it.
  const missionAbs = resolve(missionPath);
  if (!existsSync(missionAbs)) die(`mission path does not exist: ${missionAbs}`);

  const handoffsDir = join(missionAbs, "handoffs");
  mkdirSync(handoffsDir, { recursive: true });

  const timestamp = new Date().toISOString();
  const featureId = parsed.featureId || "unknown-feature";
  const workerSessionId = parsed.workerSessionId || "unknown-worker";
  const defaultName = `${sanitizeTimestamp(timestamp)}__${sanitizeFileName(featureId)}__${sanitizeFileName(workerSessionId)}.json`;

  // Honor preferredFilePath only if absolute AND resolves inside the handoffs dir.
  let outPath;
  const pref = parsed.preferredFilePath;
  if (pref && typeof pref === "string" && isAbsolute(pref) && normalize(pref).startsWith(handoffsDir + sep)) {
    outPath = pref;
  } else {
    outPath = join(handoffsDir, defaultName);
  }

  if (existsSync(outPath)) {
    die(`refusing to overwrite existing handoff: ${outPath}`);
  }

  // Body mirrors droid's ensureWorkerHandoffJson shape.
  const body = {
    timestamp,
    workerSessionId,
    featureId,
    milestone: parsed.milestone ?? null,
    successState: parsed.successState ?? null,
    salientSummary: parsed.salientSummary ?? null,
    whatWasDone: parsed.whatWasDone ?? [],
    whatWasLeftUndone: parsed.whatWasLeftUndone ?? [],
    discoveredIssues: parsed.discoveredIssues ?? [],
    commitShas: parsed.commitShas ?? [],
    returnToOrchestrator: parsed.returnToOrchestrator ?? null,
    ...(unverified ? { _unverified: true, _note: "Written with --force-skip-validation; schema not enforced." } : {}),
  };

  writeFileSync(outPath, JSON.stringify(body, null, 2) + "\n");

  // Best-effort progress-log entry. Never fail the write because the log append failed.
  try {
    appendEvent(missionAbs, {
      type: "handoff_written",
      featureId,
      workerSessionId,
      outPath,
      successState: parsed.successState ?? null,
      ...(unverified ? { unverified: true } : {}),
    });
  } catch {}

  process.stdout.write(JSON.stringify({
    ok: true,
    outPath,
    workerSessionId,
    featureId,
    ...(unverified ? { unverified: true } : {}),
  }) + "\n");
}

main().catch((e) => {
  process.stderr.write(`write-handoff.mjs: ${e.message}\n`);
  process.exit(2);
});
