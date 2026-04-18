#!/usr/bin/env node
// Contract vs nested AGENTS.md contradiction lint. Runs at Phase 0.5 before
// any worker spawns.
//
// Why: bee21e7c's VAL-CLI-003 asserted `kep mission ask --require-gate` must
// invoke the orchestrator gate. But packages/kep/src/cli/cmd/AGENTS.md
// explicitly documents that ask/answer BYPASS the gate by design. The old
// plugin marked the assertion passed anyway. This script catches that class
// at phase 0.5 and hard-halts until the user reconciles.
//
// Signals (from AGENTS.md phrasing) that indicate intentional architectural
// choices which an assertion can contradict:
//   - "bypasses" / "bypass" the (gate|check|middleware|auth)
//   - "by design" / "deliberately" / "intentionally"
//   - "trusted" / "trust model" / "trusted orchestrator"
//   - "deprecated" / "removed" / "no longer"
//
// Usage:
//   node contract-lint.mjs <mission-path> [--strict]
// Exit:
//   0 = no contradictions (or all acknowledged)
//   1 = contradictions found
//   2 = env problem (missing working_directory.txt, no AGENTS.md anywhere)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const SUSPECT_PHRASES = [
  /\bbypass(es|ed|ing)?\b/i,
  /\bby design\b/i,
  /\bdeliberately\b/i,
  /\bintentionally\b/i,
  /\btrusted\b/i,
  /\btrust model\b/i,
  /\bdeprecated\b/i,
  /\bremoved\b/i,
  /\bno longer\b/i,
  /\bMUST NOT\b/,
  /\bNEVER\b/,
];

function walkAgentsMd(root) {
  const results = [];
  // Skip external-code mirrors and build artifacts. `.discovery/` holds
  // reference implementations (codex-cli, postman-app, amp-ref, etc.) that
  // the kep team studies but does not govern; their AGENTS.md rules don't
  // constrain kep's contract.
  const skip = new Set([
    "node_modules", ".git", "dist", "build", ".omc", ".factory",
    ".next", "coverage", ".discovery", "vendor", ".cache",
  ]);
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = join(cur, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (name === "AGENTS.md") results.push(p);
    }
  }
  return results;
}

