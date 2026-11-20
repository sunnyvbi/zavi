
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { telegramEnabled, telegramEnv } from "@/services/connectors/telegram/adapter";
import { mintChatLinkToken } from "@/services/connectors/chat-link-route";

export async function telegramStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const configured = telegramEnabled();
  let chats = 0;
  if (configured) {
    const { count } = await tenantClient(asTenantId(auth.tenant_id))
      .from("telegram_chats")
      .select("id", { count: "exact", head: true })
      .eq("status", "enabled");
    chats = count ?? 0;
  }
  res.json({ configured, connected: chats > 0, chats });
}

export async function telegramLink(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!telegramEnabled()) {
    res.status(503).json({ error: { code: "telegram_disabled" } });
    return;
  }
  const env = telegramEnv();
  if (!env?.botUsername) {
    res.status(503).json({ error: { code: "telegram_username_missing" } });
    return;
  }

  const minted = await mintChatLinkToken(auth, res, {
    slug: "telegram",
    rpc: "create_telegram_link_token",
    liveRpc: "live_telegram_link_token",
    fresh: (req.body as { fresh?: unknown } | undefined)?.fresh === true,
  });
  if (!minted) return;
  const { token } = minted;

  res.json({
    ok: true,
    dm_url: `https://t.me/${env.botUsername}?start=${token}`,
    group_url: `https://t.me/${env.botUsername}?startgroup=${token}`,
    expires_in: minted.expires_in,
  });
}

export async function telegramDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "unset_telegram_connection", {
    p_chat_id: null,
  });
  if (error) {
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  await logEvent({
    level: "info",
    source: "connectors.telegram.disconnect",
    code: "telegram_disconnected",
    tenant_id: auth.tenant_id,
    meta: { actor_user_id: auth.user_id, chats: Number(data ?? 0) },
  }).catch(() => {});

  res.json({ ok: true, connected: false });
}
