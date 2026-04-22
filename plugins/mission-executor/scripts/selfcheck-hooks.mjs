#!/usr/bin/env node
// Selfcheck: verify that every hook declared for this plugin is discoverable
// by Claude Code and that every command path resolves to an existing file.
//
// Why this exists: in 0.4.5 the plugin shipped with `hooks.json` in
// `.claude-plugin/` instead of `hooks/`. Claude Code auto-discovery only
// scans `hooks/hooks.json` (or a path set in `plugin.json`'s `hooks` field).
// Neither was the case, so every mission-executor hook silently failed to
// register. Sessions ran without any enforcement, hook-audit.log stayed
// empty, and Claude Code's Stop / PreToolUse dispatch went straight past us.
//
// This script runs the same discovery logic Claude Code uses so we catch
// registration failures at release time instead of during the next mission.
//
// Usage: node scripts/selfcheck-hooks.mjs
// Exit 0 on success, 1 on any problem.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");

const problems = [];
function fail(msg) { problems.push(msg); }

// 1. plugin.json must exist and be valid JSON.
const manifestPath = join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
if (!existsSync(manifestPath)) {
  fail(`missing manifest: ${manifestPath}`);
} else {
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (e) { fail(`manifest is not valid JSON: ${e.message}`); }

  if (manifest) {
    if (!manifest.name) fail("manifest.name is required");
    if (!manifest.version) fail("manifest.version is required");

    // Claude Code NEVER scans `.claude-plugin/hooks.json`. If it exists,
    // it's a regression -- the 0.4.5 bug. Flag unconditionally.
    const legacy = join(PLUGIN_ROOT, ".claude-plugin", "hooks.json");
    if (existsSync(legacy)) {
      fail(`legacy hooks.json at ${legacy} is ignored by Claude Code; move to hooks/hooks.json`);
    }

    // Resolve hooks file. Either the manifest declares `hooks`, or Claude
    // Code auto-discovers `hooks/hooks.json` at the plugin root.
    let hooksPath = null;
    if (typeof manifest.hooks === "string") {
      if (!manifest.hooks.startsWith("./")) {
        fail(`manifest.hooks must start with "./": got "${manifest.hooks}"`);
      } else {
        hooksPath = resolve(PLUGIN_ROOT, manifest.hooks);
      }
    } else if (manifest.hooks === undefined) {
      // Auto-discovery path.
      hooksPath = join(PLUGIN_ROOT, "hooks", "hooks.json");
    } else {
      fail(`manifest.hooks must be a string path or omitted; got ${typeof manifest.hooks}`);
    }

    if (hooksPath) {
      if (!existsSync(hooksPath)) {
        fail(`hooks config not found at ${hooksPath}`);
      } else {
        let hooksDoc;
        try { hooksDoc = JSON.parse(readFileSync(hooksPath, "utf8")); }
        catch (e) { fail(`hooks.json is not valid JSON: ${e.message}`); }

        if (hooksDoc) {
          const events = hooksDoc.hooks || {};
          let commandCount = 0;
          for (const [event, groups] of Object.entries(events)) {
            if (!Array.isArray(groups)) {
              fail(`hooks.${event} must be an array`);
              continue;
            }
            for (const [gi, group] of groups.entries()) {
              const cmds = group.hooks || [];
              if (!Array.isArray(cmds)) {
                fail(`hooks.${event}[${gi}].hooks must be an array`);
                continue;
              }
              for (const [ci, h] of cmds.entries()) {
                if (h.type !== "command") continue;
                commandCount++;
                const cmd = h.command || "";
                // Extract every ${CLAUDE_PLUGIN_ROOT}-relative .mjs path and
                // confirm it exists. The regex tolerates ${VAR} and $VAR forms.
                const re = /(\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)(\/[^"'\s]+\.mjs)/g;
                let m;
                let matched = false;
                while ((m = re.exec(cmd))) {
                  matched = true;
                  const rel = m[2].replace(/^\//, "");
                  const abs = join(PLUGIN_ROOT, rel);
                  if (!existsSync(abs)) {
                    fail(`hooks.${event}[${gi}].hooks[${ci}] references missing file: ${abs}`);
                  }
                }
                if (!matched && /\.mjs/.test(cmd)) {
                  fail(`hooks.${event}[${gi}].hooks[${ci}] has a .mjs path not rooted at \${CLAUDE_PLUGIN_ROOT}: ${cmd}`);
                }
              }
            }
          }
          if (commandCount === 0) {
            fail("hooks.json declared no command hooks; did you forget to register them?");
          }
        }
      }
    }
  }
}

if (problems.length > 0) {
  process.stderr.write("selfcheck-hooks FAILED:\n");
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}

process.stdout.write("selfcheck-hooks OK\n");
process.exit(0);
