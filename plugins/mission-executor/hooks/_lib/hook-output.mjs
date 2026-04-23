// Canonical hook-output helpers (v0.8.1).
//
// Claude Code 2.1.118 tightened the hook-output JSON schema. For PreToolUse,
// the legacy top-level `decision` / `message` / `reason` fields are
// deprecated; only `hookSpecificOutput.permissionDecision` /
// `permissionDecisionReason` are accepted. Emitting both legacy AND modern
// shapes in the same payload fails schema validation with
//   "Hook JSON output validation failed — (root): Invalid input"
// on every tool call.
//
// Events that still accept top-level `decision`/`reason` per the 2.1.118
// docs: UserPromptSubmit, UserPromptExpansion, PostToolUse,
// PostToolUseFailure, Stop, SubagentStop, ConfigChange, PreCompact. Stop is
// the only one we emit from (autopilot-lock.mjs), so `stopBlock(reason)`
// keeps the legacy shape there.
//
// For PostToolUse feedback (build-discipline / validation-tracker), the
// valid way to surface a reminder to the agent is
// `hookSpecificOutput.additionalContext` or the top-level `systemMessage`.
// A bare `{message: "..."}` — what both hooks used prior to 0.8.1 — is NOT
// in the PostToolUse schema and was silently ignored by older Claude Code
// builds but now trips the validator.

// PreToolUse: allow with optional context injection.
export function preAllow({ context } = {}) {
  const spec = { hookEventName: "PreToolUse", permissionDecision: "allow" };
  if (context) spec.additionalContext = context;
  return { hookSpecificOutput: spec };
}

// PreToolUse: deny with a reason shown to Claude.
export function preDeny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

// PostToolUse: add context for Claude to consider on the next turn. Returns
// the canonical `hookSpecificOutput.additionalContext` shape. Pass an empty
// string / nullish to emit a no-op `{}`.
export function postContext(context) {
  if (!context) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  };
}

// Stop: block with a reason. Stop still uses the legacy top-level
// `decision`/`reason` shape per the 2.1.118 docs.
export function stopBlock(reason) {
  return { decision: "block", reason };
}

// Universal no-op. Valid for every event.
export function noop() { return {}; }
