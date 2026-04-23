#!/usr/bin/env node
// PreToolUse hook for Bash: detect git add/commit commands and inject a
// scope-warning reminder. Does NOT block.
//
// v0.5.0: gated on session_id membership in state.attachedSessions[].
// v0.8.1: emit canonical PreToolUse JSON (no legacy `decision`/`message`).

import { loadAttachedMissionState, migrateLegacyAttach } from "./_lib/mission-state.mjs";
import { audit } from "./_lib/audit.mjs";
import { preAllow } from "./_lib/hook-output.mjs";

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try { parsed = JSON.parse(input); } catch {
    process.stdout.write(JSON.stringify(preAllow()));
    return;
  }

  const { tool_name, tool_input } = parsed;
  const sessionId = parsed.session_id;
  const cwd = parsed.cwd || process.env.CLAUDE_WORKING_DIR || process.cwd();
  const { state, reason } = loadAttachedMissionState({ sessionId, cwd });

  if (!state || !state.active || tool_name !== "Bash") {
    process.stdout.write(JSON.stringify(preAllow()));
    return;
  }

  if (reason === "legacy-auto-attach-pending") {
    try { await migrateLegacyAttach({ sessionId, cwd }); } catch {}
  }

  const cmd = tool_input?.command || "";
  const isGitStaging = /\bgit\s+(add|commit|stage)\b/.test(cmd);

  if (isGitStaging && state.protectedPaths?.length > 0) {
    const protectedList = state.protectedPaths.join(", ");
    const context = `[Mission Commit Guard] Protected uncommitted paths: ${protectedList}. Verify git status --porcelain before and after staging. Only stage files YOU created or edited. If any protected path flipped from ' M' to 'M ', run git restore --staged <path> immediately.`;
    audit("commit-scope-guard", { decision: "remind", session_id: sessionId });
    process.stdout.write(JSON.stringify(preAllow({ context })));
  } else {
    process.stdout.write(JSON.stringify(preAllow()));
  }
}

main().catch((e) => {
  process.stderr.write(`commit-scope-guard error: ${e.message}\n`);
  process.stdout.write(JSON.stringify(preAllow()));
});
