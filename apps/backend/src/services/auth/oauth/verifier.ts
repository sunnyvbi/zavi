
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { asTenantId, type TenantId } from "@/services/tenant-client";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { serviceClient } from "@/services/supabase";
import {
  resolveCallerFromPat,
  _verifyHashConstantTime,
  isPatToken,
} from "@/services/auth/pat";
import { MCP_RESOURCE, OAT_PREFIX, PREFIX_LOOKUP_LEN } from "./tokens";
import { readTenantDisabled, TENANT_DISABLED_MESSAGE } from "@/services/tenants/disabled";

export class TenantDisabledTokenError extends InvalidTokenError {
  constructor() {
    super(TENANT_DISABLED_MESSAGE);
  }
}

const MAX_PREFIX_CANDIDATES = 5;

export type McpCaller = {
  user_id: string;
  tenant_id: TenantId;
  scopes: string[];
  credential_kind: "pat" | "oauth";
  pat_id: string | null;
  oauth_access_token_id: string | null;
};

export function authInfoToCaller(auth: AuthInfo): McpCaller {
  const extra = (auth.extra ?? {}) as Record<string, unknown>;
  return {
    user_id: extra.user_id as string,
    tenant_id: asTenantId(extra.tenant_id as string),
    scopes: auth.scopes ?? [],
    credential_kind: (extra.credential_kind as "pat" | "oauth") ?? "oauth",
    pat_id: (extra.pat_id as string | null) ?? null,
    oauth_access_token_id: (extra.oauth_access_token_id as string | null) ?? null,
  };
}

async function verifyOat(raw: string): Promise<AuthInfo> {
  const sb = serviceClient();
  const prefix = raw.slice(0, PREFIX_LOOKUP_LEN);
  const { data: rows, error } = await sb
    .from("oauth_access_tokens")
    .select("id,user_id,tenant_id,token_hash,token_salt,scopes,resource,expires_at,revoked_at,client_id")
    .eq("token_prefix", prefix)
    .is("revoked_at", null);
  if (error) throw new InvalidTokenError("token lookup failed");
  if (!rows || rows.length === 0) throw new InvalidTokenError("invalid token");
  if (rows.length > MAX_PREFIX_CANDIDATES) {
    throw new InvalidTokenError("invalid token");
  }

  const match = rows.find((r) =>
    _verifyHashConstantTime(raw, r.token_salt as string, r.token_hash as string),
  );
  if (!match) throw new InvalidTokenError("invalid token");
  if (match.revoked_at) throw new InvalidTokenError("token revoked");
  if (new Date(match.expires_at as string) < new Date()) {
    throw new InvalidTokenError("token expired");
  }
  if ((match.resource as string) !== MCP_RESOURCE) {
    throw new InvalidTokenError("token audience mismatch");
  }

  const { data: mem, error: mErr } = await sb
    .from("tenant_users")
    .select("tenant_id")
    .eq("user_id", match.user_id as string)
    .eq("tenant_id", match.tenant_id as string)
    .maybeSingle();
  if (mErr || !mem) throw new InvalidTokenError("tenant membership revoked");

  return {
    token: raw,
    clientId: match.client_id as string,
    scopes: (match.scopes as string[]) ?? [],
    expiresAt: Math.floor(new Date(match.expires_at as string).getTime() / 1000),
    resource: new URL(MCP_RESOURCE),
    extra: {
      tenant_id: mem.tenant_id as string,
      user_id: match.user_id as string,
      credential_kind: "oauth",
      oauth_access_token_id: match.id as string,
      pat_id: null,
    },
  };
}

export async function verifyAccessToken(raw: string): Promise<AuthInfo> {
  const auth = await verifyToken(raw);
  const disabled = await readTenantDisabled(String(auth.extra?.tenant_id));
  if (disabled === null) throw new ServerError("workspace check unavailable");
  if (disabled) throw new TenantDisabledTokenError();
  return auth;
}

async function verifyToken(raw: string): Promise<AuthInfo> {
  if (raw.startsWith(OAT_PREFIX)) {
    return verifyOat(raw);
  }
  if (isPatToken(raw)) {
    try {
      const c = await resolveCallerFromPat(raw);
      return {
        token: raw,
        clientId: "praxis-pat",
        scopes: c.scopes,
        resource: new URL(MCP_RESOURCE),
        extra: {
          tenant_id: c.tenant_id,
          user_id: c.user_id,
          credential_kind: "pat",
          pat_id: c.pat_id,
          oauth_access_token_id: null,
        },
      };
    } catch {
      throw new InvalidTokenError("invalid token");
    }
  }
  throw new InvalidTokenError("invalid token");
}
