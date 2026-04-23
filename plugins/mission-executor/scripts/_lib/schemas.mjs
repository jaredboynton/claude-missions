// Hand-rolled schema validator. Zero deps. Subset of zod's surface.
//
// Design: schemas are plain objects (not builders). `validate(schema, value)`
// returns `{ ok: true, value }` on success or `{ ok: false, errors: string[] }`
// with JSONPath-ish error messages.
//
// Supported leaf constraints:
//   - type: "string" | "array" | "object" | "number" | "boolean"
//   - enum: any[]                   (allowed values; type inferred from elements)
//   - minLength / maxLength         (strings)
//   - minItems / maxItems           (arrays)
//   - items                         (array element schema)
//   - required: string[]            (object keys)
//   - properties: { [key]: schema } (object shape)
//   - minSentences / maxSentences   (droid's refinement; 1-N sentences)
//
// "optional" is expressed by OMITTING the key from `required`. Missing keys
// are not validated. null/undefined values at a REQUIRED key fail.

// ---- Helpers --------------------------------------------------------------

function countSentences(s) {
  if (!s || typeof s !== "string") return 0;
  const trimmed = s.replace(/\s+/g, " ").trim().replace(/[.!?]+\s*$/, "");
  if (!trimmed) return 0;
  return trimmed.split(/[.!?]+\s+/).filter(Boolean).length;
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---- Core validator -------------------------------------------------------

// Walks schema + value together, collecting errors. Mutates `errs` in place.
function check(schema, value, path, errs) {
  if (schema === undefined || schema === null) return;

  // Check enum first (applies to any type).
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      errs.push(`${path}: value ${JSON.stringify(value)} not in enum [${schema.enum.map((x) => JSON.stringify(x)).join(", ")}]`);
      return;  // Further checks meaningless if enum fails.
    }
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      errs.push(`${path}: expected string, got ${value === null ? "null" : typeof value}`);
      return;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errs.push(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errs.push(`${path}: string length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.maxSentences !== undefined) {
      const n = countSentences(value);
      const minS = schema.minSentences !== undefined ? schema.minSentences : 1;
      if (n < minS || n > schema.maxSentences) {
        errs.push(`${path}: ${n} sentence(s) outside [${minS}, ${schema.maxSentences}]`);
      }
    }
    return;
  }

  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errs.push(`${path}: expected number, got ${value === null ? "null" : typeof value}`);
    }
    return;
  }

  if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      errs.push(`${path}: expected boolean, got ${value === null ? "null" : typeof value}`);
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errs.push(`${path}: expected array, got ${value === null ? "null" : typeof value}`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errs.push(`${path}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errs.push(`${path}: array length ${value.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        check(schema.items, value[i], `${path}[${i}]`, errs);
      }
    }
    return;
  }

  if (schema.type === "object") {
    if (!isPlainObject(value)) {
      errs.push(`${path}: expected object, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
      return;
    }
    const required = schema.required || [];
    for (const req of required) {
      if (!(req in value) || value[req] === null || value[req] === undefined) {
        errs.push(`${path}.${req}: required`);
      }
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value && value[k] !== undefined && value[k] !== null) {
          check(sub, value[k], `${path}.${k}`, errs);
        }
      }
    }
    return;
  }

  // No `type`, no `enum` — schema is effectively any. No-op.
}

export function validate(schema, value) {
  const errs = [];
  check(schema, value, "$", errs);
  if (errs.length === 0) return { ok: true, value };
  return { ok: false, errors: errs };
}

// ---- Schemas --------------------------------------------------------------

export const discoveredIssueSchema = {
  type: "object",
  required: ["severity", "description"],
  properties: {
    severity: { enum: ["low", "medium", "high", "critical"] },
    description: { type: "string", minLength: 10, maxLength: 2000 },
    suggestedFix: { type: "string", maxLength: 2000 },
  },
};

// Minimum-viable worker return contract. Mirrors droid's workerHandoffSchema
// subset: success state, short salient summary with sentence-count refinement,
// optional structured whatWasDone/whatWasLeftUndone/discoveredIssues, commit
// provenance, and a free-form return-to-orchestrator note.
export const workerHandoffSchema = {
  type: "object",
  required: ["workerSessionId", "featureId", "successState", "salientSummary"],
  properties: {
    workerSessionId: { type: "string", minLength: 1 },
    featureId:       { type: "string", minLength: 1 },
    milestone:       { type: "string" },
    successState:    { enum: ["success", "partial", "failure"] },
    salientSummary:  { type: "string", minLength: 20, maxLength: 500, maxSentences: 4 },
    whatWasDone:        { type: "array", items: { type: "string", minLength: 5, maxLength: 500 } },
    whatWasLeftUndone:  { type: "array", items: { type: "string", minLength: 5, maxLength: 500 } },
    discoveredIssues:   { type: "array", items: discoveredIssueSchema },
    commitShas:         { type: "array", items: { type: "string", minLength: 7, maxLength: 64 } },
    returnToOrchestrator:{ type: "string", maxLength: 1000 },
  },
};

// Feature-end contract; simpler than workerHandoff (no worker provenance,
// used at phase boundaries to mark a feature done without a full handoff).
export const endFeatureInputSchema = {
  type: "object",
  required: ["featureId", "status", "summary"],
  properties: {
    featureId: { type: "string", minLength: 1 },
    status:    { enum: ["completed", "cancelled", "failed"] },
    summary:   { type: "string", minLength: 20, maxLength: 500, maxSentences: 4 },
    commitShas:{ type: "array", items: { type: "string" } },
  },
};
