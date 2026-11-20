
import { randomBytes } from "node:crypto";
import { hashPatToken } from "@/services/auth/pat";

export const MCP_RESOURCE =
  process.env.PRAXIS_MCP_RESOURCE ?? "https://api.zaviagent.com/mcp";

export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
export const CODE_TTL_SECONDS = 60;
export const CONSENT_STATE_TTL_SECONDS = 300;

export const OAT_PREFIX = "praxis_oat_";
export const ORT_PREFIX = "praxis_ort_";
export const CODE_PREFIX = "praxis_ac_";
export const PREFIX_LOOKUP_LEN = 23;

export type RawToken = { raw: string; hash: string; salt: string; prefix: string };

export function generateToken(kindPrefix: string): RawToken {
  const raw = kindPrefix + randomBytes(32).toString("hex");
  const salt = randomBytes(16).toString("hex");
  const hash = hashPatToken(raw, salt);
  const prefix = raw.slice(0, PREFIX_LOOKUP_LEN);
  return { raw, hash, salt, prefix };
}
