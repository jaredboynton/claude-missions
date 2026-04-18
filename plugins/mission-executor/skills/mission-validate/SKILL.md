---
name: mission-validate
description: Run validation assertions against an implemented mission without re-executing features
argument-hint: "<mission-path>"
triggers:
  - validate mission
  - mission validate
  - check assertions
---

# Mission Validate

Standalone validation pass -- runs all assertions from validation-contract.md against the current codebase without executing any features. Useful for re-checking after manual fixes or verifying a partially-completed mission.

## Input

- `<mission-path>`: Path to `.factory/missions/<id>/` directory

## Workflow

1. **Parse** validation-contract.md for all assertions
2. **Read** current validation-state.json for existing pass/fail status
3. **Group** assertions by tool type (unit-test, curl, cli-binary, tuistory)
4. **Execute** each assertion group:
   - `unit-test`: Run relevant test files, check all green
   - `curl`: HTTP requests against running server, check response shapes
   - `cli-binary`: CLI invocations, check exit codes + output
   - `tuistory`: TUI snapshot captures, check content patterns
5. **Update** validation-state.json with results
6. **Write** evidence files to .omc/validation/
7. **Report** summary: N pass, N fail, N pending

## Options

- `--only=<prefix>`: Only validate assertions matching prefix (e.g., `--only=VAL-HTTP`)
- `--recheck-failed`: Only re-run assertions currently marked as "failed"
- `--skip-tuistory`: Skip TUI assertions (useful when no TUI server available)
