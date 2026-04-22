// Mission fixture helpers for the 0.4.7 defect-fix test suite.
//
// Builds a real, executable mission on a tmp filesystem: a git-init'd
// workingDir, a mission dir with features.json + validation-contract.md +
// validation-state.json, and on-disk proof bundles whose hashes and commit
// SHAs are consistent so the critic's Stage A accepts them.
//
// Intentionally separate from tests/_helpers.mjs (which belongs to the
// in-flight mission-cli test suite). Zero deps beyond Node built-ins.

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(HERE, "..");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function gitInit(dir) {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execSync("git init -q -b main", { cwd: dir, env });
  execSync("git add -A", { cwd: dir, env });
  execSync("git commit -qm init", { cwd: dir, env });
  return execSync("git rev-parse HEAD", { cwd: dir, env, encoding: "utf8" }).trim();
}

// Build an "all green" mission with N self-contained shell-generic assertions
// whose evidence is parseable by the current dispatcher (so re-execution
// stays green). Returns a handle with absolute paths and a cleanup fn.
//
// Each assertion body has shape:
//   ### VAL-TEST-NNN: <title>
//   Tool: `shell+test`
//   Evidence: `<cmd>` exits 0
//
// files: extra { relPath: content } written into workingDir before git-init.
export function buildGreenMission({ files = {}, assertions } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mex-fix-"));
  const workingDir = join(root, "work");
  const missionPath = join(root, "mission");
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(missionPath, { recursive: true });

  // Default fixture: two passing shell-generic assertions against files we
  // write into the workingDir.
  const baseFiles = { "hello.txt": "hello world\n", "counters.txt": "42\n" };
  const baseAssertions = assertions || [
    { id: "VAL-TEST-001", title: "hello.txt exists", cmd: "test -e hello.txt", touchpoint: "tree:hello.txt" },
    { id: "VAL-TEST-002", title: "counters.txt non-empty", cmd: "test -s counters.txt", touchpoint: "tree:counters.txt" },
  ];

  for (const [relPath, content] of Object.entries({ ...baseFiles, ...files })) {
    const abs = join(workingDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  const headSha = gitInit(workingDir);

  writeFileSync(join(missionPath, "working_directory.txt"), workingDir);

  const features = baseAssertions.map((a, i) => ({
    id: `F-${String(i + 1).padStart(3, "0")}`,
    title: a.title,
    description: `assertion backs \`${a.touchpoint.replace(/^tree:/, "")}\``,
    fulfills: [a.id],
    milestone: "M1",
  }));
  writeFileSync(join(missionPath, "features.json"),
    JSON.stringify({ features }, null, 2) + "\n");

  const contractLines = ["## Validation", ""];
  for (const a of baseAssertions) {
    contractLines.push(`### ${a.id}: ${a.title}`);
    contractLines.push("Tool: `shell+test`");
    contractLines.push(`Evidence: \`${a.cmd}\` exits 0`);
    contractLines.push("");
  }
  writeFileSync(join(missionPath, "validation-contract.md"), contractLines.join("\n"));

  const assertionsState = {};
  const executedAt = new Date().toISOString();
  for (const a of baseAssertions) {
    const proofDir = join(missionPath, ".omc", "validation", "proofs", a.id);
    mkdirSync(proofDir, { recursive: true });
    const stdoutContent = "";
    const stderrContent = "";
    writeFileSync(join(proofDir, "stdout.txt"), stdoutContent);
    writeFileSync(join(proofDir, "stderr.txt"), stderrContent);
    const command = `# tool=shell+test (shell-generic dispatch)\n${a.cmd}`;
    const expected = `tool='shell+test' exit=0`;
    writeFileSync(join(proofDir, "meta.json"), JSON.stringify({
      id: a.id,
      toolType: "cli-binary",
      command,
      exitCode: 0,
      expected,
      executedAt,
    }, null, 2) + "\n");

    assertionsState[a.id] = {
      status: "passed",
      validatedAtMilestone: "M1",
      evidence: expected,
      proof: {
        commitSha: headSha,
        toolType: "cli-binary",
        command,
        exitCode: 0,
        stdoutPath: join(".omc", "validation", "proofs", a.id, "stdout.txt"),
        stderrPath: join(".omc", "validation", "proofs", a.id, "stderr.txt"),
        stdoutSha256: sha256(stdoutContent),
        stderrSha256: sha256(stderrContent),
        touchpoints: [a.touchpoint],
        executedAt,
        executor: "execute-assertion.mjs",
      },
    };
  }

  const valStatePath = join(missionPath, "validation-state.json");
  writeFileSync(valStatePath,
    JSON.stringify({ assertions: assertionsState }, null, 2) + "\n");

  return {
    root,
    missionPath,
    workingDir,
    headSha,
    valStatePath,
    assertionIds: baseAssertions.map((a) => a.id),
    cleanup() {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

export function fileSha256(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Sanitized env for spawning plugin scripts against a fixture. Sets
// CLAUDE_PROJECT_DIR / LAYOUT_ROOT so the in-flight 0.5.0 paths.mjs work
// happens inside the fixture, not the real repo.
export function fixtureEnv(fx, extra = {}) {
  return {
    ...process.env,
    CLAUDE_PROJECT_DIR: fx.workingDir,
    CLAUDE_WORKING_DIR: fx.workingDir,
    MISSION_EXECUTOR_LAYOUT_ROOT: join(fx.missionPath, "_layout"),
    ...extra,
  };
}
