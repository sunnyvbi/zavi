
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeMatches(val: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : typeof type === "string" ? [type] : [];
  if (types.length === 0) return true;
  return types.some((t) => {
    switch (t) {
      case "string": return typeof val === "string";
      case "number":
      case "integer": return typeof val === "number" && Number.isFinite(val);
      case "boolean": return typeof val === "boolean";
      case "object": return isPlainObject(val);
      case "array": return Array.isArray(val);
      case "null": return val === null;
      default: return true;
    }
  });
}

export type ArgValidateResult = { ok: true } | { ok: false; reason: string };

export function validateStepArgs(
  tool: string,
  args: Record<string, unknown>,
  inputSchema: unknown,
): ArgValidateResult {
  if (!isPlainObject(inputSchema)) {
    return { ok: false, reason: `tool '${tool}' has no resolvable input schema (fail-closed)` };
  }
  if (inputSchema.type !== undefined && inputSchema.type !== "object") {
    return { ok: false, reason: `tool '${tool}' input schema is not an object schema (type=${JSON.stringify(inputSchema.type)})` };
  }
  const props = isPlainObject(inputSchema.properties) ? inputSchema.properties : {};
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((r): r is string => typeof r === "string")
    : [];
  const forbidExtra = inputSchema.additionalProperties === false;

  for (const r of required) {
    if (!(r in args)) {
      return { ok: false, reason: `tool '${tool}' missing required arg '${r}'` };
    }
  }
  for (const key of Object.keys(args)) {
    if (forbidExtra && !(key in props)) {
      return { ok: false, reason: `tool '${tool}' got unexpected arg '${key}' (not in the tool's input schema)` };
    }
    const propSchema = props[key];
    if (isPlainObject(propSchema) && !typeMatches(args[key], propSchema.type)) {
      return { ok: false, reason: `tool '${tool}' arg '${key}' has wrong type (expected ${JSON.stringify(propSchema.type)})` };
    }
  }
  return { ok: true };
}

export function validateRoutineArgs(
  steps: Array<{ tool: string; args: Record<string, unknown> }>,
  schemaByTool: Map<string, unknown>,
): ArgValidateResult {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!schemaByTool.has(step.tool)) {
      return { ok: false, reason: `step ${i}: tool '${step.tool}' is not among the agent's live tools (no schema to validate against)` };
    }
    const r = validateStepArgs(step.tool, step.args, schemaByTool.get(step.tool));
    if (!r.ok) return { ok: false, reason: `step ${i}: ${r.reason}` };
  }
  return { ok: true };
}
