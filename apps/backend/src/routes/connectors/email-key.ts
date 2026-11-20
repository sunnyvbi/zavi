
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { tenantRpc } from "@/services/tenant-client";
import { serverClientFromBearer } from "@/services/supabase";
import {
  checkSendgridKey,
  SENDGRID_GROUP_LABEL,
  SENDGRID_GROUPS,
  type SendgridKeyCheck,
} from "@/services/connectors/email-campaign/sendgrid-scopes";
import { resolveSendgridAccount } from "@/services/connectors/email-campaign/sendgrid-account";

const ADMIN_ROLES = ["owner", "admin"] as const;

function refuseOverride(auth: { tenant_overridden?: boolean }, res: Response): boolean {
  if (auth.tenant_overridden !== true) return false;
  res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
  return true;
}

const bodySchema = z.object({
  api_key: z
    .string({ message: "Paste your SendGrid API key." })
    .trim()
    .min(20, { message: "That does not look like a SendGrid API key. It starts with SG." })
    .max(200, { message: "That does not look like a SendGrid API key. It starts with SG." })
    .regex(/^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, { message: "That does not look like a SendGrid API key. It starts with SG." }),
});

export type EmailKeyDeps = {
  checkKey: (apiKey: string) => Promise<SendgridKeyCheck>;
  existingCampaignReady?: (tenantId: string) => Promise<boolean>;
};
export async function savedCampaignKeyWorks(
  tenantId: string,
  checkKey: (apiKey: string) => Promise<SendgridKeyCheck> = (k) => checkSendgridKey(k),
  resolve: typeof resolveSendgridAccount = resolveSendgridAccount,
): Promise<boolean> {
  const account = await resolve(tenantId);
  if (!account) return false;
  const check = await checkKey(account.api_key);
  if (check.status === "unreachable") throw new Error("sendgrid_unreachable");
  return check.status === "ok" && check.campaign_ready;
}

const DEFAULT_DEPS: EmailKeyDeps = {
  checkKey: (k) => checkSendgridKey(k),
  existingCampaignReady: (tenantId) => savedCampaignKeyWorks(tenantId),
};

export function emailKeyConnectWith(deps: EmailKeyDeps) {
  return (req: Request, res: Response): Promise<void> => connect(req, res, deps);
}

export const emailKeyConnect = emailKeyConnectWith(DEFAULT_DEPS);

async function connect(req: Request, res: Response, deps: EmailKeyDeps): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || refuseOverride(auth, res)) return;
  if (!(await requireTenantRole(auth, ADMIN_ROLES, res, "Only a workspace owner or admin can connect SendGrid. Ask one of them to connect it."))) return;

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.issues[0]?.message ?? "Paste your SendGrid API key." } });
    return;
  }
  const apiKey = parsed.data.api_key;

  const check = await deps.checkKey(apiKey);
  if (check.status === "invalid") {
    console.error("sendgrid_connect_key_rejected", { tenant_id: auth.tenant_id });
    res.status(400).json({
      error: {
        code: "sendgrid_key_invalid",
        message: "SendGrid did not accept this key. Check you copied the whole key, and that it has not been deleted in SendGrid (Settings, API Keys). Your existing connection, if any, is unchanged.",
      },
    });
    return;
  }
  if (check.status === "unreachable") {
    console.error("sendgrid_connect_unreachable", { tenant_id: auth.tenant_id });
    res.status(502).json({
      error: { code: "sendgrid_unreachable", message: "Zavi could not reach SendGrid to check this key. Nothing was saved. Try again in a minute." },
    });
    return;
  }
  if (!check.groups.mail_send) {
    res.status(400).json({
      error: {
        code: "sendgrid_key_no_mail_send",
        message: "This SendGrid key cannot send mail (it is missing the Mail Send permission). Zavi uses the same key for every email, so add Mail Send in SendGrid and paste it again. Nothing was saved; your existing connection, if any, is unchanged.",
      },
    });
    return;
  }
  if (!check.campaign_ready) {
    let existing = false;
    try {
      existing = deps.existingCampaignReady ? await deps.existingCampaignReady(auth.tenant_id) : false;
    } catch {
      res.status(503).json({
        error: {
          code: "sendgrid_connection_unreadable",
          message: "Zavi could not confirm the current SendGrid connection, so nothing was changed. Try again in a minute.",
        },
      });
      return;
    }
    if (existing) {
      res.status(409).json({
        error: {
          code: "sendgrid_campaign_downgrade",
          message: `This key is missing campaign permissions: ${check.missing.map((g) => SENDGRID_GROUP_LABEL[g]).join(", ")}. Your existing campaign-ready key still works and was kept unchanged. To use this key instead, disconnect SendGrid in Connectors first, then paste it again.`,
        },
      });
      return;
    }
  }

  const { error } = await tenantRpc(auth.tenant_id, "set_sendgrid_connection", {
    p_api_key: apiKey,
    p_scopes: check.groups,
  });
  if (error) {
    console.error("sendgrid_connect_failed", { tenant_id: auth.tenant_id, error_code: (error as { code?: string }).code ?? null });
    res.status(500).json({ error: { code: "sendgrid_connect_failed", message: "Could not save the SendGrid connection. Your existing connection, if any, is unchanged. Try again." } });
    return;
  }

  if (check.campaign_ready) {
    void import("@/services/email-learnings/seed").then((m) => m.requestSeed(auth.tenant_id)).catch(() => undefined);
  }

  res.status(200).json({
    ok: true,
    provider: "sendgrid",
    groups: check.groups,
    campaign_ready: check.campaign_ready,
    missing: check.missing.map((g) => ({ group: g, label: SENDGRID_GROUP_LABEL[g] })),
    permissions: SENDGRID_GROUPS.map((g) => ({ group: g, label: SENDGRID_GROUP_LABEL[g], passed: check.groups[g] === true })),
    message: check.campaign_ready
      ? "SendGrid is connected. Every permission email campaigns need passed."
      : `SendGrid is connected for one-to-one email. Needs more permissions for campaigns: ${check.missing.map((g) => SENDGRID_GROUP_LABEL[g]).join(", ")}.`,
  });
}

export async function emailKeyDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth || refuseOverride(auth, res)) return;
  if (!(await requireTenantRole(auth, ADMIN_ROLES, res, "Only a workspace owner or admin can disconnect SendGrid. Ask one of them to do it."))) return;

  const { error } = await serverClientFromBearer(auth.access_token).rpc("disconnect_connector", {
    p_tenant_id: auth.tenant_id,
    p_slug: "email",
    p_server_id: "email",
  });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      res.status(403).json({ error: { code: "not_admin", message: "Only a workspace owner or admin can disconnect SendGrid. Ask one of them to do it." } });
      return;
    }
    console.error("sendgrid_disconnect_failed", { tenant_id: auth.tenant_id, error_code: code ?? null });
    res.status(500).json({ error: { code: "sendgrid_disconnect_failed", message: "Could not disconnect SendGrid. Try again." } });
    return;
  }
  res.status(200).json({ ok: true });
}
