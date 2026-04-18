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
  const skip = new Set(["node_modules", ".git", "dist", "build", ".omc", ".factory", ".next", "coverage"]);
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
    const end = i + 1 < indices.length ? indices[i + 1].start : text.length;
    blocks.push({ id, title, body: text.slice(start, end) });
  }
  return blocks;
}

function extractAssertionKeywords(assertion) {
  const body = assertion.body;
  const keywords = new Set();
  // Backtick-wrapped identifiers and paths.
  for (const m of body.matchAll(/`([^`]+)`/g)) {
    const inner = m[1];
    if (/^[a-z][\w./-]+$/i.test(inner) && inner.length > 3) keywords.add(inner);
  }
  // Also pick up hint words like "gate", "bypass", "403"
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

    // Only consider AGENTS.md entries mentioning at least one of the
    // assertion's keywords AND containing a suspect phrase.
    const hitKeyword = assertionKeywords.find((k) => text.includes(k));
    if (!hitKeyword) continue;

    // Find the paragraph containing the keyword.
    const paragraphs = text.split(/\n\n+/);
    for (const para of paragraphs) {
      if (!para.includes(hitKeyword)) continue;
      for (const phrase of SUSPECT_PHRASES) {
        const m = para.match(phrase);
        if (!m) continue;
        contradictions.push({
          agentsMd: rel,
          keyword: hitKeyword,
          phrase: m[0],
          excerpt: para.trim().slice(0, 280),
        });
        break; // one signal per AGENTS.md is enough
      }
    }
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
