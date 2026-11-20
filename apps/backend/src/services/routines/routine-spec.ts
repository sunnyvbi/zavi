
export interface RoutineSpecV1 {
  type: "tool_sequence";
  steps: Array<{
    tool: string;
    args: Record<string, unknown>;
  }>;
}

export type RoutineSpecValidation =
  | { ok: true; spec: RoutineSpecV1 }
  | { ok: false; reason: string };

export const ROUTINE_SPEC_CURRENT_VERSION = 1 as const;

const ALLOWED_TOP_LEVEL_KEYS = new Set(["type", "steps"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateRoutineSpec(input: unknown): RoutineSpecValidation {
  if (typeof input === "string") {
    return { ok: false, reason: "routine_spec is a freeform string; only the closed tool_sequence union is permitted" };
  }
  if (!isPlainObject(input)) {
    return { ok: false, reason: `routine_spec must be a tool_sequence object, got ${input === null ? "null" : Array.isArray(input) ? "array" : typeof input}` };
  }

  for (const k of Object.keys(input)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(k)) {
      return { ok: false, reason: `routine_spec has unexpected top-level key "${k}"; only {type, steps} are allowed` };
    }
  }

  if (input.type !== "tool_sequence") {
    return { ok: false, reason: `routine_spec.type must be "tool_sequence", got ${JSON.stringify(input.type)}` };
  }

  const steps = input.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, reason: "routine_spec.steps must be a non-empty array" };
  }

  const narrowedSteps: RoutineSpecV1["steps"] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!isPlainObject(step)) {
      return { ok: false, reason: `routine_spec.steps[${i}] must be an object` };
    }
    for (const k of Object.keys(step)) {
      if (k !== "tool" && k !== "args") {
        return { ok: false, reason: `routine_spec.steps[${i}] has unexpected key "${k}"; only {tool, args} are allowed` };
      }
    }
    if (typeof step.tool !== "string" || step.tool.length === 0) {
      return { ok: false, reason: `routine_spec.steps[${i}].tool must be a non-empty string` };
    }
    if (!isPlainObject(step.args)) {
      return { ok: false, reason: `routine_spec.steps[${i}].args must be an object` };
    }
    narrowedSteps.push({ tool: step.tool, args: step.args });
  }

  return { ok: true, spec: { type: "tool_sequence", steps: narrowedSteps } };
}

export function toolsReferencedBySpec(spec: RoutineSpecV1): string[] {
  return Array.from(new Set(spec.steps.map((s) => s.tool)));
}
