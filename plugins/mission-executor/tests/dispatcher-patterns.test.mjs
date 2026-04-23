// Unit tests for scripts/_lib/evidence-recognizers.mjs (0.7.0).
//
// Each recognizer gets positive cases (should match, with expected command
// shape) and negative cases (should not match). The priority-order dispatcher
// gets a dedicated block that verifies inter-recognizer disjointness.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recognizeCompoundAnd,
  recognizeBraceExpansion,
  recognizeListAnchor,
  recognizeAlternation,
  recognizeNegationList,
  recognizeAssertionLiteral,
  recognizeEvidencePlan,
} from "../scripts/_lib/evidence-recognizers.mjs";

// ---------------------------------------------------------------------------
// recognizeCompoundAnd
// ---------------------------------------------------------------------------

test("compound-and: two backticked commands joined by 'AND' match", () => {
  const ev = "`grep -q foo f1` AND `grep -q bar f2`";
  const plan = recognizeCompoundAnd(ev, "");
  assert.equal(plan?.kind, "compound-and");
  assert.deepEqual(plan?.commands, ["grep -q foo f1", "grep -q bar f2"]);
});

test("compound-and: three commands joined by '+' match", () => {
  const ev = "`test -e a` + `test -e b` + `test -e c`";
  const plan = recognizeCompoundAnd(ev, "");
  assert.equal(plan?.kind, "compound-and");
  assert.equal(plan?.commands.length, 3);
});

test("compound-and: commands joined by ';' match", () => {
  const ev = "`grep -q X f1`; `grep -q Y f2`";
  const plan = recognizeCompoundAnd(ev, "");
  assert.equal(plan?.kind, "compound-and");
});

test("compound-and: single command returns null", () => {
  const plan = recognizeCompoundAnd("`grep -q foo file`", "");
  assert.equal(plan, null);
});

test("compound-and: two commands with unrelated prose between do NOT match", () => {
  // Two backticked runnable commands in the same paragraph but NOT joined
  // by an AND-signal. Should fall through to the basic dispatcher.
  const ev = "Run `grep -q foo file1` to check foo. Usage example: `grep -q bar file2`.";
  const plan = recognizeCompoundAnd(ev, "");
  assert.equal(plan, null);
});

test("compound-and: placeholder-containing blocks are rejected", () => {
  const ev = "`grep -q ... file1` AND `grep -q bar file2`";
  const plan = recognizeCompoundAnd(ev, "");
  assert.equal(plan, null, "ellipsis in first block -> no match");
});

// ---------------------------------------------------------------------------
// recognizeBraceExpansion
// ---------------------------------------------------------------------------

test("brace: test ! -e with brace group expands to N commands", () => {
  const ev = "`test ! -e deploy/{Dockerfile,entrypoint.sh,crontab}`";
  const plan = recognizeBraceExpansion(ev, "");
  assert.equal(plan?.kind, "brace-expansion");
  assert.deepEqual(plan?.commands, [
    "test ! -e deploy/Dockerfile",
    "test ! -e deploy/entrypoint.sh",
    "test ! -e deploy/crontab",
  ]);
});

test("brace: grep with multi-token brace expands correctly", () => {
  const ev = "`grep -q FOO src/{a.ts,b.ts}`";
  const plan = recognizeBraceExpansion(ev, "");
  assert.equal(plan?.commands.length, 2);
  assert.ok(plan.commands.every((c) => c.startsWith("grep -q FOO src/")));
});

test("brace: single-item brace (no comma) does NOT match", () => {
  const plan = recognizeBraceExpansion("`test -e foo/{only}`", "");
  assert.equal(plan, null);
});

test("brace: command with no braces falls through", () => {
  const plan = recognizeBraceExpansion("`grep -q foo file`", "");
  assert.equal(plan, null);
});

