// Shared hook invocation audit log.
//
// Every hook calls audit() on entry and exit so we can answer the basic
// question: "did this hook fire?" A mission's post-mortem should be able to
// grep one file and verify enforcement touched every tool call.
//
// The log is append-only and capped at ~1 MB (rotated to .1 on overflow).
// Failure modes never propagate to the caller — audit failures must not
// deny an otherwise-allowed tool call.
//
// Contract:
//   import { audit } from "./_lib/audit.mjs";
//   audit("hook-name", { tool_name, phase, decision, note });
//
// Log format: one JSON line per event with ts, hook, and arbitrary payload.

import { appendFileSync, statSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { auditLogFile } from "./paths.mjs";

const MAX_BYTES = 1_048_576; // 1 MiB

function resolveLogPath() {
  try { return auditLogFile(); }
  catch { return null; }  // projectRoot unresolvable; skip logging
}

function rotateIfLarge(path) {
  try {
    const s = statSync(path);
    if (s.size > MAX_BYTES) renameSync(path, path + ".1");
  } catch {}
}

export function audit(hookName, payload = {}) {
  try {
    const path = resolveLogPath();
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    rotateIfLarge(path);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      hook: hookName,
      pid: process.pid,
      ...payload,
    });
    appendFileSync(path, line + "\n", { encoding: "utf8" });
  } catch {}
}
