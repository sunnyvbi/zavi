
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting } from "@/services/settings";

const PREFIX = "zavi_mac_";
const PREFIX_LEN = 21;
const MAX_PREFIX_CANDIDATES = 5;

export type MacWorkerCaller = { token_id: string; owner: string };

export class MacTokenAuthError extends Error {
  constructor(
    public code: "missing" | "malformed" | "not_found" | "revoked" | "anomaly",
  ) {
    super(code);
  }
}

export function generateRawMacToken(): string {
  return PREFIX + randomBytes(32).toString("hex");
}

export function hashMacToken(raw: string, salt: string): string {
  return createHash("sha256").update(salt).update(raw).digest("hex");
}

export function _verifyHashConstantTime(
  raw: string,
  salt: string,
  expectedHash: string,
): boolean {
  const got = Buffer.from(hashMacToken(raw, salt), "hex");
  const exp = Buffer.from(expectedHash, "hex");
  if (got.length !== exp.length) return false;
  return timingSafeEqual(got, exp);
}

export async function resolveMacWorkerToken(
  raw: string,
): Promise<MacWorkerCaller> {
  if (!raw || !raw.startsWith(PREFIX) || raw.length < 40) {
    throw new MacTokenAuthError("malformed");
  }
  const sb = serviceClient();
  const prefix = raw.slice(0, PREFIX_LEN);
  const { data: rows, error } = await sb
    .from("mac_worker_tokens")
    .select("id, token_hash, token_salt, revoked_at")
    .eq("token_prefix", prefix)
    .is("revoked_at", null);
  if (error) throw new MacTokenAuthError("not_found");
  if (!rows || rows.length === 0) throw new MacTokenAuthError("not_found");
  if (rows.length > MAX_PREFIX_CANDIDATES) {
    throw new MacTokenAuthError("anomaly");
  }
  const match = rows.find((r) =>
    _verifyHashConstantTime(
      raw,
      r.token_salt as string,
      r.token_hash as string,
    ),
  );
  if (!match) throw new MacTokenAuthError("not_found");
  if (match.revoked_at) throw new MacTokenAuthError("revoked");
  void sb
    .from("mac_worker_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", match.id as string);
  return {
    token_id: match.id as string,
    owner: `mac:${match.id as string}`,
  };
}

export async function assertTokenTenantEnabled(
  token_id: string,
  tenant_id: string,
): Promise<boolean> {
  if (!(await getBoolSetting("fleet_local_lane_enabled"))) return false;
  const { data, error } = await serviceClient().rpc("mac_worker_can_access", {
    p_token_id: token_id,
    p_tenant_id: tenant_id,
  });
  if (error) return false;
  return data === true;
}

export async function mintToken(
  label: string,
  tenantIds: string[],
): Promise<{ id: string; raw: string }> {
  const raw = generateRawMacToken();
  const salt = randomBytes(16).toString("hex");
  const hash = hashMacToken(raw, salt);
  const prefix = raw.slice(0, PREFIX_LEN);
  const { data, error } = await serviceClient().rpc("mint_mac_worker_token", {
    p_token_hash: hash,
    p_token_salt: salt,
    p_token_prefix: prefix,
    p_label: label,
    p_tenant_ids: tenantIds,
  });
  if (error) throw new Error(`mint_mac_worker_token failed: ${error.message}`);
  return { id: data as string, raw };
}

export async function revokeToken(tokenId: string): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("revoke_mac_worker_token", {
    p_token_id: tokenId,
  });
  if (error) throw new Error(`revoke_mac_worker_token failed: ${error.message}`);
  return data === true;
}