test("brace: nested/multiple brace groups fall through (conservative)", () => {
  const plan = recognizeBraceExpansion("`test -e {a,b}/{c,d}`", "");
  assert.equal(plan, null, "multiple brace groups should not match");
});

// ---------------------------------------------------------------------------
// recognizeListAnchor
// ---------------------------------------------------------------------------

test("list-anchor: filenames + 'test -x' + backticked path prefix match", () => {
  const ev = "`install.sh, bootstrap.sh, entrypoint.sh` must be `test -x`-able under `deploy/scripts/`";
  const plan = recognizeListAnchor(ev, "");
  assert.equal(plan?.kind, "list-anchor");
  assert.deepEqual(plan?.commands, [
    "test -x deploy/scripts/install.sh",
    "test -x deploy/scripts/bootstrap.sh",
    "test -x deploy/scripts/entrypoint.sh",
  ]);
});

test("list-anchor: filenames + 'executable' prose + prose path hint match", () => {
  const ev = "`a.sh, b.sh` must be executable under deploy/bin/";
  const plan = recognizeListAnchor(ev, "");
  assert.equal(plan?.kind, "list-anchor");
  assert.equal(plan?.commands[0], "test -x deploy/bin/a.sh");
});

test("list-anchor: filenames without any path prefix do NOT match", () => {
  const ev = "`a.sh, b.sh, c.sh` must each be executable";
  // No "under X/" or backticked path; cwd-ambiguous.
  const plan = recognizeListAnchor(ev, "");
  assert.equal(plan, null);
});

test("list-anchor: non-filenames (identifiers) do NOT match", () => {
  const ev = "`FOO, BAR, BAZ` under `src/`";
  const plan = recognizeListAnchor(ev, "");
  assert.equal(plan, null, "bare identifiers are not filenames");
});

test("list-anchor: single filename does NOT match (needs at least 2)", () => {
  const plan = recognizeListAnchor("`a.sh` under `deploy/`", "");
  assert.equal(plan, null);
});

// ---------------------------------------------------------------------------
// recognizeAlternation (flaw #2 fix: split on `|` first)
// ---------------------------------------------------------------------------

