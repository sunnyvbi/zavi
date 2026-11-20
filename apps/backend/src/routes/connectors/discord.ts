
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { logEvent } from "@/services/logging/logEvent";
import { discordEnabled, discordInstallUrl } from "@/services/connectors/discord/adapter";
import { mintChatLinkToken } from "@/services/connectors/chat-link-route";

export async function discordStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const configured = discordEnabled();
  let connected = false;
  if (configured) {
    const { data } = await tenantClient(asTenantId(auth.tenant_id))
      .from("discord_guilds")
      .select("status")
      .eq("status", "enabled")
      .maybeSingle<{ status: string }>();
    connected = !!data;
  }
  res.json({ configured, connected });
}

export async function discordLink(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!discordEnabled()) {
    res.status(503).json({ error: { code: "discord_disabled" } });
    return;
  }

  const minted = await mintChatLinkToken(auth, res, {
    slug: "discord",
    rpc: "create_discord_link_token",
    liveRpc: "live_discord_link_token",
    fresh: (req.body as { fresh?: unknown } | undefined)?.fresh === true,
  });
  if (!minted) return;
  const { token } = minted;

  res.json({
    ok: true,
    connect_command: `@Zavi connect ${token}`,
    install_url: discordInstallUrl(),
    expires_in: minted.expires_in,
  });
}

export async function discordDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;

  const { error } = await tenantRpc(
    asTenantId(auth.tenant_id),
    "unset_discord_connection_for_tenant",
  );
  if (error) {
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  await logEvent({
    level: "info",
    source: "connectors.discord.disconnect",
    code: "discord_disconnected",
    tenant_id: auth.tenant_id,
    meta: { actor_user_id: auth.user_id },
  }).catch(() => {});

  res.json({ ok: true, connected: false });
}
