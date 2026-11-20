
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { isTenantAdminOrOwner } from "@/services/auth/members";
import { serverClientFromBearer } from "@/services/supabase";
import { asTenantId, globalClient, tenantRpc } from "@/services/tenant-client";
import { getCatalog } from "@/services/tools/operator-db/catalog";
import {
  checkStoredLogin,
  checkVisibilityNames,
  readDbRetention,
  readDbSetup,
  readDbVisibility,
  revokeCommandFor,
  type DbVisibility,
} from "@/services/data-gateway";
import { readDbConfig } from "@/services/data-gateway/resolve";
import { publishRevoke } from "@/services/data-gateway/connector/wakeup";
import { resolveInviteSender, sgSend } from "@/email/sendAuthEmail";
import { renderDatabaseRequestAccessEmail } from "@/email/templates/database-request-access";
import { webOrigin } from "@/email/theme";

export const DEFAULT_PROVIDER_LINE = "Never used for training · Kept up to 30 days for safety checks";
const DEFAULT_PROVIDERS = ["Anthropic", "OpenAI"];

function notAdmin(res: Response): void {
  res.status(403).json({ error: { code: "not_admin", message: "Only owners and admins can change how Zavi uses your database." } });
}

async function adminAuth(req: Request, res: Response): Promise<AuthedRequest | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (!(await isTenantAdminOrOwner(serverClientFromBearer(auth.access_token), auth.user_id, auth.tenant_id))) {
    notAdmin(res);
    return null;
  }
  return auth;
}

function catalogChanged(res: Response): void {
  res.status(409).json({ error: { code: "operator_db_catalog_changed", message: "Your database changed, review again." } });
}

function rpcFailed(res: Response, error: { code?: string | null }, what: string): void {
  if (error.code === "42501") return notAdmin(res);
  if (error.code === "ZD409") return catalogChanged(res);
  if (error.code === "P0002") {
    res.status(409).json({ error: { code: "operator_db_not_connected", message: "Your database is not connected." } });
    return;
  }
  console.error(`operator_db_${what}_failed`, { error_code: error.code ?? null });
  res.status(500).json({ error: { code: `operator_db_${what}_failed`, message: "Could not save. Try again." } });
}

export async function operatorDbSetup(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json(await readDbSetup(auth.tenant_id));
  } catch {
    res.status(500).json({ error: { code: "operator_db_setup_unavailable", message: "Could not load your database status." } });
  }
}

export async function operatorDbVisibilityGet(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  let view: DbVisibility | null;
  try {
    view = await readDbVisibility(auth.tenant_id);
  } catch {
    res.status(500).json({ error: { code: "operator_db_visibility_unavailable", message: "Could not load what Zavi can see." } });
    return;
  }
  if (!view) {
    res.status(409).json({ error: { code: "operator_db_not_connected", message: "Your database is not connected." } });
    return;
  }
  let read_only: string | null = null;
  if (req.query?.check === "1") {
    read_only = await checkStoredLogin({
      tenant_id: auth.tenant_id,
      caller: { kind: "person", user_id: auth.user_id, feature: "Connection test" },
    }).catch(() => null);
  }
  res.json({ ...view, read_only });
}

const NAME = z.string().min(1).max(512);
const visibilitySchema = z.object({
  catalog_hash: z.string().min(1).max(256),
  disabled_tables: z.array(NAME).max(2000),
  hidden_fields: z.array(NAME).max(5000),
  unhidden_fields: z.array(NAME).max(5000),
});

export async function operatorDbVisibilityPut(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  const parsed = visibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "Invalid settings." } });
    return;
  }
  const cat = await getCatalog(auth.tenant_id);
  if (!cat || cat.discovery_error || cat.catalog.tables.length === 0) {
    res.status(409).json({ error: { code: "operator_db_not_discovered", message: "Zavi is still reading your tables. Try again in a minute." } });
    return;
  }
  if (cat.catalog_hash !== parsed.data.catalog_hash) return catalogChanged(res);
  const unknown = checkVisibilityNames(cat, parsed.data);
  if (unknown) {
    res.status(400).json({ error: { code: "unknown_name", message: `Zavi did not find "${unknown.slice(0, 120)}" in your database.` } });
    return;
  }
  const { error } = await serverClientFromBearer(auth.access_token).rpc("set_db_visibility", {
    p_tenant_id: auth.tenant_id,
    p_catalog_hash: parsed.data.catalog_hash,
    p_disabled_tables: parsed.data.disabled_tables,
    p_hidden_fields: parsed.data.hidden_fields,
    p_unhidden_fields: parsed.data.unhidden_fields,
  });
  if (error) return rpcFailed(res, error, "visibility");
  res.json({ ok: true });
}

type Provider = { name: string; line: string };