test("alternation: `cp -r|tar -xf|rsync` + 'no' prose + path matches (flaw #2 repro)", () => {
  // This is the exact VAL-PACKER-019 shape that killed the 0.5.x draft.
  const ev = "no `cp -r|tar -xf|rsync` into `deploy/Dockerfile`";
  const plan = recognizeAlternation(ev, "");
  assert.equal(plan?.kind, "alternation-grep");
  assert.equal(plan?.commands.length, 1);
  assert.match(plan.commands[0], /^! grep -qE '/);
  assert.ok(plan.commands[0].includes("cp -r|tar -xf|rsync"));
  assert.ok(plan.commands[0].includes("deploy/Dockerfile"));
});

test("alternation: 'must not' + `|` pattern matches", () => {
  const ev = "Must not contain `foo|bar|baz` in `src/main.ts`";
  const plan = recognizeAlternation(ev, "");
  assert.equal(plan?.kind, "alternation-grep");
});

test("alternation: no negation prose -> no match", () => {
  const ev = "`cp -r|tar -xf|rsync` in `deploy/Dockerfile`";
  const plan = recognizeAlternation(ev, "");
  assert.equal(plan, null);
});

test("alternation: no path hint -> no match", () => {
  const ev = "no `cp -r|tar -xf|rsync` anywhere";
  const plan = recognizeAlternation(ev, "");
  assert.equal(plan, null);
});

test("alternation: single piece (no pipe) -> no match", () => {
  const ev = "no `cp -r` in `deploy/`";
  const plan = recognizeAlternation(ev, "");
  assert.equal(plan, null);
});

// ---------------------------------------------------------------------------
// recognizeNegationList
// ---------------------------------------------------------------------------

test("negation-list: env var names + 'contains no' + path matches", () => {
  const ev = "`AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN` contains no in `.github/workflows/bake.yml`";
  const plan = recognizeNegationList(ev, "");
  assert.equal(plan?.kind, "negation-list");
  assert.equal(plan?.commands.length, 1);
  assert.ok(plan.commands[0].startsWith("! grep -qE '"));
  assert.ok(plan.commands[0].includes("AWS_ACCESS_KEY_ID"));
});

test("negation-list: dots in identifiers are regex-escaped (dashes left literal)", () => {
  // Dashes have no regex meta-meaning at the top level of a grep -qE pattern,
  // so we don't escape them. Dots do (. matches any char), so they're escaped.
  const ev = "`aws-access-key-id, aws.secret.key` must not contain in `config.yml`";
  const plan = recognizeNegationList(ev, "");
  assert.equal(plan?.kind, "negation-list");
  assert.ok(plan.commands[0].includes("aws-access-key-id"), "dashes stay literal");
  assert.ok(plan.commands[0].includes("aws\\.secret\\.key"), "dots are escaped");
});

test("negation-list: filename-list evidence defers to list-anchor (disjoint)", () => {
  // If every token has a filename extension AND there's negation prose, the
  // negation-list recognizer should NOT match — list-anchor handles it.
  const ev = "`a.sh, b.sh` contains no in `deploy/`";
  const plan = recognizeNegationList(ev, "");
  assert.equal(plan, null, "filename extensions signal list-anchor territory");
});

test("negation-list: no negation prose -> no match", () => {
  const ev = "`AWS_ACCESS_KEY_ID, GITHUB_TOKEN` in `.github/workflows/bake.yml`";
  const plan = recognizeNegationList(ev, "");
  assert.equal(plan, null);
});

// ---------------------------------------------------------------------------
// recognizeAssertionLiteral (v0.8.1 — recognizer #6)
// ---------------------------------------------------------------------------

test("assertion-literal: 'confirm `literal` is printed in `path.ts`' matches", () => {
  const ev = "confirm that `onboarding_step_completed` is printed in `src/events.ts`";
  const plan = recognizeAssertionLiteral(ev, "");
  assert.equal(plan?.kind, "assertion-literal");
  assert.equal(plan?.commands.length, 1);
  assert.match(plan.commands[0], /^grep -Fq -- 'onboarding_step_completed' src\/events\.ts$/);
});

test("assertion-literal: 'output contains `LITERAL` in `file.md`' matches", () => {
  const ev = "output contains `CF_API_TOKEN_MISSING` in `src/errors.md`";
  const plan = recognizeAssertionLiteral(ev, "");
  assert.equal(plan?.kind, "assertion-literal");
  assert.match(plan.commands[0], /^grep -Fq -- 'CF_API_TOKEN_MISSING' src\/errors\.md$/);
});

test("assertion-literal: '`path` includes `literal`' matches", () => {
  const ev = "`.github/workflows/ci.yml` includes `runs-on: ubuntu-22.04`";
  const plan = recognizeAssertionLiteral(ev, "");
  assert.equal(plan?.kind, "assertion-literal");
  assert.match(plan.commands[0], /grep -Fq -- 'runs-on: ubuntu-22\.04' \.github\/workflows\/ci\.yml$/);
});

test("assertion-literal: runnable command present -> defer (return null)", () => {
  // If a backtick block looks runnable, recognizers 1-5 or the basic
  // tryExtract take priority. assertion-literal must not fire.
  const ev = "confirm that `grep -q foo src/x.ts` exits 0";
  const plan = recognizeAssertionLiteral(ev, "");
  assert.equal(plan, null);
});

test("assertion-literal: negation prose -> null (avoid false positive)", () => {
  // "absent from" / "must not contain" -> negative. Positive grep would
  // falsely pass when the literal IS present.
  const ev = "confirm that `PROD_SECRET` is absent from `src/config.ts`";
  const plan = recognizeAssertionLiteral(ev, "");
  assert.equal(plan, null);
});

test("assertion-literal: no positive-presence verb -> null", () => {
  // No "contains/includes/prints/emits/..." signal.
  const ev = "the `LITERAL` exists alongside `src/x.ts`";
  const plan = recognizeAssertionLiteral(ev, "");
  assert.equal(plan, null);
});

test("assertion-literal: missing path hint -> null", () => {
  const ev = "confirm that `onboarding_step_completed` is printed";
  const plan = recognizeAssertionLiteral(ev, "");
  assert.equal(plan, null);
});

test("assertion-literal: missing literal (only path) -> null", () => {
  // Single backtick block that is a path; nothing to search for.
  const ev = "includes `src/events.ts`";
  const plan = recognizeAssertionLiteral(ev, "");
  assert.equal(plan, null);
});

test("assertion-literal: single-char/digit literal rejected", () => {
  // A single-char / pure-digit literal would match too broadly.
  const ev = "confirm that `1` is printed in `src/x.ts`";
  assert.equal(recognizeAssertionLiteral(ev, ""), null);
  const ev2 = "confirm that `a` is printed in `src/x.ts`";
  assert.equal(recognizeAssertionLiteral(ev2, ""), null);
});

test("assertion-literal: prose-only path hint 'in foo/bar.ts' works", () => {
  const ev = "includes `EMITTED_EVENT` in src/events.ts";
  const plan = recognizeAssertionLiteral(ev, "");
  assert.equal(plan?.kind, "assertion-literal");
  assert.match(plan.commands[0], /src\/events\.ts$/);
});

// ---------------------------------------------------------------------------
// recognizeEvidencePlan priority dispatcher
// ---------------------------------------------------------------------------

test("priority: compound-AND wins over alternation when both structural signals exist", () => {
  // Two runnable commands joined by AND, one containing a `|` inside a quoted
  // arg. compound-and has priority.
  const ev = "`grep -qE 'a|b' f1` AND `grep -qE 'c|d' f2` — must match no lines";
  const plan = recognizeEvidencePlan(ev, "");
  assert.equal(plan?.kind, "compound-and");
});

test("priority: brace wins before list-anchor on braced path", () => {
  // Brace expansion matches first; list-anchor wouldn't parse this anyway
  // because the contents aren't bare filenames.
  const ev = "`test ! -e {a,b,c}` under deploy/";
  const plan = recognizeEvidencePlan(ev, "");
  assert.equal(plan?.kind, "brace-expansion");
});

test("priority: plain single-command evidence returns null (falls through to tryExtract)", () => {
  const ev = "`grep -q foo file.txt`";
  const plan = recognizeEvidencePlan(ev, "");
  assert.equal(plan, null, "single-command evidence is tryExtract's territory");
});

test("priority: structural recognizers beat assertion-literal for overlapping evidence", () => {
  // Compound-AND evidence that ALSO has positive-presence prose. compound-and
  // must win since it runs before assertion-literal in the dispatcher.
  const ev = "`grep -q foo f1` AND `grep -q bar f2` — confirm both are printed";
  const plan = recognizeEvidencePlan(ev, "");
  assert.equal(plan?.kind, "compound-and");
});

test("priority: assertion-literal rescues narrative evidence that was previously blocked", () => {
  const ev = "confirm that `mission_completed` is printed in `src/events.ts`";
  const plan = recognizeEvidencePlan(ev, "");
  assert.equal(plan?.kind, "assertion-literal");
});

test("priority: narrative prose with no structural signals returns null", () => {
  const ev = "The assertion checks that the deployment is idempotent.";
  const plan = recognizeEvidencePlan(ev, "");
  assert.equal(plan, null);
});

test("priority: empty/null inputs return null cleanly", () => {
  assert.equal(recognizeEvidencePlan("", ""), null);
  assert.equal(recognizeEvidencePlan(null, null), null);
  assert.equal(recognizeEvidencePlan(undefined, undefined), null);
});
