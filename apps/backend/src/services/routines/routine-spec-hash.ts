
import { createHash } from "node:crypto";
import { validateRoutineSpec } from "./routine-spec";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = canonicalize(obj[k]);
    }
    return out;
  }
  return value;
}

export function hashValidatedRoutineSpec(spec: unknown): string {
  const canonical = JSON.stringify(canonicalize(spec));
  return "v1:" + createHash("sha256").update(canonical).digest("hex");
}

export function hashRoutineSpecMaybe(rawRoutineSpec: unknown): string | null {
  const check = validateRoutineSpec(rawRoutineSpec);
  if (!check.ok) return null;
  return hashValidatedRoutineSpec(check.spec);
}