export async function readProviderLines(): Promise<Provider[]> {
  const fallback = DEFAULT_PROVIDERS.map((name) => ({ name, line: DEFAULT_PROVIDER_LINE }));
  try {
    const { data, error } = await globalClient().from("system_config").select("blob").eq("id", 1).maybeSingle();
    if (error || !data) return fallback;
    const raw = ((data as { blob?: Record<string, unknown> }).blob ?? {}).ai_provider_policy;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
    if (Array.isArray(raw)) {
      const out = raw
        .map((p) => (p && typeof p === "object" ? { name: str((p as Provider).name), line: str((p as Provider).line) } : null))
        .filter((p): p is Provider => Boolean(p?.name && p.line));
      return out.length ? out : fallback;
    }
    if (raw && typeof raw === "object") {
      const map = raw as Record<string, unknown>;
      return DEFAULT_PROVIDERS.map((name) => ({ name, line: str(map[name]) ?? str(map[name.toLowerCase()]) ?? DEFAULT_PROVIDER_LINE }));
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export async function operatorDbPrivacyGet(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  let row: Awaited<ReturnType<typeof readDbConfig>>;
  let retention: Awaited<ReturnType<typeof readDbRetention>>;
  try {
    [row, retention] = await Promise.all([readDbConfig(auth.tenant_id), readDbRetention(auth.tenant_id)]);
  } catch {
    res.status(500).json({ error: { code: "operator_db_privacy_unavailable", message: "Could not load privacy settings." } });
    return;
  }
  if (!row) {
    res.status(409).json({ error: { code: "operator_db_not_connected", message: "Your database is not connected." } });
    return;
  }
  res.json({
    raw_results_retention: retention.raw_results_retention,
    chat_retention: retention.chat_retention,
    providers: await readProviderLines(),
  });
}

const privacySchema = z.object({
  raw_results_retention: z.enum(["run", "7", "30"]),
  chat_retention: z.enum(["forever", "90", "30"]),
});

export async function operatorDbPrivacyPut(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  const parsed = privacySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: "Invalid privacy settings." } });
    return;
  }
  const { error } = await serverClientFromBearer(auth.access_token).rpc("set_db_privacy", {
    p_tenant_id: auth.tenant_id,
    p_raw_results_retention: parsed.data.raw_results_retention,
    p_chat_retention: parsed.data.chat_retention,
  });
  if (error) return rpcFailed(res, error, "privacy");
  res.json({ ok: true });
}

export async function operatorDbDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await adminAuth(req, res);
  if (!auth) return;
  const { data, error } = await serverClientFromBearer(auth.access_token).rpc("disconnect_operator_db", {
    p_tenant_id: auth.tenant_id,
  });
  if (error) return rpcFailed(res, error, "disconnect");
  await publishRevoke(auth.tenant_id).catch(() => undefined);
  const out = (data ?? {}) as { dialect?: string | null; managed_by?: string | null };
  const dialect = out.dialect ?? null;
  const managed_by = out.managed_by ?? null;
  res.json({ ok: true, dialect, managed_by, revoke_command: revokeCommandFor(dialect, managed_by) });
}

export async function databaseRequestAccess(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (await isTenantAdminOrOwner(serverClientFromBearer(auth.access_token), auth.user_id, auth.tenant_id)) {
    res.status(400).json({ error: { code: "already_admin", message: "You can connect your database yourself." } });
    return;
  }
  const tid = asTenantId(auth.tenant_id);
  const { data: emails, error: emailErr } = await tenantRpc(tid, "tenant_admin_emails", {});
  const to = Array.isArray(emails) ? (emails as unknown[]).filter((e): e is string => typeof e === "string" && e.includes("@")) : [];
  if (emailErr || to.length === 0) {
    res.status(500).json({ error: { code: "request_access_failed", message: "Could not send the request. Try again." } });
    return;
  }
  const { data: claimed, error: claimErr } = await tenantRpc(tid, "claim_db_access_request", { p_user_id: auth.user_id });
  if (claimErr) {
    res.status(500).json({ error: { code: "request_access_failed", message: "Could not send the request. Try again." } });
    return;
  }
  if (claimed !== true) {
    res.json({ ok: true, sent: false, already_requested: true });
    return;
  }
  const sender = await resolveInviteSender(auth.tenant_id, auth.user_id);
  const rendered = renderDatabaseRequestAccessEmail({
    requesterLabel: sender.inviterLabel,
    requesterEmail: sender.inviterEmail,
    link: `${webOrigin()}/workspace?tab=brain#integrations`,
  });
  let sent = 0;
  for (const addr of to) {
    try {
      await sgSend(addr, rendered.subject, rendered.html, rendered.text, undefined, { noTracking: true });
      sent += 1;
    } catch (e) {
      console.warn("database_request_access_send_failed", { tenant_id: auth.tenant_id, error: (e as Error).name });
    }
  }
  res.json({ ok: true, sent: sent > 0, already_requested: false });
}
