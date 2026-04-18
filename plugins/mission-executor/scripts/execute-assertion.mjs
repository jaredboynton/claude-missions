#!/usr/bin/env node
// Execute a single validation assertion and record its result as a proof.
//
// This is the sealed-circuit bridge between run-assertion.mjs (generates
// commands) and record-assertion.mjs (writes status). It is the ONLY path
// that produces a `passed` status in validation-state.json.
//
// Usage:
//   node execute-assertion.mjs <mission-path> --id=VAL-XXX-NNN [flags]
//
// Flags:
//   --working-dir=<path>   Override working_directory.txt
//   --cli-bin=<path>       Override MISSION_CLI_BIN
//   --tui-bin=<path>       Override MISSION_TUI_BIN
//   --http-url=<url>       Override MISSION_HTTP_URL (default http://127.0.0.1:4096)
//   --skip-infra           Exit 2 (blocked) instead of 3 (infra) if deps missing
//   --json                 Output verdict as JSON only (suppresses human prose)
//
// Exit codes:
//   0 = passed, proof recorded
//   1 = failed, record-assertion called with --status=failed
//   2 = blocked (stale, prerequisite missing)
//   3 = infrastructure problem (daemon down, binary missing, rg missing)
//
// Proof outputs:
//   .omc/validation/proofs/<id>/stdout.txt
//   .omc/validation/proofs/<id>/stderr.txt
//   .omc/validation/proofs/<id>/meta.json  (tool-type, command, expected, observed)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync, spawnSync } from "node:child_process";

import { recordAssertion } from "./record-assertion.mjs";

const DEFAULT_HTTP = "http://127.0.0.1:4096";

