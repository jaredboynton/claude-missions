// Single source of truth for mission-executor on-disk layout.
//
// v0.8.0: project-scoped state moved out of cwd and under the user home.
// Rationale: the plugin enables on every Claude Code session, in every repo.
// Prior to 0.8.0 the default layoutRoot was "<cwd>/.mission-executor/", so
// every project touched by the CLI ended up with a .mission-executor/ folder
// holding hook-audit.log + session markers, even when no mission was ever
// attached. That's pollution. From 0.8.0 the default lives at
//   ~/.claude/mission-executor/projects/<slug>/
// where <slug> matches Claude Code's existing project-slug scheme used at
// ~/.claude/projects/<slug>/ (absolute path with "/" replaced by "-",
// leading "-" preserved). Missions that explicitly want the old layout
// keep working via MISSION_EXECUTOR_LAYOUT_ROOT.
//
// Resolution order for layoutRoot() (first hit wins):
//   1. MISSION_EXECUTOR_LAYOUT_ROOT env var (absolute or relative to
//      project root) — preferred operator escape hatch.
//   2. MISSION_EXECUTOR_STATE_DIR env var (BACK-COMPAT alias; MUST end
//      in "/state" — trailing "/state" is stripped to derive layout root;
//      any other shape throws a loud error pointing at LAYOUT_ROOT).
//   3. plugin.json "config.layoutRoot"; plugin.json "config.stateDir"
//      accepted with same rule.
//   4. Default (v0.8.0+): <userBase>/projects/<projectSlug(projectRoot())>.
//
// The v0.5.x ".omc/state/mission-executor-state.json" autodetect branch
// was removed in 0.8.0 — it created exactly the cwd pollution we're
// fixing. In-flight missions migrate via scripts/_lib/migrate.mjs >
// migrateProjectStateToUserGlobal() called from mission-cli start|attach.
//
// All subdirectories are CHILDREN of layoutRoot. Every caller uses these
// helpers; no one builds paths by hand.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, basename, dirname } from "node:path";

function projectRoot() {
  const r = process.env.CLAUDE_PROJECT_DIR
         || process.env.CLAUDE_WORKING_DIR
         || process.cwd();
  if (!r || r === "/" || r === "") {
    throw new Error(
      "paths.mjs: project root not resolvable (CLAUDE_PROJECT_DIR unset and cwd is '/'). " +
      "Refusing to pollute filesystem."
    );
  }
  return r;
}

function stripStateSuffix(p) {
  if (basename(p) === "state") return dirname(p);
  throw new Error(
    `MISSION_EXECUTOR_STATE_DIR=${p}: back-compat alias requires a path ending in "/state" ` +
    `(e.g. ".omc/state"). Set MISSION_EXECUTOR_LAYOUT_ROOT instead to specify the layout root directly.`
  );
}

// ~/.claude/mission-executor/ — top-level user-global root. Holds the
// cross-project registry.json and projects/<slug>/ subdirectories.
export function userBase() {
  return join(homedir() || "/tmp", ".claude", "mission-executor");
}

// Deterministic slug derived from an absolute project path. Matches the
// scheme Claude Code uses at ~/.claude/projects/<slug>/: both "/" and "_"
// collapse to "-". Example:
//   /Users/jared/__void/tech-talks  -> -Users-jared---void-tech-talks
// (leading "/" becomes leading "-"; "__" becomes "---" because each of
// the two underscores and the preceding "/" each map to "-").
export function projectSlug(absPath) {
  if (!absPath || typeof absPath !== "string") {
    throw new Error(`projectSlug: expected absolute path string, got ${absPath}`);
  }
  if (!isAbsolute(absPath)) {
    throw new Error(`projectSlug: expected absolute path, got relative "${absPath}"`);
  }
  return absPath.replace(/[/_]/g, "-");
}

let _cached = null;
export function layoutRoot() {
  if (_cached) return _cached;
  const root = projectRoot();
  const abs = (p) => isAbsolute(p) ? p : join(root, p);

  const envLR = process.env.MISSION_EXECUTOR_LAYOUT_ROOT;
  if (envLR) return (_cached = abs(envLR));

  const envSD = process.env.MISSION_EXECUTOR_STATE_DIR;
  if (envSD) return (_cached = stripStateSuffix(abs(envSD)));

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    try {
      const pj = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"));
      const cfgLR = pj?.config?.layoutRoot;
      if (cfgLR) return (_cached = abs(cfgLR));
      const cfgSD = pj?.config?.stateDir;
      if (cfgSD) return (_cached = stripStateSuffix(abs(cfgSD)));
    } catch {}
  }

  return (_cached = join(userBase(), "projects", projectSlug(root)));
}

export function stateBase()        { return join(layoutRoot(), "state"); }
export function stateFile()        { return join(stateBase(), "mission-executor-state.json"); }
export function stateLockFile()    { return join(stateBase(), "mission-executor-state.json.lock"); }
export function abortFile()        { return join(stateBase(), "mission-executor-abort"); }
export function auditLogFile()     { return join(stateBase(), "hook-audit.log"); }
export function sessionIdDir()     { return join(stateBase(), "sessions"); }
export function sessionIdFile(sid) { return join(sessionIdDir(), `${sid}.active`); }
export function heartbeatFile(sid) { return join(stateBase(), `driver-${sid}.heartbeat`); }
export function validationDir()    { return join(layoutRoot(), "validation"); }
export function proofsDir(id)      { return join(validationDir(), "proofs", id); }
export function claimsLogFile()    { return join(validationDir(), "worker-claims.jsonl"); }
export function workerSkillsDir()  { return join(layoutRoot(), "skills"); }

// v0.5.1: per-mission event stream. Lives next to state.json / features.json /
// validation-state.json INSIDE the mission directory (not under layoutRoot),
// matching droid's MissionFileService location so dual-runtime workflows can
// share the file.
export function progressLogFile(missionPath) { return join(missionPath, "progress_log.jsonl"); }

// Cross-project registry. Single top-level file under userBase(), shared
// across every project. Was already user-global pre-0.8.0.
export function registryFile()     { return join(userBase(), "registry.json"); }
export function registryLockFile() { return registryFile() + ".lock"; }

export function __resetForTest() { _cached = null; }
