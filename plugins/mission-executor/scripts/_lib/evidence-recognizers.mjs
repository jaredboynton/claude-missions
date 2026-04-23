// Evidence-pattern recognizers for dispatchShellGeneric (0.7.0).
//
// 0.4.6's basic dispatcher extracts a single backticked command from the
// evidence and runs it. That misses five real-world evidence shapes:
//
//   1. Compound-AND:   two+ backticked commands joined by `;`, `+`, `AND`
//   2. Brace expansion: `test ! -e foo/{a,b,c}` (bash brace-group syntax)
//   3. List-as-anchor: `a.sh, b.sh, c.sh` + prose "each under `path/`" + "test -x"
//   4. Alternation:    `cp -r|tar -xf|rsync` + prose "no cp/tar/rsync ..."
//   5. Negation list:  `AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY` + "contains no"
//
// Each recognizer is a pure function (evidence, body) -> ExecutionPlan | null.
// The priority dispatcher `recognizeEvidencePlan` tries them in a fixed order
// and returns the first match, so more-specific recognizers fire first.
//
// Callers (execute-assertion.mjs > dispatchShellGeneric) invoke this module
// BEFORE the basic `tryExtract` path. This addresses flaw #1 from the killed
// 0.5.x draft ("fall-through ordering is wrong" — recognizers must run first,
// not last).
//
// Conservative-matching discipline: when evidence is ambiguous (no clear
// structural markers), recognizers return `null` and the caller falls through
// to basic single-command extraction. This preserves 0.6.0 behavior for every
// evidence shape the old dispatcher already handled.
//
// Stage B safety: recognizers are NOT invoked when CRITIC_SPOT_CHECK=1 is set
// (gating lives in the caller, not here). The critic verifies existing passes
// using the same basic logic that produced them, so new recognizers cannot
// introduce Stage B verdict divergences on manually-recorded assertions.

// Known runnable executables. Shared with execute-assertion.mjs's EXEC_PREFIX
// regex; kept as a loose allow-list here since recognizers are structure-
// driven and the caller re-validates before dispatch.
const EXEC_PREFIX_RE = /^(sudo\s+)?(curl|aws|git|jq|grep|rg|find|trufflehog|dig|ssh|packer|terraform|node|bash|python3?|actionlint|yamllint|shellcheck|gh|wrangler|yq|npx|npm|cat|awk|sed|diff|pcregrep|xargs|ls|wc|tee|test|cd|for|while|if|echo|printf|file|md5sum|sha256sum|openssl|just|tar|zip|unzip|which|command|type|date|sort|uniq|head|tail|stat|chmod|chown|install|mkdir|touch|ln|cp|mv|rm|env|export)\b/;

// Tokens that explicitly mark a backticked block as non-runnable.
const NOT_RUNNABLE = /^(TODO|FIXME|ERROR|WARN|INFO|note|see|cf|e\.g|i\.e)\b/i;

