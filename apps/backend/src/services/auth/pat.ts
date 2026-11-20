
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { serviceClient } from "@/services/supabase";

export const PAT_PREFIX = "zavi_pat_";
export const LEGACY_PAT_PREFIX = "praxis_pat_";
const PREFIX_LEN = 23;
const MAX_PREFIX_CANDIDATES = 5;

export function isPatToken(raw: string): boolean {
  return raw.startsWith(PAT_PREFIX) || raw.startsWith(LEGACY_PAT_PREFIX);
}

export function generateRawPat(): string {
  return PAT_PREFIX + randomBytes(32).toString("hex");
}

export function hashPatToken(raw: string, salt: string): string {
  return createHash("sha256").update(salt).update(raw).digest("hex");
}

export function _verifyHashConstantTime(
  raw: string,
  salt: string,
  expectedHash: string,
): boolean {
  const got = Buffer.from(hashPatToken(raw, salt), "hex");
  const exp = Buffer.from(expectedHash, "hex");
  if (got.length !== exp.length) return false;
  return timingSafeEqual(got, exp);
}

export type PatCaller = {
  pat_id: string;
  user_id: string;
  tenant_id: string;
  scopes: string[];
};

export class PatAuthError extends Error {
  constructor(
    public code:
      | "missing"
      | "malformed"
      | "not_found"
      | "revoked"
      | "expired"
      | "membership_revoked"
      | "anomaly",
  ) {
    super(code);
  }
}

export async function resolveCallerFromPat(raw: string): Promise<PatCaller> {
  if (!raw || !isPatToken(raw) || raw.length < 40) {
    throw new PatAuthError("malformed");
  }
  const sb = serviceClient();
  const prefix = raw.slice(0, PREFIX_LEN);

  const { data: rows, error } = await sb
    .from("tenant_pats")
    .select("id,user_id,tenant_id,token_hash,token_salt,scopes,expires_at,revoked_at")
    .eq("token_prefix", prefix)
    .is("revoked_at", null);
  if (error) throw new PatAuthError("not_found");
  if (!rows || rows.length === 0) throw new PatAuthError("not_found");

  if (rows.length > MAX_PREFIX_CANDIDATES) {
    throw new PatAuthError("anomaly");
  }

  const match = rows.find((r) =>
    _verifyHashConstantTime(raw, r.token_salt as string, r.token_hash as string),
  );
  if (!match) throw new PatAuthError("not_found");
  if (match.revoked_at) throw new PatAuthError("revoked");
  if (match.expires_at && new Date(match.expires_at as string) < new Date()) {
    throw new PatAuthError("expired");
  }

  const { data: mem, error: mErr } = await sb
    .from("tenant_users")
    .select("tenant_id")
    .eq("user_id", match.user_id as string)
    .eq("tenant_id", match.tenant_id as string)
    .maybeSingle();
  if (mErr || !mem) throw new PatAuthError("membership_revoked");

  void sb
    .from("tenant_pats")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", match.id as string);

  return {
    pat_id: match.id as string,
    user_id: match.user_id as string,
    tenant_id: mem.tenant_id as string,
    scopes: (match.scopes as string[]) ?? [],
  };
}

export type MintInput = {
  tenant_id: string;
  user_id: string;
  name: string;
  scopes: string[];
  expires_at: string | null;
};

export async function mintPat(
  input: MintInput,
): Promise<{ id: string; raw: string; prefix: string }> {
  const raw = generateRawPat();
  const salt = randomBytes(16).toString("hex");
  const hash = hashPatToken(raw, salt);
  const prefix = raw.slice(0, PREFIX_LEN);
  const sb = serviceClient();
  const { data, error } = await sb.rpc("mint_tenant_pat", {
    p_tenant_id: input.tenant_id,
    p_user_id: input.user_id,
    p_token_hash: hash,
    p_token_salt: salt,
    p_token_prefix: prefix,
    p_name: input.name,
    p_scopes: input.scopes,
    p_expires_at: input.expires_at,
  });
  if (error) throw new Error(`mint_tenant_pat failed: ${error.message}`);
  return { id: data as string, raw, prefix };
}

export const TOOL_SCOPES: Record<string, "read" | "run" | "admin"> = {
  zavi_list_agents: "read",
  zavi_get_run_status: "read",
  zavi_recent_runs: "read",
  zavi_read_brain: "read",
  zavi_search: "read",
  zavi_fetch: "read",
  zavi_next_step: "read",
  zavi_run_agent: "run",
  zavi_ask: "run",
  zavi_mark_step_done: "run",
  zavi_report_number: "run",
};

export function callerHasScope(caller: { scopes: string[] }, tool: string): boolean {
  const need = TOOL_SCOPES[tool];
  if (!need) return false;
  return caller.scopes.includes(need);
}
