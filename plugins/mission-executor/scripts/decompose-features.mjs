#!/usr/bin/env node
// Decompose mission features into parallel execution batches.
// Usage: node decompose-features.mjs <mission-path> [--max-workers=5]
// Outputs: JSON array of batches, each with features that can run in parallel.

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { realpathSync as _realpathSync } from "node:fs";

function decomposeFeatures(features, maxWorkers = 5) {
  const milestones = [...new Set(features.map((f) => f.milestone))];
  const batches = [];

  for (const milestone of milestones) {
    const milestoneFeatures = features.filter(
      (f) => f.milestone === milestone && f.status !== "completed"
    );

    if (milestoneFeatures.length === 0) continue;

    for (let i = 0; i < milestoneFeatures.length; i += maxWorkers) {
      const batch = milestoneFeatures.slice(i, i + maxWorkers);
      batches.push({
        milestone,
        features: batch.map((f) => ({
          id: f.id,
          description: f.description,
          skillName: f.skillName,
          preconditions: f.preconditions || [],
          expectedBehavior: f.expectedBehavior || [],
          verificationSteps: f.verificationSteps || [],
          fulfills: f.fulfills || [],
        })),
        workerCount: batch.length,
      });
    }
  }

  return batches;
}

function classifyWorkerType(skillName) {
  const mapping = {
    "tui-worker": { focus: "TUI/SolidJS", conventions: "SolidJS (createSignal/createEffect/createMemo). NO React. Dialogs via useDialog().replace(...). HTTP via useSDK() only." },
    "backend-worker": { focus: "Backend/Effect", conventions: "Effect.gen, Effect.fn(\"Domain.method\"), Schema.Class, Schema.TaggedErrorClass." },
    "http-worker": { focus: "HTTP routes", conventions: "Hono route handlers. Error responses via missionErrorToResponse. Zod validators." },
    "cli-worker": { focus: "CLI commands", conventions: "Yargs command handlers. renderMissionCliError for typed errors. Exit codes: INVALID_INPUT=2, NOT_FOUND=3, CONFLICT=1." },
    "polish-worker": { focus: "UI polish", conventions: "SolidJS + state-reactive patterns. Consistent styling with theme helpers." },
  };
  return mapping[skillName] || { focus: "General", conventions: "Follow existing patterns." };
}

const isMain = (() => { try { return !!process.argv[1] && _fileURLToPath(import.meta.url) === _realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain && process.argv[2]) {
  const missionPath = resolve(process.argv[2]);
  const maxWorkers = parseInt(process.argv.find((a) => a.startsWith("--max-workers="))?.split("=")[1] || "5");
  const features = JSON.parse(readFileSync(join(missionPath, "features.json"), "utf8")).features;
  const batches = decomposeFeatures(features, maxWorkers);
  process.stdout.write(JSON.stringify({ batches, totalBatches: batches.length, totalFeatures: features.length }, null, 2) + "\n");
}

export { decomposeFeatures, classifyWorkerType };
