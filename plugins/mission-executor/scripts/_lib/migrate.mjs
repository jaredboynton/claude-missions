// Legacy 0.5.x -> 0.6.0 mission migration.
//
// 0.5.x proofs carry fields that 0.6.0 no longer reads (commitSha, childRepo)
// and reference proof files under locations the 0.6.0 resolver doesn't know
// about (<workingDir>/.mission-executor/validation/ or <workingDir>/.omc/
// validation/). This migrator is called once at the top of executeAssertion
// and evaluateMission: on first touch it rewrites the mission's
// validation-state.json and moves the bundle files into place; subsequent
// runs are no-ops because the deprecated fields are gone.
//
// Called opportunistically — never fatal. If anything fails mid-migration,
// we log to stderr and return; the caller proceeds with whatever state it
// found, and the worst case is a missing proof flips the assertion to
// "pending" via the contract-change detector on next invalidate run.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { proofsDir } from "./mission-paths.mjs";
import { userBase, projectSlug } from "../../hooks/_lib/paths.mjs";

const LEGACY_PROOF_DIRS = [".mission-executor/validation/proofs", ".omc/validation/proofs"];

function deprecatedFieldsPresent(proof) {
  return Boolean(proof && (proof.commitSha !== undefined || proof.childRepo !== undefined));
}

function legacyPathLooking(p) {
  // v0.6.0 proof paths are "validation/proofs/<id>/<kind>.txt" (missionDir-
  // relative) or absolute. A path starting with ".omc/" or ".mission-executor/"
  // is a 0.5.x leftover that needs migration.
  return typeof p === "string" && (p.startsWith(".omc/") || p.startsWith(".mission-executor/"));
}

// Attempt to move a legacy proof file into the 0.6.0 location.
// Checks both the workingDir-anchored legacy dirs AND the missionDir-
// anchored legacy dirs (some 0.4.x installs wrote proofs inside the mission
// dir at .omc/validation/proofs/).
function relocateProofFiles(missionPath, workingDir, id) {
  const targetDir = proofsDir(missionPath, id);
  let moved = false;
  for (const relLegacy of LEGACY_PROOF_DIRS) {
    for (const base of [missionPath, workingDir].filter(Boolean)) {
      const srcDir = join(base, relLegacy, id);
      if (!existsSync(srcDir)) continue;
      mkdirSync(targetDir, { recursive: true });
      for (const name of ["stdout.txt", "stderr.txt", "meta.json"]) {
        const src = join(srcDir, name);
        const dst = join(targetDir, name);
        if (existsSync(src) && !existsSync(dst)) {
          try { renameSync(src, dst); moved = true; } catch { /* ignore */ }
        }
      }
    }
  }
  return moved;
}

export function upgradeLegacy052Proofs(missionPath) {
  const dir = resolve(missionPath);
  const vsPath = join(dir, "validation-state.json");
  if (!existsSync(vsPath)) return { migrated: 0, invalidated: 0 };

  let vs;
  try { vs = JSON.parse(readFileSync(vsPath, "utf8")); }
  catch { return { migrated: 0, invalidated: 0 }; }

  const wdPath = join(dir, "working_directory.txt");
  const workingDir = existsSync(wdPath)
    ? readFileSync(wdPath, "utf8").trim() || null
    : null;

  const assertions = vs.assertions || {};
  const migrated = [];
  const invalidated = [];
  let touched = false;

  for (const [id, entry] of Object.entries(assertions)) {
    if (entry.status !== "passed" || !entry.proof) continue;
    const proof = entry.proof;
    const needsFieldStrip = deprecatedFieldsPresent(proof);
    const needsPathRewrite = legacyPathLooking(proof.stdoutPath) || legacyPathLooking(proof.stderrPath);
    if (!needsFieldStrip && !needsPathRewrite) continue;

    if (needsPathRewrite) {
      const relocated = relocateProofFiles(dir, workingDir, id);
      // Whether or not the move succeeded, rewrite paths to the 0.6.0 form.
      // If the files aren't there, the next critic run's hash check will
      // flip the assertion via the missing-proof path — benign.
      proof.stdoutPath = join("validation", "proofs", id, "stdout.txt");
      proof.stderrPath = join("validation", "proofs", id, "stderr.txt");
      if (!relocated) {
        // Target files missing post-move -> mark for invalidation. The
        // critic's Stage A will catch this and flag as missing-proof / hash-
        // mismatch, but we can short-circuit by flipping to pending here.
        const stdoutAbs = join(dir, proof.stdoutPath);
        if (!existsSync(stdoutAbs)) {
          invalidated.push(id);
          entry.status = "pending";
          delete entry.proof;
          touched = true;
          continue;
        }
      }
    }

    if (deprecatedFieldsPresent(proof)) {
      delete proof.commitSha;
      delete proof.childRepo;
    }

    migrated.push(id);
    touched = true;
  }

  if (touched) {
    writeFileSync(vsPath, JSON.stringify(vs, null, 2) + "\n");
    if (migrated.length > 0 || invalidated.length > 0) {
      process.stderr.write(
        `mission-executor: upgraded ${migrated.length} 0.5.x proof(s) to 0.6.0 schema` +
        (invalidated.length > 0 ? `; invalidated ${invalidated.length} with missing bundle file(s)` : "") +
        ` at ${vsPath}\n`,
      );
    }
  }

  return { migrated: migrated.length, invalidated: invalidated.length };
}

