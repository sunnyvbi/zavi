
import { scrubQueryForCapture } from "./eval-capture-scrub";

const CLAIM_MAX = 1000;

export function scrubClaim(input: string): string {
  if (typeof input !== "string") return "";
  const scrubbed = scrubQueryForCapture(input);
  if (scrubbed.length > CLAIM_MAX) {
    return scrubbed.slice(0, CLAIM_MAX - 14) + "[…truncated]";
  }
  return scrubbed;
}

export const _CLAIM_MAX = CLAIM_MAX;
