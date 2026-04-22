// Meta-repo awareness helper.
//
// In a workspace like `mek/` where children (cse-tools/, agent-onboard/, ...)
// are gitignored siblings with their OWN `.git/` directories, a proof tagged
// with the child repo's HEAD SHA will never be an ancestor of the mek-root
// HEAD — they live in different histories. 0.4.6's critic flagged all such
// proofs as stale-commit, forcing operators to re-execute assertions after
// every mek-root commit.
//
// This helper consults the workspace-root `.meta` file (canonical format:
// {"projects": {"cse-tools": "...", "agent-onboard": "..."}}) and, when a
// touchpoint's first path segment matches a declared child AND that child
// has a `.git/` of its own, returns the child's absolute path + canonical
// name. Callers use that to pick the right repo for `git rev-parse HEAD`
// and `git merge-base --is-ancestor`.
//
// Design notes:
//   - Exact segment match on touchpoint.split("/")[0] against the .meta
//     keys. Prefix collisions (e.g. cse-tools vs cse-tools-internal) are
//     impossible by construction.
//   - Any missing prerequisite (no .meta, unparseable JSON, no .git/ in the
//     child) returns null — caller must fall back to workspace-root HEAD.
//   - Only the workspace-root .meta is consulted. Nested .meta files (a
//     .meta inside a child) are intentionally out of scope for 0.4.7.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveChildRepo(touchpoint, workingDir) {
  if (!touchpoint || typeof touchpoint !== "string") return null;
  if (!workingDir) return null;

  // Strip the "tree:" prefix that execute-assertion.mjs attaches to
  // command-inferred touchpoints; accept both forms transparently.
  const cleaned = touchpoint.replace(/^tree:/, "").replace(/^assertion:[^:]*:.*/, "");
  if (!cleaned) return null;

  const metaPath = join(workingDir, ".meta");
  if (!existsSync(metaPath)) return null;

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
  const projects = meta && typeof meta === "object" ? meta.projects : null;
  if (!projects || typeof projects !== "object") return null;

  const first = cleaned.split("/")[0];
  if (!first || !Object.prototype.hasOwnProperty.call(projects, first)) return null;

  const childDir = resolve(workingDir, first);
  if (!existsSync(join(childDir, ".git"))) return null;

  return { name: first, path: childDir };
}
