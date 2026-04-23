#!/usr/bin/env node
// PreToolUse hook: gate Write/Edit to features.json.
//
// Mirrors assertion-proof-guard.mjs for the features.json file. features.json
// is the authoritative per-feature status tracker and may only be modified
// by plugin scripts (sync-features-state.mjs, reconcile-external-work.mjs)
// that run under MISSION_EXECUTOR_WRITER=1 via Bash.
//
// Why Write/Edit only (no Bash matcher): bash-level writes via python/jq/sed
// heredoc are trivially obfuscated and a regex-matching Bash hook would be
// trivially bypassed. Instead, Bash-level features.json writes are caught
// after-the-fact by commit-scope-guard inspecting git diffs before commit.
//
// SCHEMA: emits both legacy {decision,message} and modern hookSpecificOutput.

import { audit } from "./_lib/audit.mjs";

const BLOCKED_FILENAME = "features.json";

function denyPayload(reason) {
  return {
    decision: "block",
    message: reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function allowPayload() {
  return {
    decision: "allow",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    audit("features-json-guard", { decision: "allow", reason: "unparseable-input" }, { skipIfNoMission: true });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  const tool_name = parsed.tool_name;
  const tool_input = parsed.tool_input || {};

  if (tool_name !== "Write" && tool_name !== "Edit") {
    audit("features-json-guard", { decision: "allow", tool: tool_name, reason: "wrong-tool" }, { skipIfNoMission: true });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  const filePath = tool_input.file_path || tool_input.path || "";

  // We only care about files literally named features.json. Guard against
  // unrelated files that happen to contain "features.json" in their path by
  // requiring the exact basename match.
  if (!/(^|\/)features\.json$/.test(filePath)) {
    audit("features-json-guard", { decision: "allow", tool: tool_name, reason: "wrong-file" }, { skipIfNoMission: true });
    process.stdout.write(JSON.stringify(allowPayload()));
    return;
  }

  const reason = [
    `Blocked direct Write/Edit to ${BLOCKED_FILENAME}.`,
    "",
    "This file is the authoritative per-feature status tracker and may only be",
    "modified by plugin scripts running under MISSION_EXECUTOR_WRITER=1:",
    "",
    "  - sync-features-state.mjs:     syncs status from git HEAD commits",
    "  - reconcile-external-work.mjs: promotes already-landed work after probes",
    "",
    "Examples of the right path:",
    "  node ${CLAUDE_PLUGIN_ROOT}/scripts/sync-features-state.mjs <mission>",
    "  node ${CLAUDE_PLUGIN_ROOT}/scripts/reconcile-external-work.mjs <mission> --apply",
    "",
    "Hand-editing features.json -- via python3 -c, jq -i, sed -i, or Write/Edit --",
    "bypasses the evidence chain: Phase 4 VERIFY is the ONLY authoritative path to",
    "feature completion. Status flipped without proof gets caught at Phase 7's",
    "validate-mission.mjs gate and rolled back.",
  ].join("\n");

  audit("features-json-guard", {
    decision: "deny",
    tool: tool_name,
    filePath,
    reason: "direct-write-to-features",
  });

  process.stdout.write(JSON.stringify(denyPayload(reason)));
}

main().catch((e) => {
  process.stderr.write(`features-json-guard error: ${e.message}\n`);
  audit("features-json-guard", { decision: "allow", reason: `error:${e.message}` }, { skipIfNoMission: true });
  process.stdout.write(JSON.stringify(allowPayload()));
});
