#!/usr/bin/env node
// SessionStart hook: write <sessionIdDir>/<session_id>.active so slash-command
// `!bash` blocks can resolve their own session-id via Tier 3 of resolve-sid.sh.
//
// Contract:
//   - One file per session (named with the session-id itself). No shared
//     current-session pointer.
//   - mtime updated on SessionStart; commands read the newest file.
//   - Opportunistic GC: any *.active file with mtime > 24h is deleted.
//   - If projectRoot() unresolvable (e.g. CLAUDE_PROJECT_DIR unset and cwd=/),
//     log to stderr and exit 0 — hooks must never fail the pipeline.

import { readdirSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
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

    audit("session-start-record", { session_id: sid, action: "recorded" });
  } catch (e) {
    process.stderr.write(`session-start-record: ${e.message}\n`);
  }

  process.stdout.write("{}");
}

main().catch((e) => {
  process.stderr.write(`session-start-record error: ${e.message}\n`);
  process.stdout.write("{}");
});
