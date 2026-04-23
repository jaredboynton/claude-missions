#!/usr/bin/env node
// v0.5.0: thin delegator to mission-cli.mjs. Kept for back-compat with
// existing invocations (block messages in autopilot-lock, suggestNextAction
// outputs, ad-hoc operator shell commands). 1.0.0 may delete this file.
//
// Arg-surface parity: every subcommand here maps 1:1 to a mission-cli.mjs
// subcommand with equivalent semantics and exit codes. Default --session-id
// comes from the three-tier resolver (see scripts/_lib/resolve-sid.sh) when
// not passed explicitly.
//
// Usage:
//   node mission-lifecycle.mjs start <mission-path>          # -> mission-cli.mjs start
//   node mission-lifecycle.mjs phase <phase-name>            # -> mission-cli.mjs phase
//   node mission-lifecycle.mjs complete [--force]            # -> mission-cli.mjs complete
//   node mission-lifecycle.mjs abort                         # -> mission-cli.mjs abort

import { spawnSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCLI = join(HERE, "mission-cli.mjs");

// Resolve session-id by sourcing resolve-sid.sh. If stdin isn't a tty the
// resolver will also consume it — our caller shouldn't be piping JSON into
// mission-lifecycle unless they want to set session-id via Tier 2.
function resolveSid() {
  try {
    const out = execFileSync("sh", ["-c", `. "${HERE}/_lib/resolve-sid.sh" && resolve_sid`], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT || join(HERE, "..") },
    });
    return (out || "").trim();
  } catch {
    return "";
  }
}

function passThrough(sub, args) {
  let sid = null;
  const forwarded = [];
  for (const a of args) {
    if (a.startsWith("--session-id=")) sid = a.slice("--session-id=".length);
    else forwarded.push(a);
  }
  if (!sid) sid = resolveSid();
  const cli = [sub, ...forwarded];
  if (sid) cli.push(`--session-id=${sid}`);
  const r = spawnSync(process.execPath, [MCLI, ...cli], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const [sub, ...rest] = process.argv.slice(2);

switch (sub) {
  case "start":
  case "phase":
  case "complete":
  case "abort":
  case "status":
  case "attach":
  case "detach":
  case "resolve":
  case "is-attached":
  case "event":
    passThrough(sub, rest);
    break;
  case "--help":
  case "-h":
  case undefined:
    process.stdout.write([
      "mission-lifecycle.mjs <subcommand> [args]  (delegator -> mission-cli.mjs)",
      "Subcommands: start, phase, complete, abort, status, attach, detach, resolve, is-attached, event",
      "All forward to scripts/mission-cli.mjs with equivalent args + auto-resolved --session-id.",
      "See scripts/mission-cli.mjs --help for the authoritative contract.",
    ].join("\n") + "\n");
    process.exit(sub ? 0 : 1);
  default:
    process.stderr.write(`mission-lifecycle.mjs: unknown subcommand '${sub}'\n`);
    process.exit(1);
}

// Exports preserved for any existing importers. In-process they now delegate
// to mission-cli.mjs via spawn since the data shapes have changed.
const REMOVED = "mission-lifecycle.mjs in-process API removed in v0.5.0; exec mission-cli.mjs instead";
export function start() { throw new Error(REMOVED); }
export function phase() { throw new Error(REMOVED); }
export function complete() { throw new Error(REMOVED); }
export function abort() { throw new Error(REMOVED); }
export { loadMissionStateFromCwd as readState } from "../hooks/_lib/mission-state.mjs";
