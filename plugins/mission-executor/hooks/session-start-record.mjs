#!/usr/bin/env node
// SessionStart hook: write <sessionIdDir>/<session_id>.active so slash-command
// `!bash` blocks can resolve their own session-id via Tier 3 of resolve-sid.sh.
// Also persist CLAUDE_CODE_SESSION_ID to $CLAUDE_ENV_FILE so Bash tool calls
// can read it directly (anthropics/claude-code#25642 workaround — native
// env-var exposure is still a pending feature request).
//
// Contract:
//   - One file per session (named with the session-id itself). No shared
//     current-session pointer.
//   - mtime updated on SessionStart; commands read the newest file.
//   - Opportunistic GC: any *.active file with mtime > 24h is deleted.
//   - Env-file export is guarded by a grep so resume/continue doesn't stack
//     duplicate exports.
//   - If projectRoot() unresolvable (e.g. CLAUDE_PROJECT_DIR unset and cwd=/),
//     log to stderr and exit 0 — hooks must never fail the pipeline.

import { readdirSync, statSync, unlinkSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { sessionIdDir, sessionIdFile } from "./_lib/paths.mjs";
import { audit } from "./_lib/audit.mjs";

const STALE_MS = 24 * 60 * 60 * 1000;

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let parsed;
  try { parsed = JSON.parse(input); } catch {
    process.stdout.write("{}");
    return;
  }

  const sid = parsed.session_id;
  if (!sid || typeof sid !== "string") {
    process.stdout.write("{}");
    return;
  }

  let dir, file;
  try {
    dir = sessionIdDir();
    file = sessionIdFile(sid);
  } catch (e) {
    process.stderr.write(`session-start-record: project root unresolvable (${e.message}); skipping\n`);
    process.stdout.write("{}");
    return;
  }

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, new Date().toISOString());

    // Opportunistic GC
    try {
      const now = Date.now();
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".active")) continue;
        const p = `${dir}/${entry}`;
        try {
          const st = statSync(p);
          if (now - st.mtimeMs > STALE_MS) unlinkSync(p);
        } catch {}
      }
    } catch {}

    // Export CLAUDE_CODE_SESSION_ID to the session's env file so Bash tool
    // calls (which source $CLAUDE_ENV_FILE on each invocation) can pick it
    // up without reading a state file. anthropics/claude-code#25642. Guard
    // with grep so resume/continue sessions don't stack duplicate exports.
    // Slash-command `!cmd` template-expansion does NOT source the env file
    // (anthropics/claude-code#49780) — that path still relies on the
    // .active file written above.
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile) {
      try {
        const prior = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
        if (!/CLAUDE_CODE_SESSION_ID=/.test(prior)) {
          appendFileSync(envFile, `export CLAUDE_CODE_SESSION_ID="${sid}"\n`);
        }
      } catch {}
    }

    audit("session-start-record", { session_id: sid, action: "recorded" }, { skipIfNoMission: true });
  } catch (e) {
    process.stderr.write(`session-start-record: ${e.message}\n`);
  }

  process.stdout.write("{}");
}

main().catch((e) => {
  process.stderr.write(`session-start-record error: ${e.message}\n`);
  process.stdout.write("{}");
});
