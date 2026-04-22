// Evidence-pattern recognizers for the shell-generic dispatcher.
//
// 0.4.6's `dispatchShellGeneric` can only execute single-command evidence
// with a recognizable EXEC_PREFIX. Real mission contracts routinely carry
// five other shapes that the basic dispatcher treats as narrative-only:
//
//   1. Brace expansion:  `test ! -e cse-tools/deploy/{Dockerfile,entrypoint.sh,crontab}`
//   2. Compound-AND:     `grep X f1` AND `grep Y f2` (multi-backtick; `;` / `+` / `AND`)
//   3. List-as-anchor:   `install-packages.sh, install-agents.sh, install-systemd.sh`
//                        + prose "each under `deploy/packer/scripts/`" + "test -x"
//   4. Alternation grep: `cp -r|tar -xf|rsync`   + prose "no cp/tar/rsync into /home/cse"
//   5. Negation list:    `AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ...`
//                        + prose "contains no" / "absent"
//
// Each recognizer returns either null (no match) or an ExecutionPlan:
//   { kind, commands: string[], origSource: string }
// The caller runs each command and AND-reduces exit codes (all must exit 0).
//
// Recognizers are called in priority order; first match wins. The caller
// (execute-assertion.mjs `dispatchShellGeneric`) only consults these after
// the 0.4.6 basic extractor returns `blocked` — so currently-passing
// assertions are never re-routed through this code path.

// Tokens that plausibly start a runnable command. Keep synchronized with
// EXEC_PREFIX in execute-assertion.mjs (but as a loose match — recognizers
// are a fallback, not the authoritative allowlist).
const EXEC_PREFIX_RE = /^(sudo\s+)?(curl|aws|git|jq|grep|rg|find|trufflehog|dig|ssh|packer|terraform|node|bash|python3?|actionlint|yamllint|shellcheck|gh|wrangler|yq|npx|npm|cat|awk|sed|diff|pcregrep|xargs|ls|wc|tee|test|cd|for|while|if|echo|printf|file|md5sum|sha256sum|openssl|just|tar|zip|unzip|which|command|type|date|sort|uniq|head|tail|stat|chmod|chown|install|mkdir|touch|ln|cp|mv|rm|env|export)\b/;

