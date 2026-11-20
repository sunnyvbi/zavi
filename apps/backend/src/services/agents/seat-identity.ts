
import { createHash, randomBytes } from "node:crypto";

export const API_KEY_SEAT = "api_key";

export const NO_SEAT = "none";

let fallbackSalt: string | null = null;
function salt(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SEAT_LABEL_SALT?.trim();
  if (configured) return configured;
  if (!fallbackSalt) fallbackSalt = randomBytes(16).toString("hex");
  return fallbackSalt;
}

export function seatLabelForToken(
  token: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const t = token?.trim();
  if (!t) return NO_SEAT;
  const digest = createHash("sha256")
    .update(salt(env))
    .update("\0")
    .update(t)
    .digest("hex");
  return `seat_${digest.slice(0, 12)}`;
}

export function seatLabelForAuth(args: {
  mode: "oauth" | "api_key" | "none";
  token?: string | null;
  env?: NodeJS.ProcessEnv;
}): string {
  if (args.mode === "api_key") return API_KEY_SEAT;
  if (args.mode === "none") return NO_SEAT;
  return seatLabelForToken(args.token, args.env);
}

export function warnIfSeatSaltUnset(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SEAT_LABEL_SALT?.trim()) return true;
  console.warn(
    "[seat-identity] SEAT_LABEL_SALT is unset — seat labels will change on every " +
      "restart and per-seat cost history will fragment. Set it in AWS Secrets " +
      "Manager (praxis-envprod-1) to keep attribution continuous.",
  );
  return false;
}

export function _resetSeatSaltForTest(): void {
  fallbackSalt = null;
}
