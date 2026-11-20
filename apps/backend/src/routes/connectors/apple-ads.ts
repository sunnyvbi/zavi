
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { tenantRpc } from "@/services/tenant-client";
import { appleAccessToken } from "@/services/connectors/apple-ads/http";
import { listAppleAdAccountsRaw } from "@/services/connectors/apple-ads/client";
import { ExpectedToolError } from "@/services/tools/types";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const connectSchema = z.object({
  client_id: z.string().regex(/^SEARCHADS\.[0-9a-fA-F-]{36}$/, "client_id must look like SEARCHADS.<uuid>"),
  team_id: z.string().min(3).max(128),
  key_id: z.string().min(3).max(128),
  private_key_pem: z
    .string()
    .min(100)
    .max(8192)
    .refine((s) => s.includes("-----BEGIN") && s.includes("PRIVATE KEY-----"), "private_key_pem must be a PEM private key"),
  refresh_token: z.string().min(10).max(4096).optional(),
});

export async function appleAdsConnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_input", message: parsed.error.issues[0]?.message ?? "invalid input" } });
    return;
  }
  const b = parsed.data;
  const creds = { clientId: b.client_id, teamId: b.team_id, keyId: b.key_id, privateKeyPem: b.private_key_pem, refreshToken: b.refresh_token };

  let accounts;
  try {
    const token = await appleAccessToken(creds, "");
    accounts = await listAppleAdAccountsRaw(token);
  } catch (e) {
    const msg = e instanceof ExpectedToolError ? e.message : "Apple rejected these credentials (check the .p8 key, key id, team id and client id).";
    res.status(400).json({ error: { code: "apple_ads_invalid_credentials", message: msg } });
    return;
  }

  const first = accounts[0];
  const label = first
    ? `${first.name}${accounts.length > 1 ? ` (+${accounts.length - 1})` : ""}`
    : "Apple Ads (no ad account)";
  const { error } = await tenantRpc(auth.tenant_id, "set_apple_ads_connection", {
    p_client_id: b.client_id,
    p_team_id: b.team_id,
    p_key_id: b.key_id,
    p_private_key_pem: b.private_key_pem,
    p_refresh_token: b.refresh_token ?? null,
    p_team_label: label,
  });
  if (error) {
    console.error("[connectors/apple_ads] set_apple_ads_connection failed", { tenant_id: auth.tenant_id });
    res.status(500).json({ error: { code: "store_failed", message: "Could not store the connection." } });
    return;
  }
  void notifyFounderActivity({ event: "first_connector", tenant_id: auth.tenant_id, user_id: auth.user_id, details: { connector: "apple_ads" } });
  res.json({ ok: true, ad_accounts: accounts.length, label });
}
