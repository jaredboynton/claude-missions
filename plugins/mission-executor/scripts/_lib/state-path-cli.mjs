#!/usr/bin/env node
// Tiny helper: print a resolved path from paths.mjs for use by bash `!` blocks
// in commands/*.md. Avoids building paths by hand in shell.
//
// Usage:
//   node state-path-cli.mjs session-id-dir
//   node state-path-cli.mjs state-file
//   node state-path-cli.mjs audit-log
//   node state-path-cli.mjs registry
//   node state-path-cli.mjs layout-root
//
// Prints the absolute path to stdout, exit 0. Unknown arg: exit 2.

import {
  layoutRoot, stateBase, stateFile, auditLogFile,
  sessionIdDir, validationDir, registryFile, projectSlug,
} from "../../hooks/_lib/paths.mjs";

// projectSlug(cwd) — emit the same slug Claude Code uses at
// ~/.claude/projects/<slug>/. Used by resolve-sid.sh to scope its
// jsonl-filename fallback to THIS project only, preventing the
// cross-project SID leak where `ls -t ~/.claude/projects/*/*.jsonl`
// picked the newest-mtime file from any project on the machine.
function currentProjectSlug() {
  const root = process.env.CLAUDE_PROJECT_DIR
             || process.env.CLAUDE_WORKING_DIR
             || process.cwd();
  return projectSlug(root);
}

const key = process.argv[2] || "";
const table = {
  "layout-root": layoutRoot,
  "state-base": stateBase,
  "state-file": stateFile,
  "audit-log": auditLogFile,
  "session-id-dir": sessionIdDir,
  "validation-dir": validationDir,
  "registry": registryFile,
  "project-slug": currentProjectSlug,
};

const fn = table[key];
if (!fn) {
  process.stderr.write(
    `state-path-cli.mjs: unknown key '${key}'. Valid: ${Object.keys(table).join(", ")}\n`
  );
  process.exit(2);
}

try {
  process.stdout.write(fn());
} catch (e) {
  process.stderr.write(`state-path-cli.mjs: ${e.message}\n`);
  process.exit(1);
}
