#!/usr/bin/env node
// Execute a single validation assertion and return pass/fail with evidence.
// Usage: node run-assertion.mjs --id=VAL-XXX-NNN --tool=curl --evidence="..." --working-dir=/path
//
// This script generates the shell commands needed to validate an assertion
// based on its tool type. The actual execution is done by the orchestrator
// via Bash tool calls.

function generateAssertionCommands(assertion, workingDir) {
  const { id, tool, evidence, title } = assertion;

  switch (tool) {
    case "unit-test":
      return {
        id,
        tool: "unit-test",
        description: title,
        commands: [
          `cd ${workingDir} && bun test --timeout 60000 2>&1 | grep -E "(pass|fail|${id})" | tail -20`,
        ],
        passCondition: "All tests pass (0 failures)",
        evidence: evidence || "Green test run",
      };

    case "curl":
      return {
        id,
        tool: "curl",
        description: title,
        commands: extractCurlCommands(evidence, workingDir),
        passCondition: evidence || "Response matches expected shape",
        evidence: evidence || "HTTP response body",
      };

    case "cli-binary":
      return {
        id,
        tool: "cli-binary",
        description: title,
        commands: extractCliCommands(evidence, workingDir),
        passCondition: evidence || "Exit code and output match expected",
        evidence: evidence || "stdout/stderr + exit code",
      };

    case "tuistory":
      return {
        id,
        tool: "tuistory",
        description: title,
        commands: generateTuistoryFlow(id, evidence, workingDir),
        passCondition: evidence || "Snapshot contains expected text",
        evidence: evidence || "Tuistory snapshot text",
      };

    default:
      return {
        id,
        tool: "unknown",
        description: title,
        commands: [],
        passCondition: "Manual verification required",
        evidence: evidence || "No automated verification available",
      };
  }
}

function extractCurlCommands(evidence, workingDir) {
  if (!evidence) return [];
  const commands = [];
  const urlMatch = evidence.match(/https?:\/\/[^\s)]+/);
  if (urlMatch) {
    commands.push(`curl -s -w "\\nHTTP:%{http_code}" "${urlMatch[0]}" 2>&1`);
  }
  return commands;
}

// The CLI binary is project-specific. Consumers set MISSION_CLI_BIN or
// pass --cli-bin=<path>. Falls back to "<binary-name>" from the evidence
// string so ambient PATH resolution can work.
function extractCliCommands(evidence, workingDir, options = {}) {
  if (!evidence) return [];
  const commands = [];
  const cliBin = options.cliBin || process.env.MISSION_CLI_BIN || null;
  if (evidence.includes("--help")) {
    const cmdMatch = evidence.match(/`([^`]+--help[^`]*)`/);
    if (cmdMatch) {
      const cmd = cliBin
        ? cmdMatch[1].replace(/^(\S+)/, cliBin)
        : cmdMatch[1];
      commands.push(`${cmd} 2>&1; echo "EXIT:$?"`);
    }
  }
  return commands;
}

// Tuistory is optional (UI-driven assertions). Consumer sets MISSION_TUI_BIN
// to the TUI binary path, or the assertion is skipped with a note.
function generateTuistoryFlow(id, evidence, workingDir, options = {}) {
  const sessionName = `val-${id.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  const tuiBin = options.tuiBin || process.env.MISSION_TUI_BIN || null;
  if (!tuiBin) {
    return [`# tuistory assertion ${id} skipped: set MISSION_TUI_BIN to the TUI binary path`];
  }
  return [
    `tuistory launch "${tuiBin} ${workingDir}" -s ${sessionName} --cols 120 --rows 36`,
    `sleep 6`,
    `tuistory -s ${sessionName} snapshot --trim`,
    `tuistory -s ${sessionName} close`,
  ];
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain && process.argv[2]) {
  const args = Object.fromEntries(
    process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
      const [k, v] = a.substring(2).split("=");
      return [k, v];
    })
  );
  const assertion = { id: args.id, tool: args.tool, evidence: args.evidence, title: args.title || args.id };
  const result = generateAssertionCommands(assertion, args["working-dir"] || process.cwd());
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

export { generateAssertionCommands };
