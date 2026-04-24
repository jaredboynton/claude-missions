// Guards against SID leakage across projects in resolve-sid.sh.
//
// The pre-0.8.4 resolver's Tier 3b globbed ~/.claude/projects/*/*.jsonl
// across EVERY project on the machine, then picked the newest by mtime.
// On a multi-project workstation this silently handed out a SID from an
// unrelated project whenever the current project hadn't yet had its
// .active file written by SessionStart — and the plugin then wrote a
// state.json whose `attachedSessions[0].sessionId` didn't match the
// SID of the actual live Claude Code session, so every later
// `is-attached` check returned `attached: false` and all enforcement
// hooks (autopilot-lock, no-ask-during-mission, worker-boundary-
// enforcer) silently no-opped. That's the failure mode this test
// freezes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(__dirname);
const RESOLVER = join(PLUGIN_ROOT, "scripts/_lib/resolve-sid.sh");

// Execute resolve-sid.sh as a standalone script (post-0.8.5 pattern).
// Pre-0.8.5 the shell function was sourced into the caller; that relied
// on $CLAUDE_PLUGIN_ROOT being exported (it isn't — see commands-arg-
// shape.test.mjs for the full rationale). Tests MUST exercise the exact
// invocation pattern commands use today.
function runResolver(env) {
  const r = spawnSync(RESOLVER, [], { env, encoding: "utf8" });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status };
}

// Sandbox with a controlled HOME and CLAUDE_PROJECT_DIR so the resolver's
// tier 3b glob hits a known set of .jsonl files, and layoutRoot() points
// into a per-test userBase so Tier 3a can be exercised.
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "me-sid-home-"));
  const proj = mkdtempSync(join(tmpdir(), "me-sid-proj-"));
  // Claude Code's project slug scheme: "/" and "_" -> "-".
  const projSlug = realpathSync(proj).replace(/[/_]/g, "-");
  // Pre-create the Claude projects directory for this project; individual
  // tests decide whether to drop jsonl files into it.
  mkdirSync(join(home, ".claude", "projects", projSlug), { recursive: true });
  return {
    home, proj, projSlug,
    projectsDir: join(home, ".claude", "projects"),
    thisProjectDir: join(home, ".claude", "projects", projSlug),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: realpathSync(proj),
      CLAUDE_WORKING_DIR: realpathSync(proj),
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      // Wipe any inherited session-id env vars so only the resolver's
      // lookup logic runs.
      CLAUDE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      // Point layoutRoot at a dedicated tmpdir to avoid colliding with
      // the host's real ~/.claude/mission-executor/ state.
      MISSION_EXECUTOR_LAYOUT_ROOT: join(proj, ".me-state"),
    },
    cleanup() {
      try { rmSync(home, { recursive: true, force: true }); } catch {}
      try { rmSync(proj, { recursive: true, force: true }); } catch {}
    },
  };
}

function seedJsonl(dir, sid, mtimeMs) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, "");
  if (mtimeMs) {
    const t = new Date(mtimeMs);
    utimesSync(p, t, t);
  }
  return p;
}

function seedActive(sidDir, sid) {
  mkdirSync(sidDir, { recursive: true });
  const p = join(sidDir, `${sid}.active`);
  writeFileSync(p, new Date().toISOString());
  return p;
}

test("tier 1: CLAUDE_SESSION_ID env wins over everything", () => {
  const s = sandbox();
  try {
    const env = { ...s.env, CLAUDE_SESSION_ID: "env-sid-wins" };
    // Seed contradicting .active and jsonl so we catch any short-circuit bug.
    seedActive(join(s.env.MISSION_EXECUTOR_LAYOUT_ROOT, "state/sessions"), "other-sid");
    seedJsonl(s.thisProjectDir, "yet-another-sid");
    const r = runResolver(env);
    assert.equal(r.stdout, "env-sid-wins");
  } finally { s.cleanup(); }
});

test("tier 1 fallback: CLAUDE_CODE_SESSION_ID used when CLAUDE_SESSION_ID unset", () => {
  const s = sandbox();
  try {
    const env = { ...s.env, CLAUDE_CODE_SESSION_ID: "code-sid-wins" };
    const r = runResolver(env);
    assert.equal(r.stdout, "code-sid-wins");
  } finally { s.cleanup(); }
});

test("tier 3a: .active file in project's sessionIdDir resolves", () => {
  const s = sandbox();
  try {
    seedActive(join(s.env.MISSION_EXECUTOR_LAYOUT_ROOT, "state/sessions"), "active-sid");
    const r = runResolver(s.env);
    assert.equal(r.stdout, "active-sid");
  } finally { s.cleanup(); }
});

