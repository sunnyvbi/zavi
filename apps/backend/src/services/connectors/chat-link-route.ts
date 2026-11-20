
import type { Response } from "express";
import type { AuthedRequest } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { makeLinkToken } from "@/services/connectors/bind-code";
import { logEvent } from "@/services/logging/logEvent";

export const LINK_TTL_SECONDS = 900;

export const MIN_REUSE_SECONDS = 300;

export async function liveChatLinkToken(
  auth: AuthedRequest,
  liveRpc: string,
): Promise<{ token: string; expires_in: number } | null> {
  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), liveRpc, { p_minted_by: auth.user_id, p_min_seconds: MIN_REUSE_SECONDS });
  if (error) {
    console.warn(`[chat-link] ${liveRpc} failed for tenant`, auth.tenant_id, error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { token?: string; expires_in?: number } | null | undefined;
  return row?.token && typeof row.expires_in === "number" ? { token: row.token, expires_in: row.expires_in } : null;
}

export async function mintChatLinkToken(
  auth: AuthedRequest,
  res: Response,
  opts: { slug: string; rpc: string; liveRpc: string; fresh: boolean },
): Promise<{ token: string; expires_in: number } | null> {
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return null;

  if (!opts.fresh) {
    const live = await liveChatLinkToken(auth, opts.liveRpc);
    if (live) return live;
  }

  const token = makeLinkToken();
  const { error } = await tenantRpc(asTenantId(auth.tenant_id), opts.rpc, {
    p_minted_by: auth.user_id,
    p_token: token,
    p_ttl_seconds: LINK_TTL_SECONDS,
  });
  if (error) {
    console.warn(`[${opts.slug}-link] ${opts.rpc} failed for tenant`, auth.tenant_id, error.message);
    res.status(500).json({ error: { code: "link_mint_failed" } });
    return null;
  }

  await logEvent({
    level: "info",
    source: `connectors.${opts.slug}.link`,
    code: `${opts.slug}_link_minted`,
    tenant_id: auth.tenant_id,
    meta: { actor_user_id: auth.user_id },
  }).catch(() => {});

  return { token, expires_in: LINK_TTL_SECONDS };
}
