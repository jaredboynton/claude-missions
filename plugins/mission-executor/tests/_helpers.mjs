// Shared test helpers. Zero deps beyond node built-ins.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(here);
})();
export const MCLI = join(PLUGIN_ROOT, "scripts/mission-cli.mjs");
export const HOOKS = join(PLUGIN_ROOT, "hooks");

// Creates an isolated sandbox: new project root, new fake HOME (so the global
// registry doesn't leak across tests), a sample mission directory with the
// shape v0.4.6+ expects. Returns { root, home, missionPath, env, cleanup }.
export function sandbox({ layoutRoot = ".me" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "me-test-"));
  const home = mkdtempSync(join(tmpdir(), "me-home-"));
  const missionPath = join(root, "mission");
  mkdirSync(missionPath, { recursive: true });
  writeFileSync(join(missionPath, "state.json"), '{"state":"active"}\n');
  writeFileSync(join(missionPath, "features.json"), '{"features":[]}\n');
  writeFileSync(join(missionPath, "validation-state.json"), '{"assertions":{}}\n');

  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: root,
    CLAUDE_WORKING_DIR: root,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    MISSION_EXECUTOR_LAYOUT_ROOT: layoutRoot,
    HOME: home,
    // Prevent inherited env from prior test runs leaking in
    MISSION_EXECUTOR_STATE_DIR: "",
  };
  delete env.MISSION_EXECUTOR_STATE_DIR;

  return {
    root, home, missionPath, env,
    layoutRootAbs: join(root, layoutRoot),
    stateFile: join(root, layoutRoot, "state/mission-executor-state.json"),
    stateLockFile: join(root, layoutRoot, "state/mission-executor-state.json.lock"),
    sessionIdDir: join(root, layoutRoot, "state/sessions"),
    validationDir: join(root, layoutRoot, "validation"),
    registryFile: join(home, ".claude/mission-executor/registry.json"),
    cleanup() {
      try { rmSync(root, { recursive: true, force: true }); } catch {}
      try { rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

// Run mission-cli.mjs and return { code, stdout, stderr, json? }.
export function runCli(env, args) {
  const r = spawnSync(process.execPath, [MCLI, ...args], { env, encoding: "utf8" });
  let json = null;
  try { json = JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

export function runHook(env, hookName, stdinPayload) {
  const r = spawnSync(process.execPath, [join(HOOKS, hookName)], {
    env, encoding: "utf8", input: JSON.stringify(stdinPayload),
  });
  let out = null;
  try { out = JSON.parse(r.stdout || "{}"); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, out };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}