function loadAssertions(missionPath) {
  const contractPath = join(missionPath, "validation-contract.md");
  if (!existsSync(contractPath)) return [];
  const text = readFileSync(contractPath, "utf8");
  const blocks = [];
  const re = /^###\s+(VAL-[A-Z]+-\d+[a-z]?):?\s*(.+)$/gm;
  let match;
  const indices = [];
  while ((match = re.exec(text))) indices.push({ id: match[1], title: match[2], start: match.index });
  for (let i = 0; i < indices.length; i++) {
    const { id, title, start } = indices[i];
    // Stop at the NEXT `### VAL-` heading, OR at any `## ` section
    // heading that appears first. Without the `## ` stop, a trailing
    // assertion in one section gobbled the next section's intro text
    // and picked up spurious keywords (e.g. VAL-RECOVERY-004 absorbing
    // the `## VAL-CLI` section's "bypass the gate" phrasing).
    const next = i + 1 < indices.length ? indices[i + 1].start : text.length;
    const h2 = text.slice(start + 1).search(/\n##\s+/);
    const end = h2 !== -1 && (start + 1 + h2) < next ? (start + 1 + h2) : next;
    blocks.push({ id, title, body: text.slice(start, end) });
  }
  return blocks;
}

// Generic English words too broad to match AGENTS.md against meaningfully.
// If the backtick-wrapped token is one of these, drop it.
const GENERIC_WORDS = new Set([
  "error", "errors", "code", "codes", "running", "run", "state", "status",
  "message", "failed", "check", "test", "pass", "passed", "fail", "block",
  "type", "value", "body", "name", "field", "fields", "content", "header",
  "request", "response", "data", "true", "false", "null", "undefined",
  "login", "logout", "open", "close", "active", "inactive", "string",
  "number", "object", "array", "path", "file", "line",
  // Tool-type tokens from the contract's own schema. These appear
  // structurally in every assertion and would match any AGENTS.md that
  // uses the same word in an unrelated context (e.g. "unit-test
  // environment sanitization" in packages/kep/AGENTS.md).
  "unit-test", "curl", "cli-binary", "tuistory", "literal-probe",
]);

function extractAssertionKeywords(assertion) {
  const body = assertion.body;
  const keywords = new Set();
  // Backtick-wrapped tokens. Accept a token if it is a path-like identifier
  // (contains /) OR compound (contains - or _ or .) OR long (> 8 chars).
  // Reject generic English words that would match too many AGENTS.md files.
  for (const m of body.matchAll(/`([^`]+)`/g)) {
    const inner = m[1];
    if (!/^[a-z][\w./-]+$/i.test(inner)) continue;
    if (GENERIC_WORDS.has(inner.toLowerCase())) continue;
    const hasStructure = /[_\-./]/.test(inner);
    if (!hasStructure && inner.length <= 8) continue;
    keywords.add(inner);
  }
  // Hint words that carry architectural meaning on their own.
  if (/\b403\b/.test(body)) keywords.add("403");
  if (/\bgate\b/i.test(body)) keywords.add("gate");
  if (/\brequire[- ]gate\b/i.test(body)) keywords.add("require-gate");
  return [...keywords];
}

function findContradictions(assertion, agentsMdPaths, workingDir) {
  const contradictions = [];
  const assertionKeywords = extractAssertionKeywords(assertion);
  if (assertionKeywords.length === 0) return contradictions;

  for (const agentsMd of agentsMdPaths) {
    const rel = relative(workingDir, agentsMd);
    let text;
    try { text = readFileSync(agentsMd, "utf8"); } catch { continue; }

    let signal = null;

    for (const keyword of assertionKeywords) {
      if (signal) break;
      let searchPos = 0;
      while (true) {
        const pos = text.indexOf(keyword, searchPos);
        if (pos === -1) break;

        // Narrow window (~sentence-sized) around the keyword occurrence.
        // The prior paragraph-level match fired on unrelated topics that
        // happened to share a paragraph with the keyword.
        const wStart = Math.max(0, pos - 150);
        const wEnd = Math.min(text.length, pos + keyword.length + 150);
        const window = text.slice(wStart, wEnd);

        for (const phrase of SUSPECT_PHRASES) {
          const m = window.match(phrase);
          if (!m) continue;

          // Cross-paragraph filter: if the keyword and the suspect
          // phrase are in DIFFERENT paragraphs (a `\n\n` sits between
          // them), they are likely describing different subjects. The
          // classic case is `server/routes/AGENTS.md` explaining HTTP
          // 403 enforcement in one paragraph and the CLI's in-process
          // bypass in the next -- two surfaces, one doc. A ±150 char
          // window catches both; the paragraph break tells us they
          // are thematically separate.
          const keywordWindowPos = window.indexOf(keyword);
          const phraseWindowPos = m.index;
          const lo = Math.min(keywordWindowPos, phraseWindowPos);
          const hi = Math.max(
            keywordWindowPos + keyword.length,
            phraseWindowPos + m[0].length,
          );
          const between = window.slice(lo, hi);
          if (/\n\s*\n/.test(between)) continue;

          // Alignment check: if the assertion body already mentions
          // ANY of the suspect-phrase roots (bypass, deliberately,
          // trusted, by design, in-process, ...), the assertion is
          // describing the same trust-model the AGENTS.md documents.
          // They are aligned, not contradicting.
          //
          // A real contradiction requires the assertion to demand
          // behavior the docs say doesn't exist, WITHOUT referencing
          // the documented design. The VAL-CLI-003 case (asserts
          // `--require-gate` causes non-zero exit) has no
          // bypass/deliberately/trusted mention in its body, and
          // correctly flags. VAL-CLI-001 (asserts --help contains
          // "bypasses" literal) has `bypass` in its body and correctly
          // aligns.
          const ALIGN_ROOTS = ["bypass", "deliberat", "trusted", "by design", "in-process", "trust model"];
          const aligned = ALIGN_ROOTS.some((r) => new RegExp(r, "i").test(assertion.body));
          if (aligned) continue;

          signal = {
            agentsMd: rel,
            keyword,
            phrase: m[0],
            excerpt: window.trim().slice(0, 280),
          };
          break;
        }
        if (signal) break;
        searchPos = pos + keyword.length;
      }
    }

    if (signal) contradictions.push(signal);
  }
  return contradictions;
}

function checkAcknowledgement(assertion, agentsMdPaths, workingDir) {
  // Acknowledgement syntax in the assertion body:
  //   contradiction-acknowledged: <sha-of-AGENTS.md>
  // If present and the referenced AGENTS.md currently hashes to that sha,
  // the contradiction is dismissed.
  const ack = assertion.body.match(/contradiction-acknowledged:\s*([0-9a-f]{7,64})/i);
  if (!ack) return false;
  const acknowledgedSha = ack[1].toLowerCase();
  for (const p of agentsMdPaths) {
    try {
      const h = createHash("sha256").update(readFileSync(p)).digest("hex");
      if (h.startsWith(acknowledgedSha)) return true;
    } catch {}
  }
  return false;
}

function lintContract(missionPath) {
  const dir = resolve(missionPath);
  const wdPath = join(dir, "working_directory.txt");
  if (!existsSync(wdPath)) return { ok: false, error: "working_directory.txt not found", exitCode: 2 };
  const workingDir = readFileSync(wdPath, "utf8").trim();

  const agentsMdPaths = walkAgentsMd(workingDir);
  if (agentsMdPaths.length === 0) {
    return { ok: true, workingDir, agentsMdCount: 0, contradictions: [], note: "no AGENTS.md found in working dir" };
  }

  const assertions = loadAssertions(dir);
  const contradictions = [];
  let acknowledged = 0;

  for (const assertion of assertions) {
    const found = findContradictions(assertion, agentsMdPaths, workingDir);
    if (found.length === 0) continue;
    if (checkAcknowledgement(assertion, agentsMdPaths, workingDir)) {
      acknowledged += 1;
      continue;
    }
    contradictions.push({
      assertionId: assertion.id,
      title: assertion.title,
      findings: found.slice(0, 3),
    });
  }

  const ok = contradictions.length === 0;
  return {
    ok,
    workingDir,
    agentsMdCount: agentsMdPaths.length,
    assertionCount: assertions.length,
    acknowledged,
    contradictions,
    exitCode: ok ? 0 : 1,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && process.argv[2]) {
  const result = lintContract(process.argv[2]);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.exitCode ?? (result.ok ? 0 : 1));
}

export { lintContract };
