#!/usr/bin/env node
// Generate worker prompts for mission feature execution.
// Combines feature spec + mission boundaries + build commands + conventions
// into a complete worker prompt ready for Agent() spawning.

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

function generateWorkerPrompt({ feature, workerName, teamName, boundaries, buildCommand, conventions, workingDirectory }) {
  const workerType = classifySkill(feature.skillName);

  return `You are a TEAM WORKER in team "${teamName}". Your name is "${workerName}".
You report to the team lead ("team-lead"). You are not the leader.

== WORKING DIRECTORY ==
${workingDirectory}

== YOUR FEATURE: ${feature.id} ==

${feature.description}

== PRECONDITIONS ==
${feature.preconditions?.map((p) => `- ${p}`).join("\n") || "None specified."}

== EXPECTED BEHAVIOR ==
${feature.expectedBehavior?.map((b) => `- ${b}`).join("\n") || "See description above."}

== VERIFICATION STEPS ==
${feature.verificationSteps?.map((s) => `- ${s}`).join("\n") || "Run build and tests after implementation."}

== FULFILLS ASSERTIONS ==
${feature.fulfills?.join(", ") || "No specific assertions listed."}

== CODING CONVENTIONS ==
${workerType.conventions}
${conventions || ""}

== MISSION BOUNDARIES (NEVER VIOLATE) ==
${boundaries?.map((b) => `- ${b}`).join("\n") || "None specified."}

== BUILD DISCIPLINE ==
${buildCommand ? `After EVERY source file change, run: ${buildCommand}` : "Follow the project's build workflow."}

== COMMIT DISCIPLINE ==
- Only stage files YOU created or edited
- Snapshot git status --porcelain BEFORE staging
- After staging, verify no out-of-scope files were included
- If a protected file was accidentally staged: git restore --staged <path>

== WORK PROTOCOL ==
1. Call TaskList to find your assigned task. Set it to in_progress via TaskUpdate.
2. Read relevant AGENTS.md files along the path before editing files.
3. TDD: write failing test first (red), then implement (green).
4. Run build command after source changes.
5. Commit with scoped git add (only your files).
6. Mark task completed via TaskUpdate.
7. Report to team-lead via SendMessage with a summary of what changed.

== ERRORS ==
If you cannot complete the task, report via SendMessage to "team-lead" with details. Do NOT mark as completed.

== CONTRACT FIDELITY ==
- The mission's \`validation-contract.md\` is authored against the PROJECT'S documented trust models (nested \`AGENTS.md\` files in the working directory). Your job is to satisfy the contract AS WRITTEN, not to match it against today's code.
- If a contract assertion seems to contradict an \`AGENTS.md\` rule you encounter (e.g. asserts enforcement where the docs say "bypasses by design"), STOP. Report via SendMessage to "team-lead" and do NOT implement the contradiction into code. The plugin's Phase 0.5 CONTRACT-LINT would normally catch this before dispatch; if it reached you, the lint missed it.
- NEVER edit \`validation-contract.md\` to make a failing assertion match your implementation. The contract is authoritative input; the implementation follows.
- NEVER hand-edit \`validation-state.json\`. The \`assertion-proof-guard.mjs\` hook blocks it at the tool level. Only \`execute-assertion.mjs\` can move status to passed.

== RULES ==
- NEVER spawn sub-agents or orchestration skills
- NEVER run tmux session management commands
- ALWAYS use absolute file paths
- ALWAYS report progress via SendMessage to "team-lead"`;
}

function classifySkill(skillName) {
  const mapping = {
    "tui-worker": { conventions: "TypeScript + SolidJS (createSignal/createEffect/createMemo). NO React. Dialogs via useDialog().replace(...). HTTP via useSDK() only. TUI thread has NO Instance context." },
    "backend-worker": { conventions: "TypeScript + Effect. Use Effect.gen(function* () { ... }), Effect.fn(\"Domain.method\"), Schema.Class, Schema.TaggedErrorClass. Prefer Effect services." },
    "http-worker": { conventions: "TypeScript + Hono. Route handlers with Zod validators. Error responses via missionErrorToResponse with MISSION_* code constants." },
    "cli-worker": { conventions: "TypeScript + Yargs. renderMissionCliError for typed errors. Exit codes: INVALID_INPUT=2, NOT_FOUND=3, CONFLICT=1. --help exits 0." },
    "polish-worker": { conventions: "TypeScript + SolidJS. State-reactive patterns using createMemo. Consistent theme helper usage (stateColor, stateBadge)." },
  };
  return mapping[skillName] || { conventions: "Follow existing patterns in the codebase." };
}

if (process.argv[2]) {
  const { readFileSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const missionPath = resolve(process.argv[2]);
  const featureId = process.argv[3];
  if (!featureId) {
    process.stderr.write("Usage: node generate-worker-prompts.mjs <mission-path> <feature-id>\n");
    process.exit(1);
  }
  const features = JSON.parse(readFileSync(join(missionPath, "features.json"), "utf8")).features;
  const feature = features.find((f) => f.id === featureId);
  if (!feature) {
    process.stderr.write(`Feature "${featureId}" not found\n`);
    process.exit(1);
  }
  const agentsMd = readFileSync(join(missionPath, "AGENTS.md"), "utf8");
  const boundaries = agentsMd.split("\n").filter((l) => /never|NEVER/.test(l) && l.trim().startsWith("-")).map((l) => l.trim().replace(/^-\s*/, ""));
  const prompt = generateWorkerPrompt({
    feature, workerName: "worker-1", teamName: "mission-test",
    boundaries, buildCommand: null, conventions: "", workingDirectory: process.cwd(),
  });
  process.stdout.write(prompt + "\n");
}

export { generateWorkerPrompt };