test("tier 3b: PROJECT-SCOPED jsonl fallback when no .active exists", () => {
  const s = sandbox();
  try {
    // Only the current project has a jsonl; another project is present
    // but should be IGNORED by the project-scoped glob.
    seedJsonl(s.thisProjectDir, "correct-sid");
    mkdirSync(join(s.projectsDir, "-other-project"), { recursive: true });
    seedJsonl(join(s.projectsDir, "-other-project"), "wrong-sid-other-project");
    const r = runResolver(s.env);
    assert.equal(r.stdout, "correct-sid");
  } finally { s.cleanup(); }
});

test("tier 3b MUST NOT leak SID from a newer jsonl in a different project", () => {
  // The pre-0.8.4 failure mode: Tier 3b globbed ~/.claude/projects/*/*.jsonl
  // and picked the newest across ALL projects. This asserts that even when
  // another project has a jsonl with a much NEWER mtime, the resolver only
  // looks inside the current project's slug directory and returns empty
  // (rather than picking the cross-project file).
  const s = sandbox();
  try {
    // NO .active file for current project; NO jsonl for current project.
    // Another project has a much newer jsonl. Pre-0.8.4 resolver would
    // have returned that SID; post-0.8.4 must return empty.
    const otherProjDir = join(s.projectsDir, "-Users-bob-another-repo");
    mkdirSync(otherProjDir, { recursive: true });
    seedJsonl(otherProjDir, "cross-project-sid-should-not-leak", Date.now() + 60_000);

    const r = runResolver(s.env);
    assert.equal(
      r.stdout, "",
      "resolver must not leak SID from a sibling project even when that " +
      "project's jsonl is newer. Got: " + r.stdout,
    );
  } finally { s.cleanup(); }
});

test("tier 3b: empty when current project's slug dir does not exist", () => {
  const s = sandbox();
  try {
    // Remove the pre-seeded current-project projects dir.
    rmSync(s.thisProjectDir, { recursive: true, force: true });
    // Add a sibling project with a jsonl that should NOT be returned.
    const otherProjDir = join(s.projectsDir, "-some-other-proj");
    mkdirSync(otherProjDir, { recursive: true });
    seedJsonl(otherProjDir, "sibling-sid");
    const r = runResolver(s.env);
    assert.equal(r.stdout, "");
  } finally { s.cleanup(); }
});

test("all tiers empty -> empty string (caller refuses to proceed)", () => {
  const s = sandbox();
  try {
    // No .active, no jsonl, no env vars — truly empty state.
    const r = runResolver(s.env);
    assert.equal(r.stdout, "");
    // The resolver itself always exits 0; the empty string is the signal.
    assert.equal(r.code, 0);
  } finally { s.cleanup(); }
});

test("state-path-cli.mjs project-slug emits the current project's slug", () => {
  const s = sandbox();
  try {
    const r = spawnSync(process.execPath, [
      join(PLUGIN_ROOT, "scripts/_lib/state-path-cli.mjs"),
      "project-slug",
    ], { env: s.env, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, s.projSlug);
  } finally { s.cleanup(); }
});

test("resolver works without CLAUDE_PLUGIN_ROOT (self-locates via $0)", () => {
  // 0.8.5 contract: slash-command !cmd blocks do NOT export
  // CLAUDE_PLUGIN_ROOT (anthropics/claude-code#42564, #48230, #24529).
  // The resolver must still find its sibling state-path-cli.mjs and
  // resolve the SID correctly via self-location.
  const s = sandbox();
  try {
    seedActive(join(s.env.MISSION_EXECUTOR_LAYOUT_ROOT, "state/sessions"), "no-plugin-root-sid");
    const env = { ...s.env };
    delete env.CLAUDE_PLUGIN_ROOT;
    const r = runResolver(env);
    assert.equal(
      r.stdout, "no-plugin-root-sid",
      `expected SID even with CLAUDE_PLUGIN_ROOT unset (stderr: ${r.stderr})`,
    );
  } finally { s.cleanup(); }
});

test("resolver is executable and prints SID directly (no sourcing required)", () => {
  // The command files invoke the resolver as a standalone script:
  //   SID=$("…/resolve-sid.sh")
  // That requires the file to be executable AND to print the SID to
  // stdout when run directly. Sourcing-only shapes would regress.
  const s = sandbox();
  try {
    seedActive(join(s.env.MISSION_EXECUTOR_LAYOUT_ROOT, "state/sessions"), "exec-shape-sid");
    // Run directly, not via `sh -c` — exercises the shebang + exec bit.
    const r = spawnSync(RESOLVER, [], { env: s.env, encoding: "utf8" });
    assert.equal(r.status, 0, `exit ${r.status}, stderr: ${r.stderr}`);
    assert.equal(r.stdout, "exec-shape-sid");
  } finally { s.cleanup(); }
});
