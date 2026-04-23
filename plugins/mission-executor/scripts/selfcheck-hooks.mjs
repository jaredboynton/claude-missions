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

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

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

// ============================================================================
// v0.5.0 assertions (spec §0.5, §6.4, §7.3, §10)
// ============================================================================

// v0.5.1: Phase-A probe gate removed. The probes ran in the 0.5.0 cycle,
// the findings were absorbed into CHANGELOG.md's 0.5.1 entry under "Probe
// gates", and the PROBE_RESULTS.md artifact was archived out of tree. The
// spec's §0.1 checkboxes remain unchecked because the answer for Tiers 1
// and 2 is "not available in slash-command bash" (evidenced), which is
// resolved evidence, not unchecked work — the selfcheck no longer gates
// on the checkbox count. See spec §0 and CHANGELOG.md for the record.

// --- §10 commands/*.md frontmatter + allowed-tools --------------------------

const commandsDir = join(PLUGIN_ROOT, "commands");
if (existsSync(commandsDir)) {
  for (const entry of readdirSync(commandsDir)) {
    if (!entry.endsWith(".md")) continue;
    const full = join(commandsDir, entry);
    const src = readFileSync(full, "utf8");
    if (!src.startsWith("---\n")) {
      fail(`commands/${entry}: missing YAML frontmatter (must start with "---")`);
      continue;
    }
    const end = src.indexOf("\n---\n", 4);
    if (end < 0) {
      fail(`commands/${entry}: unterminated YAML frontmatter`);
      continue;
    }
    const fm = src.slice(4, end);
    if (!/^description:\s*\S/m.test(fm)) {
      fail(`commands/${entry}: frontmatter missing 'description:'`);
    }
    if (!/^allowed-tools:/m.test(fm)) {
      fail(`commands/${entry}: frontmatter missing 'allowed-tools:'`);
    } else if (!/Bash\(node:\*\)/.test(fm)) {
      fail(`commands/${entry}: allowed-tools must include Bash(node:*)`);
    }
  }
}

// --- §6.4 no .omc/state/ literals outside allowlist -------------------------

const OMC_STATE_ALLOWLIST = new Set([
  "hooks/_lib/paths.mjs",
  "scripts/_lib/migrate.mjs",  // v0.8.0 project-state migrator probes legacy layouts
  "scripts/selfcheck-hooks.mjs",  // defines the allowlist itself
  "AGENTS.md",
  "CHANGELOG.md",
  "README.md",
]);
const OMC_STATE_DIR_ALLOWLIST = ["tests/"];  // tests legitimately reference the legacy literal
const MD_DIR_ALLOWLIST = ["skills/", "commands/", "tests/", ".factory/"];

function walkFiles(root) {
  const out = [];
  const stack = [root];
  const skip = new Set(["node_modules", ".git", ".me", ".mission-executor", ".omc"]);
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d); } catch { continue; }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) out.push(p);
    }
  }
  return out;
}

for (const abs of walkFiles(PLUGIN_ROOT)) {
  const rel = abs.slice(PLUGIN_ROOT.length + 1);
  if (OMC_STATE_ALLOWLIST.has(rel)) continue;
  if (OMC_STATE_DIR_ALLOWLIST.some((d) => rel.startsWith(d))) continue;
  if (MD_DIR_ALLOWLIST.some((d) => rel.startsWith(d)) && rel.endsWith(".md")) continue;
  if (rel.endsWith(".md")) continue;  // top-level docs (README etc) allowlisted by dir prefix above
  let content;
  try { content = readFileSync(abs, "utf8"); } catch { continue; }
  if (content.includes(".omc/state/")) {
    fail(`§6.4: ${rel} contains '.omc/state/' literal outside allowlist; route through hooks/_lib/paths.mjs instead`);
  }
}

// --- §10 no walkUpForState / walkUpForAbort -- as IMPORTS/CALLS/DEFINES -----
// Strings in comments (e.g. "walkUpForState -> DELETED" or failure messages
// mentioning the names) are fine. We only care about live references.

const WALK_UP_LIVE_PATTERNS = [
  /\bwalkUpFor(State|Abort)\s*\(/,      // call
  /import\s*\{[^}]*walkUpFor/,          // named import
  /export\s+function\s+walkUpFor/,      // definition
];
for (const abs of walkFiles(PLUGIN_ROOT)) {
  if (!abs.endsWith(".mjs")) continue;
  const rel = abs.slice(PLUGIN_ROOT.length + 1);
  if (rel === "scripts/selfcheck-hooks.mjs") continue;  // the check itself names these
  const content = readFileSync(abs, "utf8");
  for (const re of WALK_UP_LIVE_PATTERNS) {
    if (re.test(content)) {
      fail(`§6.1/§10: ${rel} has a live reference to walkUpForState/walkUpForAbort (deleted in v0.5.0); matched ${re}`);
      break;
    }
  }
}

// --- §7.3 mission-lifecycle.mjs arg-surface parity with mission-cli.mjs -----

try {
  const mlcHelp = execSync(`node "${join(PLUGIN_ROOT, "scripts/mission-lifecycle.mjs")}" --help`, {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  });
  const cliHelp = execSync(`node "${join(PLUGIN_ROOT, "scripts/mission-cli.mjs")}" --help`, {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  });
  const subs = (s) => {
    const m = s.match(/Subcommands?:\s*([^\n]+)/i);
    if (!m) return new Set();
    return new Set(m[1].split(",").map((x) => x.trim()).filter(Boolean));
  };
  const a = subs(mlcHelp); const b = subs(cliHelp);
  const missing = [...b].filter((x) => !a.has(x));
  if (missing.length > 0) {
    fail(`§7.3: mission-lifecycle.mjs --help is missing subcommands that mission-cli.mjs exposes: ${missing.join(", ")}`);
  }
} catch (e) {
  fail(`§7.3: unable to run --help on mission-cli.mjs / mission-lifecycle.mjs: ${e.message}`);
}

// --- §10 registry directory creatable ---------------------------------------

const registryParent = join(process.env.HOME || "/tmp", ".claude/mission-executor");
try {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(registryParent, { recursive: true });
} catch (e) {
  fail(`§10: cannot create registry parent directory ${registryParent}: ${e.message}`);
}

if (problems.length > 0) {
  process.stderr.write("selfcheck-hooks FAILED:\n");
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}

process.stdout.write("selfcheck-hooks OK\n");
process.exit(0);