function backtickBlocks(text) {
  if (!text) return [];
  return [...text.matchAll(/`([^`]+)`/g)];
}

function hasPlaceholder(cmd) {
  // Same placeholder rejections as execute-assertion.mjs's hasUnsubstitutedPlaceholder.
  if (/\.{3}/.test(cmd)) return true;             // `...` ellipsis
  if (/=\s*$/.test(cmd)) return true;             // trailing `=` with no value
  if (/<[a-z_-]+>/i.test(cmd) && !/(<working-dir>|<mission>|<path>)/i.test(cmd)) return true;
  if (/\\\s*$/.test(cmd) || />\s*$/.test(cmd)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Recognizer 1: compound-AND
//
// Two or more backticked commands, each independently runnable, joined by
// `;`, `+`, `AND`, or `and`. Emits all commands; executePlan AND-reduces.
//
// Example evidence:
//   `grep -q '^foo' file1` AND `grep -q '^bar' file2` AND `test -e file3`
// ---------------------------------------------------------------------------

export function recognizeCompoundAnd(evidence, body) {
  for (const source of [evidence, body]) {
    if (!source) continue;
    const blocks = backtickBlocks(source);
    if (blocks.length < 2) continue;

    const runnable = blocks
      .map((m) => ({ raw: m[1].trim(), start: m.index, end: m.index + m[0].length }))
      .filter((b) => EXEC_PREFIX_RE.test(b.raw) && !NOT_RUNNABLE.test(b.raw) && !hasPlaceholder(b.raw));

    if (runnable.length < 2) continue;

    // Each adjacent pair must have an AND-joiner between them (not arbitrary
    // prose). This prevents false matches where two unrelated commands
    // happen to co-occur in the same paragraph as usage examples.
    let joined = true;
    for (let i = 1; i < runnable.length; i++) {
      const between = source.slice(runnable[i - 1].end, runnable[i].start);
      if (!/(\s*[;+]\s*|\s+(and|AND)\s+|[;+]\s*\n)/.test(between)) {
        joined = false;
        break;
      }
    }
    if (!joined) continue;

    const commands = runnable.map((b) => b.raw);
    return { kind: "compound-and", commands, origSource: commands.join(" && ") };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recognizer 2: brace expansion
//
// Single backticked command with a `{a,b,c}` brace group. Expands the group
// into N commands by substituting each comma-separated token. AND-reduce.
//
// Example evidence:
//   `test ! -e cse-tools/deploy/{Dockerfile,entrypoint.sh,crontab}`
//
// Only expands a SINGLE brace group. Nested / multiple brace groups fall
// through (conservative — the shell would handle it, but our executor
// runs each emitted string as a standalone command).
// ---------------------------------------------------------------------------

export function recognizeBraceExpansion(evidence, body) {
  for (const source of [evidence, body]) {
    if (!source) continue;
    for (const m of backtickBlocks(source)) {
      const trimmed = m[1].trim();
      if (!EXEC_PREFIX_RE.test(trimmed) || hasPlaceholder(trimmed)) continue;
      // Exactly one brace group with at least one comma (multi-item).
      const braceMatch = trimmed.match(/^(.*?)\{([^{}]+,[^{}]*)\}(.*)$/);
      if (!braceMatch) continue;
      // Reject if there's a SECOND brace group anywhere in the suffix.
      if (/\{[^{}]+,[^{}]*\}/.test(braceMatch[3])) continue;

      const [, prefix, inside, suffix] = braceMatch;
      const tokens = inside.split(",").map((t) => t.trim()).filter(Boolean);
      if (tokens.length < 2) continue;

      const commands = tokens.map((t) => `${prefix}${t}${suffix}`);
      return { kind: "brace-expansion", commands, origSource: trimmed };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recognizer 3: list-as-anchor
//
// Backticked span containing two or more comma-separated filenames + prose
// signaling an existence/executable check + a path prefix hint (either
// backticked with trailing slash, or prose "under PATH/" / "in PATH/").
//
// Example evidence:
//   `install-packages.sh, install-agents.sh, install-systemd.sh`
//   Each should be executable under `deploy/packer/scripts/` (test -x).
//
// Emits: [test -x deploy/packer/scripts/install-packages.sh, ...]. AND-reduce.
//
// Strict anchors: path prefix is MANDATORY (avoids cwd-ambiguous emissions).
// ---------------------------------------------------------------------------

const FILENAME_RE = /^[A-Za-z_][\w.-]*\.[A-Za-z0-9]{1,6}$/;

function extractPathHint(evidence, body) {
  // Priority:
  //   1. Backticked path ending with `/` (clearly a directory prefix)
  //   2. Backticked path with `/` and a filename-ish tail (treated as dir)
  //   3. Prose "under | in | at PATH/" (backticked)
  //   4. Prose "under | in | at PATH/" (bare, path must end in /)
  for (const source of [evidence, body]) {
    if (!source) continue;
    for (const m of backtickBlocks(source)) {
      const t = m[1].trim();
      if (EXEC_PREFIX_RE.test(t)) continue;
      if (t.endsWith("/") && /^[\w./-]+\/$/.test(t)) return t;
    }
  }
  const all = (body || "") + "\n" + (evidence || "");
  const prose = all.match(/\b(?:under|in|at)\s+`([^`]+\/)`/)
    || all.match(/\b(?:under|in|at)\s+([\w./-]+\/)/);
  return prose ? prose[1] : null;
}

export function recognizeListAnchor(evidence, body) {
  const searchText = (body || "") + "\n" + (evidence || "");
  // Prose must signal an exec / existence / mode check.
  const check = /\btest\s+-x\b/.test(searchText) ? "test -x"
    : /\bexecutable\b/i.test(searchText) ? "test -x"
    : /\bmode\s+0?755\b/i.test(searchText) ? "test -x"
    : /\btest\s+-e\b/.test(searchText) ? "test -e"
    : null;
  if (!check) return null;

  for (const source of [evidence, body]) {
    if (!source) continue;
    for (const m of backtickBlocks(source)) {
      const trimmed = m[1].trim();
      // Deliberately no EXEC_PREFIX_RE reject here: filenames like
      // `install.sh` would false-trip it (`install` is a real command).
      // The parts.every(FILENAME_RE) check below is the actual gate —
      // a real single command like `grep -q foo file` fails split-on-comma
      // + every-filename and is rejected cleanly.
      const parts = trimmed.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      if (!parts.every((p) => FILENAME_RE.test(p))) continue;

      const prefix = extractPathHint(evidence, body);
      if (!prefix) continue;

      const commands = parts.map((f) => `${check} ${prefix}${f}`);
      return {
        kind: "list-anchor",
        commands,
        origSource: `${check} ${prefix}{${parts.join(",")}}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recognizer 4: alternation-as-grep
//
// Backticked `a|b|c` pattern where each piece is independently a runnable
// token (word, short flag allowed) + prose negation signal + path hint.
// Converts to `! grep -qE 'a|b|c' <path>`.
//
// Example evidence:
//   `cp -r|tar -xf|rsync` must not appear anywhere under `deploy/`.
//
// Flaw #2 fix: the 0.5.x draft rejected any block matching EXEC_PREFIX_RE,
// which killed VAL-PACKER-019 (the concatenation "cp -r|tar -xf|rsync"
// starts with `cp`). We split on `|` FIRST, then check each piece
// individually. Concatenations that happen to begin with an exec token
// are now accepted as alternation patterns.
// ---------------------------------------------------------------------------

const ALT_PIECE_RE = /^[\w./-]+(\s+-{1,2}\w+)?$/;
const NEGATION_RE = /\b(no|absent|must\s+not|without|zero\s+occurrences?|does\s+not\s+contain|contains?\s+no)\b/i;

export function recognizeAlternation(evidence, body) {
  const searchText = (body || "") + "\n" + (evidence || "");
  if (!NEGATION_RE.test(searchText)) return null;

  for (const source of [evidence, body]) {
    if (!source) continue;
    for (const m of backtickBlocks(source)) {
      const trimmed = m[1].trim();
      if (!trimmed.includes("|")) continue;

      // Flaw #2 fix: split on `|` BEFORE doing any exec-prefix rejection.
      const pieces = trimmed.split("|").map((s) => s.trim());
      if (pieces.length < 2) continue;
      if (!pieces.every((p) => ALT_PIECE_RE.test(p))) continue;

      const path = extractGrepPathHint(evidence, body);
      if (!path) continue;

      const escaped = trimmed.replace(/'/g, "'\\''");
      const commands = [`! grep -qE '${escaped}' ${path}`];
      return { kind: "alternation-grep", commands, origSource: trimmed };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recognizer 5: negation list
//
// Backticked comma-separated identifiers (env var names, secret literals,
// banned keywords) + prose "contains no" / "absent" + path hint. Joins
// with `|` and greps negatively.
//
// Example evidence:
//   `AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, aws-access-key-id`
//   must be absent from `.github/workflows/bake-ami.yml`.
//
// Disjoint from list-anchor: only fires if EVERY piece looks like an
// identifier (not a filename with extension). Prevents collision.
// ---------------------------------------------------------------------------

const IDENTIFIER_RE = /^[\w.-]{2,}$/;
const IDENT_NEG_RE = /\b(contains?\s+no|absent|no\s+(AWS_|API_|SECRET_|TOKEN_)|must\s+not\s+contain|zero\s+occurrences?|does\s+not\s+contain)\b/i;

export function recognizeNegationList(evidence, body) {
  const searchText = (body || "") + "\n" + (evidence || "");
  if (!IDENT_NEG_RE.test(searchText)) return null;

  for (const source of [evidence, body]) {
    if (!source) continue;
    for (const m of backtickBlocks(source)) {
      const trimmed = m[1].trim();
      const parts = trimmed.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      if (!parts.every((p) => IDENTIFIER_RE.test(p))) continue;
      // Disjoint from list-anchor: if every piece has a filename extension,
      // defer to list-anchor (higher priority already tried).
      if (parts.every((p) => /\.[A-Za-z0-9]{1,6}$/.test(p))) continue;

      const path = extractGrepPathHint(evidence, body);
      if (!path) continue;

      // Escape regex metacharacters in each identifier; join with `|`.
      const alternation = parts
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      const commands = [`! grep -qE '${alternation}' ${path}`];
      return { kind: "negation-list", commands, origSource: trimmed };
    }
  }
  return null;
}

function extractGrepPathHint(evidence, body) {
  // Extraction priority for grep-target paths:
  //   1. Backticked path with `/` or `.<ext>` tail (not a command)
  //   2. Prose "in|under|at|against PATH" (backticked)
  //   3. Prose "in|under|at|against PATH" (bare filesystem path)
  for (const source of [evidence, body]) {
    if (!source) continue;
    for (const m of backtickBlocks(source)) {
      const t = m[1].trim();
      if (EXEC_PREFIX_RE.test(t)) continue;
      if (/^[\w./-]+\/[\w.-]*$/.test(t) || /^[\w./-]+\.[A-Za-z0-9]{1,6}$/.test(t)) {
        return t;
      }
    }
  }
  const all = (body || "") + "\n" + (evidence || "");
  const prose = all.match(/\b(?:in|under|at|against|from)\s+`([^`]+)`/)
    || all.match(/\b(?:in|under|at|against|from)\s+([\w./-]+\/[\w./-]*)/);
  return prose ? prose[1] : null;
}

// ---------------------------------------------------------------------------
// Priority dispatcher
//
// Order rationale:
//   1. compound-and — structural signal (multiple runnable commands) that
//      would be silently truncated by any single-block recognizer
//   2. brace — unambiguous curly-brace syntax; cheap to test
//   3. list-anchor — filename list + exec check is a strong specific signal
//   4. alternation-grep — fires only with negation prose + `|` syntax
//   5. negation-list — fallback identifier-list case; fires only with
//      negation prose AND identifier-shape tokens (disjoint from list-anchor)
// ---------------------------------------------------------------------------

const RECOGNIZERS = [
  recognizeCompoundAnd,
  recognizeBraceExpansion,
  recognizeListAnchor,
  recognizeAlternation,
  recognizeNegationList,
];

export function recognizeEvidencePlan(evidence, body) {
  for (const rec of RECOGNIZERS) {
    const plan = rec(evidence || "", body || "");
    if (plan) return plan;
  }
  return null;
}
