#!/usr/bin/env node
// write-handoff.mjs — STUB. Contract not yet implemented.
//
// The intended behavior: after a worker Agent() call returns, the orchestrator
// extracts { whatWasDone, whatWasLeftUndone, discoveredIssues, commitShas,
// successState, ... } from the worker's return and writes a droid-format
// handoff JSON to <mission-path>/handoffs/<ts>__<feature-id>__<worker-id>.json.
// This matches what the droid runtime produces when IT drives the worker loop,
// so a droid orchestrator's post-mission review finds evidence in the same
// place regardless of whether Claude Code or droid was the runtime.
//
// The blocker: Agent() returns unstructured free text. An orchestrator
// heuristic-parsing worker self-reports is exactly the failure mode that let
// the last mission mark features complete with no evidence trail. The proper
// fix is upstream: define a worker-return contract where the worker writes
// .omc/handoffs-inbox/<worker-id>.json BEFORE shutting down, and the
// orchestrator reads that rather than parsing stdout.
//
// Until that contract lands, this script is a stub that exits 2 with a
// loud message. The orchestrator calling it will see the failure and must
// either (a) implement the contract or (b) document that Claude Code runtime
// cannot produce droid-compatible handoffs and operators should use the
// droid CLI runtime if handoff files are required.
//
// To unstub:
//   1. Land a worker-return contract spec (see docs/worker-return-contract.md
//      -- not yet written).
//   2. Update workers to write <handoffsInboxDir()>/<worker-id>.json on shutdown
//      (path resolved via hooks/_lib/paths.mjs — legacy autodetect keeps the
//      `.omc/handoffs-inbox/` path intact for existing OMC installs).
//   3. Replace this stub with real read-inbox + write-handoff logic.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const USAGE = [
  "STUB: write-handoff.mjs is not yet implemented (plugin v0.4.4).",
  "",
  "Intended usage:",
  "  node write-handoff.mjs <mission-path> --feature=<id> --worker=<session-id> \\",
  "    --successState=<success|partial|failure> --whatWasDone=<json> \\",
  "    --commitShas=<json>",
  "",
  "Why stub: Agent() returns unstructured text. Heuristic-parsing worker",
  "self-reports is the failure mode that let prior missions mark features",
  "complete without evidence. A worker-return contract is required before this",
  "script can be trusted. See AGENTS.md for current status.",
  "",
  "Workarounds:",
  "  - For now, the orchestrator writes handoff files via an ad-hoc Bash",
  "    heredoc. Those handoffs are advisory, not proof.",
  "  - Phase 4 VERIFY (execute-assertion.mjs) is the authoritative path --",
  "    handoffs are audit evidence, not gate.",
].join("\n");

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

function main() {
  const args = parseArgs(process.argv);
  const force = args.flags.force === true || args.flags.force === "1";

  // Only proceed in --force mode, which writes a minimal advisory record
  // that's explicitly marked as unverified. This lets the orchestrator still
  // produce some handoff audit trail while the real contract is pending.
  if (!force) {
    process.stderr.write(USAGE + "\n");
    process.exit(2);
  }

  const missionPath = args.positional[0];
  if (!missionPath) {
    process.stderr.write("missing <mission-path>\n");
    process.exit(2);
  }

  const featureId = args.flags.feature;
  const workerId = args.flags.worker;
  const successState = args.flags.successState || "partial";

  if (!featureId || !workerId) {
    process.stderr.write("--feature=<id> and --worker=<session-id> required under --force\n");
    process.exit(2);
  }

  const handoffDir = join(resolve(missionPath), "handoffs");
  mkdirSync(handoffDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(handoffDir, `${ts}__${featureId}__${workerId}.json`);

  const body = {
    _unverified: true,
    _note: "Written under --force. No worker-return contract yet; this is advisory.",
    timestamp: new Date().toISOString(),
    featureId,
    workerSessionId: workerId,
    successState,
    whatWasDone: args.flags.whatWasDone ? tryJSON(args.flags.whatWasDone) : null,
    whatWasLeftUndone: args.flags.whatWasLeftUndone ? tryJSON(args.flags.whatWasLeftUndone) : null,
    discoveredIssues: args.flags.discoveredIssues ? tryJSON(args.flags.discoveredIssues) : null,
    commitShas: args.flags.commitShas ? tryJSON(args.flags.commitShas) : null,
  };

  if (existsSync(outPath)) {
    process.stderr.write(`refusing to overwrite existing handoff: ${outPath}\n`);
    process.exit(2);
  }

  writeFileSync(outPath, JSON.stringify(body, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ok: true, outPath, unverified: true }) + "\n");
}

function tryJSON(s) {
  try { return JSON.parse(s); } catch { return s; }
}

main();
