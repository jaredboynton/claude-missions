// Single source of truth for mission-executor on-disk layout.
//
// Resolution order for layoutRoot() (first hit wins):
//   1. MISSION_EXECUTOR_LAYOUT_ROOT env var (absolute or relative to project root) - preferred
//   2. MISSION_EXECUTOR_STATE_DIR env var (BACK-COMPAT alias; MUST end in "/state"
//      - the trailing "/state" is stripped to derive the layout root; any other
//      shape throws a loud error pointing users at LAYOUT_ROOT)
//   3. plugin.json "config.layoutRoot"; plugin.json "config.stateDir" accepted with same rule
//   4. Legacy autodetect: if <project>/.omc/state/mission-executor-state.json exists, use ".omc"
//      (keeps OMC installs + in-flight 0.4.x missions working without intervention)
//   5. Default: ".mission-executor"
//
// All subdirectories are CHILDREN of layoutRoot (not siblings of stateBase).
// All callers use these helpers; no one builds paths by hand.

import { readFileSync, existsSync } from "node:fs";
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

  if (existsSync(join(root, ".omc/state/mission-executor-state.json"))) {
    return (_cached = join(root, ".omc"));
  }

  return (_cached = join(root, ".mission-executor"));
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
export function handoffsInboxDir() { return join(layoutRoot(), "handoffs-inbox"); }
export function workerSkillsDir()  { return join(layoutRoot(), "skills"); }
export function registryFile()     { return join(process.env.HOME || "/tmp", ".claude/mission-executor/registry.json"); }
export function registryLockFile() { return registryFile() + ".lock"; }

export function __resetForTest() { _cached = null; }