// v0.8.0 migration: project-scoped state moved from
//   <workingDir>/.mission-executor/state/  (or <workingDir>/.omc/state/)
// to
//   ~/.claude/mission-executor/projects/<slug>/state/
//
// Called once per mission-cli start|attach with the absolute workingDir.
// Idempotent: if the user-global target already has state, the function
// leaves both sides alone and emits a stderr warning. If the target is
// absent but legacy is present, the entire state dir is copied.
// Originals are never deleted — operators do that themselves after
// verifying the migration.
//
// Return: { migrated: <absPath>|null, skipped: <reason>|null }.
export function migrateProjectStateToUserGlobal(workingDir) {
  if (!workingDir || typeof workingDir !== "string") {
    return { migrated: null, skipped: "no-working-dir" };
  }
  const abs = resolve(workingDir);

  // If the operator has MISSION_EXECUTOR_LAYOUT_ROOT set, hooks resolve
  // layoutRoot() to that value — no migration needed or wanted.
  if (process.env.MISSION_EXECUTOR_LAYOUT_ROOT || process.env.MISSION_EXECUTOR_STATE_DIR) {
    return { migrated: null, skipped: "env-override-active" };
  }

  let targetStateDir;
  try {
    targetStateDir = join(userBase(), "projects", projectSlug(abs), "state");
  } catch (e) {
    return { migrated: null, skipped: `slug-error:${e.message}` };
  }

  const legacyStateDirs = [
    join(abs, ".mission-executor", "state"),
    join(abs, ".omc", "state"),
  ];

  const legacy = legacyStateDirs.find((d) => {
    try { return existsSync(join(d, "mission-executor-state.json")); }
    catch { return false; }
  });
  if (!legacy) return { migrated: null, skipped: "no-legacy-state" };

  // Target already has state — leave both alone, warn.
  try {
    if (existsSync(join(targetStateDir, "mission-executor-state.json"))) {
      process.stderr.write(
        `mission-executor: legacy project state exists at ${legacy} but user-global ` +
        `state already populated at ${targetStateDir}; skipping migration. Delete ` +
        `the legacy dir manually if obsolete.\n`
      );
      return { migrated: null, skipped: "target-exists" };
    }
  } catch {}

  try {
    copyDirRecursive(legacy, targetStateDir);
    process.stderr.write(
      `mission-executor: migrated project state from ${legacy} to ${targetStateDir}\n`
    );
    return { migrated: targetStateDir, skipped: null };
  } catch (e) {
    process.stderr.write(`mission-executor: project-state migration failed: ${e.message}\n`);
    return { migrated: null, skipped: `copy-error:${e.message}` };
  }
}

function copyDirRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    const st = statSync(s);
    if (st.isDirectory()) copyDirRecursive(s, d);
    else if (st.isFile() && !existsSync(d)) copyFileSync(s, d);
  }
}

