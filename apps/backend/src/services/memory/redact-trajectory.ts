
import { scrubQueryForCapture } from "./eval-capture-scrub";

export const REDACTION_VERSION = 1;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type RedactResult = { value: Json; redactions: number };

export function redactTrajectory(input: unknown): RedactResult {
  let redactions = 0;

  const walk = (v: unknown): Json => {
    if (typeof v === "string") {
      const scrubbed = scrubQueryForCapture(v);
      if (scrubbed !== v) redactions += 1;
      return scrubbed;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: { [k: string]: Json } = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    if (typeof v === "number" || typeof v === "boolean" || v === null) {
      return v;
    }
    return null;
  };

  return { value: walk(input), redactions };
}
