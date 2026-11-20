
import { ObjectId } from "mongodb";

export function dropTopLevelNullParams(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== null),
    );
  }
  return v;
}

function tryParseJsonString(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function coerceJsonObjectField(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = tryParseJsonString(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  }
  return raw;
}

function coerceJsonArrayField(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = tryParseJsonString(raw);
    if (Array.isArray(parsed)) return parsed;
  }
  return raw;
}

function coercePositiveIntField(raw: unknown): unknown {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return raw;
}

export function coerceOperatorDbQueryInput(v: unknown): unknown {
  const base = dropTopLevelNullParams(v);
  if (!base || typeof base !== "object" || Array.isArray(base)) return base;

  const out = { ...(base as Record<string, unknown>) };
  if ("filter" in out) out.filter = coerceJsonObjectField(out.filter);
  if ("pipeline" in out) out.pipeline = coerceJsonArrayField(out.pipeline);
  if ("projection" in out) out.projection = coerceJsonObjectField(out.projection);
  if ("sort" in out) out.sort = coerceJsonObjectField(out.sort);
  if ("limit" in out) out.limit = coercePositiveIntField(out.limit);
  if ("skip" in out) out.skip = coercePositiveIntField(out.skip);
  return out;
}

function parseExtendedJsonDate(d: unknown): Date | undefined {
  if (d instanceof Date) return d;
  if (typeof d === "number" && Number.isFinite(d)) return new Date(d);
  if (isPlainObject(d) && typeof d.$numberLong === "string") {
    const ms = Number(d.$numberLong);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  if (typeof d === "string") {
    const ms = Date.parse(d);
    if (!Number.isNaN(ms)) return new Date(ms);
  }
  return undefined;
}

const MAX_COERCE_DEPTH = 64;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function coerceMongoExtendedJson(value: unknown, depth = 0): unknown {
  if (depth > MAX_COERCE_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((el) => coerceMongoExtendedJson(el, depth + 1));
  }
  if (!isPlainObject(value)) return value;

  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$date") {
    const parsed = parseExtendedJsonDate(value.$date);
    if (parsed) return parsed;
  }
  if (keys.length === 1 && keys[0] === "$oid") {
    const id = value.$oid;
    if (typeof id === "string" && ObjectId.isValid(id)) return new ObjectId(id);
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = coerceMongoExtendedJson(v, depth + 1);
  return out;
}
