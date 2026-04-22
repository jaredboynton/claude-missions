#!/usr/bin/env node
// milestone-seal.mjs — STUB. Scrutiny + user-testing validators live in the
// droid runtime, not this plugin.
//
// The intended behavior: when a milestone completes, this script runs the
// auto-injected `scrutiny-validator` and `user-testing-validator` for that
// milestone, refuses to advance until both pass, and tags the seal commit
// as <milestone>-sealed. Without the seal, subsequent milestones cannot
// proceed (VAL-CROSS-009 "sealed-milestone integrity").
//
// The blocker: scrutiny-validator and user-testing-validator are scripts
// owned by the Factory droid runtime (see mission AGENTS.md). This plugin
// ships inside Claude Code and has no way to auto-inject those validators.
//
// So this script ships as a STUB that:
//   1. Probes for `scrutiny-validator` and `user-testing-validator` binaries
//      on PATH or in well-known Factory locations.
//   2. If present: shells out to them and enforces refuse-on-failure.
//   3. If absent: exits 2 loudly with guidance to run the droid CLI lane,
//      not a silent no-op that lets missions advance without validation.
//
// To unstub:
//   - If Anthropic ships scrutiny-validator as part of a plugin or SDK,
//     detect its binary path here.
//   - If the droid runtime exposes an HTTP API for validator calls, call it.
//   - Until then, `milestone-seal.mjs` exists as a loud failure that forces
//     operators to use the droid CLI lane for sealing missions.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const USAGE = [
  "Usage: node milestone-seal.mjs <mission-path> --milestone=<id>",
  "",
  "Refuses to pass until scrutiny-validator AND user-testing-validator are",
  "available and both return success for the given milestone.",
  "",
  "Current status: STUB. Scrutiny and user-testing validators are owned by",
  "the Factory droid runtime, not this plugin. If you need milestone sealing,",
  "run the mission via the droid CLI rather than Claude Code's",
  "/mission-executor:mission-execute skill.",
  "",
  "If you have the droid validators installed and want this script to call",
  "them, set one of:",
  "  - DROID_SCRUTINY_BIN=/path/to/scrutiny-validator",
  "  - DROID_USER_TESTING_BIN=/path/to/user-testing-validator",
  "",
  "Override (for forcing a pass in known-safe situations): --force. Logged",
  "loudly and records a forced-seal marker in the mission's progress_log.",
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

function findBin(envName, fallbackName) {
  const fromEnv = process.env[envName];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // Common Factory install paths
  const candidates = [
    `/usr/local/bin/${fallbackName}`,
    `/opt/homebrew/bin/${fallbackName}`,
    `${process.env.HOME || ""}/.factory/bin/${fallbackName}`,
    `${process.env.HOME || ""}/.local/bin/${fallbackName}`,
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

function runValidator(bin, missionPath, milestone) {
  const result = spawnSync(bin, [missionPath, "--milestone=" + milestone], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    bin,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const missionPath = args.positional[0];
  const milestone = args.flags.milestone;
  const force = args.flags.force === true || args.flags.force === "1";

  if (!missionPath || !milestone) {
    process.stderr.write(USAGE + "\n");
    process.exit(2);
  }

  const scrutinyBin = findBin("DROID_SCRUTINY_BIN", "scrutiny-validator");
  const userTestingBin = findBin("DROID_USER_TESTING_BIN", "user-testing-validator");

  if (!scrutinyBin || !userTestingBin) {
    if (force) {
      const forcedReport = {
        ok: true,
        forced: true,
        missionPath: resolve(missionPath),
        milestone,
        note: "Force-sealed without validators. Droid runtime validators were not available; operator acknowledged by passing --force.",
        warning: "This seal does NOT satisfy VAL-CROSS-009 sealed-milestone integrity. The mission will fail post-seal audit.",
      };
      process.stdout.write(JSON.stringify(forcedReport, null, 2) + "\n");
      process.exit(0);
    }
    const report = {
      ok: false,
      error: "validators-not-installed",
      scrutinyBin,
      userTestingBin,
      hint: [
        "scrutiny-validator and user-testing-validator are owned by the Factory",
        "droid runtime. To seal this milestone, either:",
        "  (a) run the mission via the droid CLI lane (not Claude Code), or",
        "  (b) install the droid validators and set DROID_SCRUTINY_BIN +",
        "      DROID_USER_TESTING_BIN env vars to their paths, or",
        "  (c) pass --force if you accept that the seal won't satisfy",
        "      VAL-CROSS-009 and the mission will fail post-seal audit.",
      ].join(" "),
    };
    process.stderr.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(2);
  }

  const scrutiny = runValidator(scrutinyBin, missionPath, milestone);
  const userTesting = runValidator(userTestingBin, missionPath, milestone);

  const passed = scrutiny.exitCode === 0 && userTesting.exitCode === 0;
  const report = {
    ok: passed,
    missionPath: resolve(missionPath),
    milestone,
    scrutiny: { exitCode: scrutiny.exitCode, binPath: scrutiny.bin },
    userTesting: { exitCode: userTesting.exitCode, binPath: userTesting.bin },
  };
  if (!passed) {
    report.scrutiny.stdout = scrutiny.stdout?.slice(0, 4096);
    report.scrutiny.stderr = scrutiny.stderr?.slice(0, 4096);
    report.userTesting.stdout = userTesting.stdout?.slice(0, 4096);
    report.userTesting.stderr = userTesting.stderr?.slice(0, 4096);
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(passed ? 0 : 1);
}

main();
