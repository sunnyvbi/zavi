import { createHash } from "node:crypto";

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  return value;
}

export function adReviewVersion(execClass: string, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(ordered([execClass, payload]))).digest("hex");
}