function backtickBlocks(text) {
  if (!text) return [];
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

// ----------------------------------------------------------------------------
// Recognizer 1: brace expansion
//
// Matches a backticked command containing `{a,b,c}` (non-empty comma-list
// inside braces). Expands the brace group into N separate commands by
// substituting each comma-separated token for the brace expression.
// ----------------------------------------------------------------------------

export function recognizeBraceExpansion(evidence, body) {
  for (const block of [...backtickBlocks(evidence), ...backtickBlocks(body)]) {
    const trimmed = block.trim();
    if (!EXEC_PREFIX_RE.test(trimmed)) continue;
    const braceMatch = trimmed.match(/^(.*?)\{([^{}]+,[^{}]*)\}(.*)$/);
    if (!braceMatch) continue;
    const [, prefix, inside, suffix] = braceMatch;
    const tokens = inside.split(",").map((t) => t.trim()).filter(Boolean);
    if (tokens.length < 2) continue;
    const commands = tokens.map((t) => `${prefix}${t}${suffix}`);
    return { kind: "brace-expansion", commands, origSource: trimmed };
  }
  return null;
}

// ----------------------------------------------------------------------------
// Recognizer 2: compound-AND
//
// Evidence with two or more backticked runnable commands separated by
// `;`, `+`, `AND`, or `and`. Each command runs; all must exit 0.
// Skips cases where a single block has brace expansion (already handled).
// ----------------------------------------------------------------------------

export function recognizeCompoundAnd(evidence, body) {
  for (const source of [evidence, body]) {
    if (!source) continue;
    // Collect backticked tokens that look like runnable commands.
    const blocks = [...source.matchAll(/`([^`]+)`/g)];
    if (blocks.length < 2) continue;
    const runnable = blocks
      .map((m) => ({ raw: m[1].trim(), start: m.index, end: m.index + m[0].length }))
      .filter((b) => EXEC_PREFIX_RE.test(b.raw) && !/\.{3}/.test(b.raw));
    if (runnable.length < 2) continue;
    // Check that each pair of adjacent runnable commands is separated by an
    // AND-joiner (`;`, `+`, `AND`, `and`, or newline-with-"+"/"AND"). This
    // avoids false positives where unrelated commands happen to appear in
    // the same paragraph (e.g. usage examples).
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
    return {
      kind: "compound-and",
      commands,
      origSource: commands.join(" && "),
    };
  }
  return null;
}

// ----------------------------------------------------------------------------
// Recognizer 3: list-as-anchor
//
// A backticked span containing TWO OR MORE comma-separated filenames
// (tokens with a recognizable extension), paired with surrounding prose
// that specifies a `test -x` / `test -e` / executable-bit check and a path
// prefix. Emits `test -x <prefix><file>` for each file.
//
// Path prefix extraction priority:
//   1. Backticked path hint nearby (e.g. `` `deploy/packer/scripts/` ``)
//   2. `under PATH` / `in PATH` / `at PATH` prose hint (path must end in `/`)
// ----------------------------------------------------------------------------

export function recognizeListAnchor(evidence, body) {
  const searchText = (body || "") + "\n" + (evidence || "");
  for (const block of [...backtickBlocks(evidence), ...backtickBlocks(body)]) {
    const trimmed = block.trim();
    if (EXEC_PREFIX_RE.test(trimmed)) continue;
    const parts = trimmed.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    // Every part must look like a filename: <word>+<extension>, no spaces,
    // no shell metacharacters. This prevents matching arbitrary lists.
    const fileLike = /^[A-Za-z_][\w.-]*\.[A-Za-z0-9]{1,6}$/;
    if (!parts.every((p) => fileLike.test(p))) continue;

    // Prose must signal an exec / existence / mode check.
    const check = /\btest\s+-x\b/.test(searchText) ? "test -x"
      : /\bexecutable\b/i.test(searchText) ? "test -x"
      : /\bmode\s+0?755\b/i.test(searchText) ? "test -x"
      : /\btest\s+-e\b/.test(searchText) ? "test -e"
      : /\bexists?\b/i.test(searchText) ? "test -e"
      : null;
    if (!check) continue;

    // Path prefix: prefer backticked path ending with `/`, then prose hint.
    let prefix = "";
    for (const other of [...backtickBlocks(evidence), ...backtickBlocks(body)]) {
      const ot = other.trim();
      if (ot === trimmed) continue;
      if (/^[\w./-]+\/$/.test(ot)) { prefix = ot; break; }
    }
    if (!prefix) {
      const proseHint = searchText.match(/\b(?:under|in|at)\s+`([^`]+\/)`/)
        || searchText.match(/\b(?:under|in|at)\s+([\w./-]+\/)/);
      if (proseHint) prefix = proseHint[1];
    }
    if (!prefix) continue;

    const commands = parts.map((f) => `${check} ${prefix}${f}`);
    return { kind: "list-anchor", commands, origSource: `${check} ${prefix}{${parts.join(",")}}` };
  }
  return null;
}

// ----------------------------------------------------------------------------
// Recognizer 4: alternation-as-grep
//
// A backticked `a|b|c` alternation (each token is a word, optionally with
// flags) + prose that frames zero-occurrence semantics ("no X", "absent",
// "must not contain", "zero occurrences"). Converts to
// `! grep -qE 'a|b|c' <path>` against a path hint (backticked or prose).
// ----------------------------------------------------------------------------

export function recognizeAlternation(evidence, body) {
  const searchText = (body || "") + "\n" + (evidence || "");
  if (!/\b(no|absent|must\s+not|without|zero\s+occurrences?|does\s+not\s+contain|contains?\s+no)\b/i.test(searchText)) {
    return null;
  }
  for (const block of [...backtickBlocks(evidence), ...backtickBlocks(body)]) {
    const trimmed = block.trim();
    // Must contain `|`, must be all-wordish (no spaces inside tokens, or
    // only short flag sequences). Reject regex-style special chars.
    if (!trimmed.includes("|")) continue;
    const parts = trimmed.split("|").map((s) => s.trim());
    if (parts.length < 2) continue;
    if (!parts.every((p) => /^[\w./-]+(\s+-\w+)?$/.test(p))) continue;
    // Reject if this is clearly a runnable command (handled by basic path).
    if (EXEC_PREFIX_RE.test(trimmed)) continue;

    const path = extractPathHint(evidence, body);
    if (!path) continue;
    const escaped = trimmed.replace(/'/g, "'\\''");
    const commands = [`! grep -qE '${escaped}' ${path}`];
    return { kind: "alternation-grep", commands, origSource: trimmed };
  }
  return null;
}

// ----------------------------------------------------------------------------
// Recognizer 5: negation list
//
// A backticked comma-separated list of identifier-like tokens (secrets,
// env var names, banned keywords) + prose "contains no" / "absent".
// Joins with `|` and greps negatively against a path hint.
// ----------------------------------------------------------------------------

export function recognizeNegationList(evidence, body) {
  const searchText = (body || "") + "\n" + (evidence || "");
  if (!/\b(contains?\s+no|absent|no\s+(AWS_|API_|SECRET_|TOKEN_)|must\s+not\s+contain|zero\s+occurrences?)\b/i.test(searchText)) {
    return null;
  }
  for (const block of [...backtickBlocks(evidence), ...backtickBlocks(body)]) {
    const trimmed = block.trim();
    const parts = trimmed.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    // Each part must look like an identifier (alphanumeric + _ - .), no
    // shell metacharacters, no spaces.
    if (!parts.every((p) => /^[\w.-]{2,}$/.test(p))) continue;
    // Avoid colliding with list-anchor (filenames-with-extensions). If
    // every token has a filename-like `.<ext>` tail, let list-anchor
    // handle it — negation-list is for identifiers, not filenames.
    if (parts.every((p) => /\.[A-Za-z0-9]{1,6}$/.test(p))) continue;

    const path = extractPathHint(evidence, body);
    if (!path) continue;
    const alternation = parts.map((p) => p.replace(/[.-]/g, "[._-]")).join("|");
    const commands = [`! grep -qE '${alternation}' ${path}`];
    return { kind: "negation-list", commands, origSource: trimmed };
  }
  return null;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function extractPathHint(evidence, body) {
  // Prefer a backticked path that looks like a file/dir (has a `/` or a
  // trailing extension), excluding obvious command tokens.
  for (const block of [...backtickBlocks(evidence), ...backtickBlocks(body)]) {
    const t = block.trim();
    if (EXEC_PREFIX_RE.test(t)) continue;
    if (/^[\w./-]+\/[\w.-]*$/.test(t) || /^[\w./-]+\.[A-Za-z0-9]{1,6}$/.test(t)) {
      return t;
    }
  }
  // Fall back to prose: "in /home/cse", "under deploy/", "at cse-tools/".
  const searchText = (body || "") + "\n" + (evidence || "");
  const prose = searchText.match(/\b(?:in|under|at|against)\s+`([^`]+)`/)
    || searchText.match(/\b(?:in|under|at|against)\s+([\w./-]+\/[\w./-]*)/)
    || searchText.match(/\btouchpoint\s*[:=]\s*`?([\w./-]+)`?/i);
  return prose ? prose[1] : null;
}

export function recognizeEvidencePlan(evidence, body) {
  // Priority order: compound-AND > brace > list-anchor > alternation > negation.
  // Rationale: compound-AND is a structural signal (multiple runnable
  // commands) and if present, any single-block recognizer would miss the
  // ANDing semantics. Brace expansion next — it's unambiguous (curly
  // syntax). list-anchor before the two grep-negation recognizers because
  // it requires stronger signals (filename pattern + exec check).
  const order = [
    recognizeCompoundAnd,
    recognizeBraceExpansion,
    recognizeListAnchor,
    recognizeAlternation,
    recognizeNegationList,
  ];
  for (const rec of order) {
    const plan = rec(evidence || "", body || "");
    if (plan) return plan;
  }
  return null;
}
