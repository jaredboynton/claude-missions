// Guards against regressions in slash-command argument substitution.
//
// Claude Code 2.1.19 added 0-indexed `$0`, `$1`, … positional shorthand
// (CHANGELOG entry: "Added shorthand $0, $1, etc. for accessing individual
// arguments in custom commands"). `$0` is the FIRST argument; `$1` is the
// SECOND. Earlier mission-executor commands used `$1` expecting shell-style
// 1-indexed first-arg, which silently became empty once the 2.1.19 semantics
// landed — `/mission-executor:execute <id>` passed the id into `$0` and
// handed an empty string to `mission-cli.mjs start`, producing bad-input.
//
// The canonical fix here is `$ARGUMENTS` (the full raw argument string) since
// every mission-executor command takes a single optional positional.
// This test freezes that choice: no `$0`, `$1`, `$2`, `$3` in the bash exec
// line, and the command passes its argument through `"$ARGUMENTS"`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const commandsDir = join(__dirname, "..", "commands");

// The commands that shell out to mission-cli.mjs with the user's argument.
// abort.md and detach.md intentionally take no argument, so they are
// covered by a separate check below.
const ARG_FORWARDING_COMMANDS = ["execute.md", "status.md"];

// Commands that must NOT reference any positional placeholder because they
// take no argument.
const NO_ARG_COMMANDS = ["abort.md", "detach.md"];

function readCommand(name) {
  return readFileSync(join(commandsDir, name), "utf8");
}

// Match a bash-execution line: lines that begin with !` and end with `.
// Per Claude Code docs, these are the *only* lines whose positional
// substitutions get executed by the shell.
function bashExecLines(src) {
  return src.split(/\r?\n/).filter((l) => /^!`.*`\s*$/.test(l));
}

for (const cmd of ARG_FORWARDING_COMMANDS) {
  test(`commands/${cmd}: forwards user arg via $ARGUMENTS, not positional $N`, () => {
    const src = readCommand(cmd);
    const lines = bashExecLines(src);
    assert.ok(lines.length > 0, `expected at least one bash exec line in ${cmd}`);

    for (const line of lines) {
      // The user's arg must reach mission-cli.mjs via $ARGUMENTS.
      assert.match(
        line,
        /"\$ARGUMENTS"/,
        `${cmd}: bash exec line must pass user arg as "$ARGUMENTS" (got: ${line})`,
      );

      // Reject shell-style positional shorthand. Claude Code 2.1.19 made
      // these 0-indexed, so `$1` silently refers to the SECOND argument.
      // `$0`..`$3` is the practical span we need to guard against; callers
      // never pass more than a few positional args.
      for (const n of [0, 1, 2, 3]) {
        // Look for the placeholder in a non-word context so `$10` or
        // `$ENV0` don't false-match.
        const re = new RegExp(`\\$${n}(?!\\w)`);
        assert.doesNotMatch(
          line,
          re,
          `${cmd}: bash exec line must not use positional $${n} (Claude Code 2.1.19+ is 0-indexed; use $ARGUMENTS instead). Got: ${line}`,
        );
      }
    }
  });
}

for (const cmd of NO_ARG_COMMANDS) {
  test(`commands/${cmd}: takes no argument, no positional placeholders`, () => {
    const src = readCommand(cmd);
    const lines = bashExecLines(src);
    for (const line of lines) {
      for (const n of [0, 1, 2, 3]) {
        const re = new RegExp(`\\$${n}(?!\\w)`);
        assert.doesNotMatch(
          line,
          re,
          `${cmd}: no-arg command must not reference $${n}. Got: ${line}`,
        );
      }
      // No-arg commands also shouldn't forward $ARGUMENTS to the CLI.
      // (A future command that takes an arg should move to the other list.)
      assert.doesNotMatch(
        line,
        /\$ARGUMENTS/,
        `${cmd}: no-arg command should not reference $ARGUMENTS. Got: ${line}`,
      );
    }
  });
}