function headSha(workingDir) {
  try {
    return execSync("git rev-parse HEAD", { cwd: workingDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function loadMission(missionPath) {
  const dir = resolve(missionPath);
  const featuresPath = join(dir, "features.json");
  const contractPath = join(dir, "validation-contract.md");
  const wdPath = join(dir, "working_directory.txt");
  if (!existsSync(featuresPath)) throw new Error(`features.json missing at ${featuresPath}`);
  if (!existsSync(contractPath)) throw new Error(`validation-contract.md missing at ${contractPath}`);

  const features = JSON.parse(readFileSync(featuresPath, "utf8")).features || [];
  const contract = readFileSync(contractPath, "utf8");
  const workingDir = existsSync(wdPath) ? readFileSync(wdPath, "utf8").trim() : process.cwd();

  return { dir, features, contract, workingDir };
}

// Parse the contract markdown to extract assertion blocks keyed by id.
// Each block looks like:
//   ### VAL-XYZ-001: Title
//   Free-form description paragraph...
//   Tool: curl
//   Evidence: ...
function parseAssertion(contract, id) {
  const idPattern = new RegExp(`###\\s+${id.replace(/[-.]/g, "\\$&")}[:.\\s]`, "m");
  const match = contract.match(idPattern);
  if (!match) return null;
  const start = match.index;
  // Stop at next ### heading or EOF.
  const rest = contract.slice(start + match[0].length);
  const next = rest.search(/^###\s+/m);
  const block = next === -1 ? rest : rest.slice(0, next);
  const fullBlock = contract.slice(start, start + match[0].length + block.length);

  const title = (fullBlock.match(/^###\s+[^:\n]+:\s*(.+)$/m) || [, ""])[1].trim();
  const toolLine = fullBlock.match(/^Tool:\s*(.+)$/m);
  const evidenceLine = fullBlock.match(/^Evidence:\s*(.+)$/m);
  return {
    id,
    title,
    tool: toolLine ? toolLine[1].trim() : null,
    evidence: evidenceLine ? evidenceLine[1].trim() : null,
    body: fullBlock,
  };
}

// Extract touchpoints for an assertion by mapping via feature.fulfills
// back to the feature's declared source file mentions in description.
function touchpointsForAssertion(features, id) {
  const tp = new Set();
  for (const f of features) {
    if (!Array.isArray(f.fulfills) || !f.fulfills.includes(id)) continue;
    const desc = f.description || "";
    const re = /`([^`]+\.(ts|tsx|js|jsx|py|go|rs|sql))`/g;
    for (const m of desc.matchAll(re)) tp.add(m[1]);
  }
  return [...tp];
}

// ---- Tool dispatch ---------------------------------------------------------

function hasCmd(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function runCapture(command, cwd) {
  const res = spawnSync("bash", ["-lc", command], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    exitCode: res.status ?? (res.signal ? 128 : 1),
    signal: res.signal,
  };
}

// unit-test: match evidence for a path + optional test name; default to bun test
function dispatchUnitTest(ctx) {
  const { evidence, workingDir } = ctx;
  const pathMatch = evidence?.match(/`([^`]*test[^`]+\.(ts|tsx|js|jsx))`/);
  const nameMatch = evidence?.match(/test name\s+[`"']([^`"']+)[`"']/i);
  if (!hasCmd("bun")) return { status: "infra", message: "bun not on PATH" };
  const file = pathMatch ? pathMatch[1] : null;
  const cmd = file
    ? (nameMatch ? `bun test --timeout 60000 "${file}" -t "${nameMatch[1]}"` : `bun test --timeout 60000 "${file}"`)
    : null;
  if (!cmd) return { status: "blocked", message: "no test file referenced in evidence" };
  const r = runCapture(cmd, workingDir);
  const passed = r.exitCode === 0 && /\b0\s+fail/.test(r.stdout + r.stderr);
  return {
    status: passed ? "passed" : "failed",
    toolType: "unit-test",
    command: cmd,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    expected: file ? `0 failures in ${file}` : "green unit test",
  };
}

// curl: extract URL + status expectation + field expectations from evidence
function dispatchCurl(ctx) {
  const { evidence, workingDir, httpUrl } = ctx;
  const urlMatch = evidence?.match(/`(?:curl\s+[^`]*?)?(https?:\/\/[^\s`)]+)`?/) || evidence?.match(/(https?:\/\/[^\s)]+)/);
  let url = urlMatch ? urlMatch[1] : null;
  // Support relative path in evidence like `/mission/:id`
  if (!url) {
    const pathOnly = evidence?.match(/`(\/mission\/[^`\s]*)`/);
    if (pathOnly) url = `${httpUrl}${pathOnly[1]}`;
  }
  if (!url) return { status: "blocked", message: "no URL in evidence" };
  if (!hasCmd("curl")) return { status: "infra", message: "curl not on PATH" };

  const cmd = `curl -sS -m 10 -w "\\nHTTP_STATUS:%{http_code}" "${url}"`;
  const r = runCapture(cmd, workingDir);
  const statusExpected = (evidence.match(/\b(20[0-9]|3\d{2}|4\d{2}|5\d{2})\b/) || [null])[0];
  const statusObserved = (r.stdout.match(/HTTP_STATUS:(\d{3})/) || [null, null])[1];
  const fieldExpects = [];
  // Phrases like `code` field matching ^MISSION_... or includes "openable": false
  for (const m of (evidence.matchAll(/`([a-zA-Z_][\w]*)`\s+field/g) || [])) {
    fieldExpects.push(m[1]);
  }
  const bodyText = r.stdout.replace(/\nHTTP_STATUS:\d{3}$/, "");
  const statusOk = statusExpected ? statusObserved === statusExpected : (r.exitCode === 0 && statusObserved && /^2/.test(statusObserved));
  const fieldsOk = fieldExpects.every((f) => new RegExp(`"${f}"\\s*:`).test(bodyText));

  const passed = statusOk && fieldsOk && r.exitCode === 0;
  return {
    status: passed ? "passed" : "failed",
    toolType: "curl",
    command: cmd,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    expected: `status=${statusExpected || "2xx"} fields=${fieldExpects.join(",") || "(none)"}`,
  };
}

// cli-binary: resolve binary, run extracted command (preserving --help etc.)
function dispatchCliBinary(ctx) {
  const { evidence, workingDir, cliBin } = ctx;
  if (!cliBin) return { status: "infra", message: "MISSION_CLI_BIN or --cli-bin not set" };
  if (!existsSync(cliBin)) return { status: "infra", message: `cli bin not found: ${cliBin}` };
  const cmdMatch = evidence?.match(/`([^`]+)`/);
  if (!cmdMatch) return { status: "blocked", message: "no backtick-wrapped command in evidence" };
  let cmd = cmdMatch[1];
  // Replace leading "kep" token with actual binary
  cmd = cmd.replace(/^(\S+)/, cliBin);
  const full = `${cmd} 2>&1; echo "EXIT:$?"`;
  const r = runCapture(full, workingDir);
  const exitMatch = r.stdout.match(/EXIT:(-?\d+)\s*$/);
  const observedExit = exitMatch ? Number(exitMatch[1]) : r.exitCode;
  // Expected exit: --help assertions must exit 0
  const expectedExit = /--help\b/.test(cmd) ? 0 : null;
  const literalMatch = evidence?.match(/literal(?:ly)?\s+[`"']([^`"']+)[`"']/i);
  const literalPresent = literalMatch ? (r.stdout.includes(literalMatch[1])) : true;
  const passed = (expectedExit === null || observedExit === expectedExit) && literalPresent;
  return {
    status: passed ? "passed" : "failed",
    toolType: "cli-binary",
    command: full,
    exitCode: observedExit,
    stdout: r.stdout,
    stderr: r.stderr,
    expected: `exit=${expectedExit ?? "*"} literal=${literalMatch ? literalMatch[1] : "(none)"}`,
  };
}

// tuistory: launch, snapshot, grep. Requires MISSION_TUI_BIN.
function dispatchTuistory(ctx) {
  const { id, evidence, workingDir, tuiBin } = ctx;
  if (!tuiBin) return { status: "infra", message: "MISSION_TUI_BIN or --tui-bin not set" };
  if (!hasCmd("tuistory")) return { status: "infra", message: "tuistory not on PATH" };
  const session = `val-${id.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  const literal = (evidence?.match(/literal(?:ly)?\s+[`"']([^`"']+)[`"']/i) || evidence?.match(/contains?\s+[`"']([^`"']+)[`"']/i))?.[1] || null;
  const launch = `tuistory launch "${tuiBin} ${workingDir}" -s ${session} --cols 120 --rows 36 >/dev/null 2>&1 || true; sleep 6; tuistory -s ${session} snapshot --trim; tuistory -s ${session} close >/dev/null 2>&1 || true`;
  const r = runCapture(launch, workingDir);
  const present = literal ? r.stdout.includes(literal) : true;
  const passed = r.exitCode === 0 && present;
  return {
    status: passed ? "passed" : "failed",
    toolType: "tuistory",
    command: launch,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    expected: literal ? `snapshot contains '${literal}'` : "snapshot captured",
  };
}

// literal-probe: rg --fixed-strings against declared paths
function dispatchLiteralProbe(ctx) {
  const { evidence, workingDir } = ctx;
  if (!hasCmd("rg") && !hasCmd("grep")) return { status: "infra", message: "neither rg nor grep on PATH" };
  const literal = (evidence?.match(/literal(?:ly)?\s+[`"']([^`"']+)[`"']/i) || evidence?.match(/contains?\s+[`"']([^`"']+)[`"']/i))?.[1];
  if (!literal) return { status: "blocked", message: "no literal in evidence" };
  const pathHint = (evidence?.match(/`([^`]+\.(?:ts|tsx|js|jsx|py|go|rs|sql|md))`/) || [null, "."])[1];
  const tool = hasCmd("rg") ? "rg --fixed-strings" : "grep -RF";
  const cmd = `${tool} -- "${literal.replace(/"/g, '\\"')}" ${pathHint}`;
  const r = runCapture(cmd, workingDir);
  const passed = r.exitCode === 0 && r.stdout.trim().length > 0;
  return {
    status: passed ? "passed" : "failed",
    toolType: "literal-probe",
    command: cmd,
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    expected: `literal '${literal}' present in ${pathHint}`,
  };
}

// ---- Main ------------------------------------------------------------------

function writeProofBundle(missionDir, id, result) {
  const base = join(missionDir, ".omc", "validation", "proofs", id);
  mkdirSync(base, { recursive: true });
  const stdoutPath = join(base, "stdout.txt");
  const stderrPath = join(base, "stderr.txt");
  writeFileSync(stdoutPath, result.stdout ?? "");
  writeFileSync(stderrPath, result.stderr ?? "");
  const meta = {
    id,
    toolType: result.toolType,
    command: result.command,
    exitCode: result.exitCode,
    expected: result.expected,
    executedAt: new Date().toISOString(),
  };
  writeFileSync(join(base, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return {
    stdoutPath: join(".omc", "validation", "proofs", id, "stdout.txt"),
    stderrPath: join(".omc", "validation", "proofs", id, "stderr.txt"),
  };
}

function executeAssertion(missionPath, opts = {}) {
  const { dir, features, contract, workingDir } = loadMission(missionPath);
  const id = opts.id;
  if (!id) return { ok: false, error: "--id=VAL-... required" };

  const assertion = parseAssertion(contract, id);
  if (!assertion) return { ok: false, error: `assertion ${id} not found in validation-contract.md` };

  const tool = assertion.tool;
  const ctx = {
    id,
    evidence: assertion.evidence,
    workingDir: opts.workingDir || workingDir,
    cliBin: opts.cliBin || process.env.MISSION_CLI_BIN || null,
    tuiBin: opts.tuiBin || process.env.MISSION_TUI_BIN || null,
    httpUrl: opts.httpUrl || process.env.MISSION_HTTP_URL || DEFAULT_HTTP,
  };

  let result;
  switch (tool) {
    case "unit-test": result = dispatchUnitTest(ctx); break;
    case "curl": result = dispatchCurl(ctx); break;
    case "cli-binary": result = dispatchCliBinary(ctx); break;
    case "tuistory": result = dispatchTuistory(ctx); break;
    case "literal-probe": result = dispatchLiteralProbe(ctx); break;
    default: result = { status: "blocked", message: `unknown tool '${tool}'` };
  }

  // Infra / blocked: do not mark passed, do not even write a proof bundle.
  if (result.status === "infra") {
    return { ok: false, id, status: "infra", message: result.message, exitCode: 3 };
  }
  if (result.status === "blocked") {
    return { ok: false, id, status: "blocked", message: result.message, exitCode: 2 };
  }

  const commitSha = headSha(ctx.workingDir) || "unknown";
  const touchpoints = touchpointsForAssertion(features, id);
  const { stdoutPath, stderrPath } = writeProofBundle(dir, id, result);

  // Authorize the proof write via env var that assertion-proof-guard hook checks.
  process.env.MISSION_EXECUTOR_WRITER = "1";

  const record = recordAssertion(dir, {
    id,
    status: result.status, // "passed" or "failed"
    evidence: result.expected,
    "commit-sha": commitSha,
    "tool-type": result.toolType,
    command: result.command,
    "exit-code": String(result.exitCode),
    "stdout-path": stdoutPath,
    "stderr-path": stderrPath,
    touchpoints: touchpoints.join(","),
    "working-dir": ctx.workingDir,
  });

  // record-assertion rejects passed-without-proof; ensure we only proceed when
  // the write actually happened.
  if (!record.ok && result.status === "passed") {
    return { ok: false, id, status: "failed", error: `proof rejected by record-assertion: ${record.error}`, exitCode: 1 };
  }

  return {
    ok: true,
    id,
    status: result.status,
    toolType: result.toolType,
    commitSha,
    exitCode: result.status === "passed" ? 0 : 1,
    expected: result.expected,
    observed: {
      exitCode: result.exitCode,
      stdoutPath,
      stderrPath,
    },
  };
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
  let result;
  try {
    result = executeAssertion(missionPath, {
      id: args.id,
      workingDir: args["working-dir"],
      cliBin: args["cli-bin"],
      tuiBin: args["tui-bin"],
      httpUrl: args["http-url"],
    });
  } catch (e) {
    process.stderr.write(`execute-assertion error: ${e.message}\n`);
    process.exit(3);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.exitCode ?? (result.ok ? 0 : 1));
}

export { executeAssertion };
