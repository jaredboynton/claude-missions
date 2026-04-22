#!/usr/bin/env node
// PostToolUse hook for Edit/Write: remind the agent to run the project's
// build command before committing.
//
// v0.5.0: gated on session_id membership in state.attachedSessions[].

import { loadAttachedMissionState, migrateLegacyAttach } from "./_lib/mission-state.mjs";
import { audit } from "./_lib/audit.mjs";

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try { parsed = JSON.parse(input); } catch {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const tool_name = parsed.tool_name;
  const tool_input = parsed.tool_input || {};
  const sessionId = parsed.session_id;
  const cwd = parsed.cwd || process.env.CLAUDE_WORKING_DIR || process.cwd();
  const { state, reason } = loadAttachedMissionState({ sessionId, cwd });

  if (!state || !state.active) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  if (reason === "legacy-auto-attach-pending") {
    try { await migrateLegacyAttach({ sessionId, cwd }); } catch {}
  }

  if (tool_name !== "Edit" && tool_name !== "Write") {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const filePath = tool_input?.file_path || "";
  const srcPatterns = state.srcPatterns || ["src/"];
  const isSrcFile = srcPatterns.some((p) => filePath.includes(p));

  if (isSrcFile && state.buildCommand) {
    audit("build-discipline", { decision: "remind", tool: tool_name, session_id: sessionId });
    process.stdout.write(JSON.stringify({
      message: `[Build Discipline] Source file modified: ${filePath}. Run \`${state.buildCommand}\` before committing.`,
    }));
  } else {
    process.stdout.write(JSON.stringify({}));
  }
}

main().catch((e) => {
  process.stderr.write(`build-discipline error: ${e.message}\n`);
  process.stdout.write(JSON.stringify({}));
});
