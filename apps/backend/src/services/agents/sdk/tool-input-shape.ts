
import { z } from "zod";

export type ToolRawShape = Record<string, z.ZodType>;

function repairStringifiedArg(type: string, value: unknown): unknown {
  if (type === "string") {
    return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
  }
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;

  if (type === "number" || type === "integer") {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return value;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return value;
    return type === "integer" && !Number.isInteger(n) ? value : n;
  }
  if (type === "boolean") {
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return value;
  }
  if (type === "array" || type === "object") {
    const opener = type === "array" ? "[" : "{";
    if (!trimmed.startsWith(opener)) return value;
    try {
      const parsed = JSON.parse(trimmed);
      const shapeOk = type === "array" ? Array.isArray(parsed) : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
      return shapeOk ? parsed : value;
    } catch {
      return value;
    }
  }
  return value;
}

function jsonSchemaPropToZod(prop: unknown): z.ZodType {
  const type = (prop as { type?: unknown } | null)?.type;
  const base: z.ZodType | null =
    type === "string"
      ? z.string()
      : type === "number"
        ? z.number()
        : type === "integer"
          ? z.number().int()
          : type === "boolean"
            ? z.boolean()
            : type === "array"
              ? z.array(z.unknown())
              : type === "object"
                ? z.record(z.string(), z.unknown())
                : null;
  if (base === null) return z.unknown().optional();
  return z.preprocess((v) => repairStringifiedArg(type as string, v), base).optional();
}

export function buildToolInputShape(inputSchema: unknown): {
  shape: ToolRawShape;
  declaresOwnInput: boolean;
} {
  const props =
    inputSchema && typeof inputSchema === "object"
      ? ((inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      : {};
  const declaresOwnInput = Object.prototype.hasOwnProperty.call(props, "input");
  const shape: ToolRawShape = {};
  for (const key of Object.keys(props)) {
    shape[key] = jsonSchemaPropToZod(props[key]);
  }
  if (!declaresOwnInput) {
    shape.input = z.record(z.string(), z.unknown()).optional();
  }
  return { shape, declaresOwnInput };
}

export function repairArgsFromSchema(inputSchema: unknown, args: unknown): unknown {
  const props =
    inputSchema && typeof inputSchema === "object"
      ? ((inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      : {};
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    const type = (props[key] as { type?: unknown } | undefined)?.type;
    if (typeof type === "string") out[key] = repairStringifiedArg(type, value);
  }
  return out;
}

export function unwrapToolArgs(args: unknown, declaresOwnInput: boolean): unknown {
  if (declaresOwnInput) return args;
  const rec = args as Record<string, unknown> | undefined | null;
  if (rec && typeof rec === "object" && "input" in rec && rec.input !== undefined) {
    return rec.input;
  }
  return args;
}

export function sdkToolDescription(description: string, inputSchema: unknown): string {
  return `${description}\n\nInput schema (JSON Schema):\n${JSON.stringify(inputSchema)}`;
}
