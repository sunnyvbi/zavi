
import { liveChatLinkToken } from "@/services/connectors/chat-link-route";
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { whatsappEnabled, whatsappEnv } from "@/services/connectors/whatsapp/adapter";
import { bindPrefill, makeLinkToken } from "@/services/connectors/bind-code";
import { handsetDisplayName, maskWaId } from "@/services/connectors/whatsapp/mask";
import { logEvent } from "@/services/logging/logEvent";

const LINK_TTL_SECONDS = 900;

async function requireAdmin(tenantId: string, userId: string): Promise<boolean> {
  const { data: member } = await tenantClient(asTenantId(tenantId))
    .from("tenant_users")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle<{ role: string | null }>();
  return !!member && ["owner", "admin"].includes(String(member.role));
}

type HandsetView = { id: string; name: string | null; number: string };

export async function whatsappStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const configured = whatsappEnabled();
  let threads = 0;
  let pending = 0;
  let handsets: HandsetView[] = [];
  if (configured) {
    const tc = tenantClient(asTenantId(auth.tenant_id));
    const [{ count: enabledCount }, { count: pendingCount }] = await Promise.all([
      tc.from("whatsapp_threads").select("id", { count: "exact", head: true }).eq("status", "enabled"),
      tc.from("whatsapp_threads").select("id", { count: "exact", head: true }).eq("status", "pending"),
    ]);
    threads = enabledCount ?? 0;
    pending = pendingCount ?? 0;

    if (threads > 0 && (await requireAdmin(auth.tenant_id, auth.user_id))) {
      const { data } = await tc
        .from("whatsapp_threads")
        .select("id, wa_id, display_name, created_at")
        .eq("status", "enabled")
        .order("created_at", { ascending: true })
        .limit(50);
      handsets = (
        (data ?? []) as Array<{ id: string; wa_id: string | null; display_name: string | null }>
      )
        .map((r) => ({
          id: String(r.id),
          name: handsetDisplayName(r.display_name),
          number: maskWaId(String(r.wa_id ?? "")),
        }))
        .filter((h) => h.number !== "•••");
    }
  }
  res.json({ configured, connected: threads > 0, threads, pending, handsets });
}

export async function whatsappLink(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!whatsappEnabled()) {
    res.status(503).json({ error: { code: "whatsapp_disabled" } });
    return;
  }
  const env = whatsappEnv()!;
  if (!env.businessNumber) {
    res.status(503).json({ error: { code: "whatsapp_number_missing" } });
    return;
  }
  if (!(await requireAdmin(auth.tenant_id, auth.user_id))) {
    res.status(403).json({ error: { code: "not_admin" } });
    return;
  }

  const fresh = (req.body as { fresh?: unknown } | undefined)?.fresh === true;
  const live = fresh ? null : await liveChatLinkToken(auth, "live_whatsapp_link_token");
  if (live) {
    const prefillLive = bindPrefill(live.token);
    res.json({
      ok: true,
      wa_url: `https://api.whatsapp.com/send?phone=${env.businessNumber}&text=${encodeURIComponent(prefillLive)}`,
      prefill: prefillLive,
      business_number: env.businessNumber,
      expires_in: live.expires_in,
    });
    return;
  }

  const token = makeLinkToken();
  const { error } = await tenantRpc(asTenantId(auth.tenant_id), "create_whatsapp_link_token", {
    p_minted_by: auth.user_id,
    p_token: token,
    p_ttl_seconds: LINK_TTL_SECONDS,
  });
  if (error) {
    console.warn(
      "[whatsapp-link] create_whatsapp_link_token failed for tenant",
      auth.tenant_id,
      error.message,
    );
    res.status(500).json({ error: { code: "link_mint_failed" } });
    return;
  }

  await logEvent({
    level: "info",
    source: "connectors.whatsapp.link",
    code: "whatsapp_link_minted",
    tenant_id: auth.tenant_id,
    meta: { actor_user_id: auth.user_id },
  }).catch(() => {});

  const prefill = bindPrefill(token);
  res.json({
    ok: true,
    wa_url: `https://api.whatsapp.com/send?phone=${env.businessNumber}&text=${encodeURIComponent(prefill)}`,
    prefill,
    business_number: env.businessNumber,
    expires_in: LINK_TTL_SECONDS,
  });
}

export async function whatsappConfirm(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!whatsappEnabled()) {
    res.status(503).json({ error: { code: "whatsapp_disabled" } });
    return;
  }
  if (!(await requireAdmin(auth.tenant_id, auth.user_id))) {
    res.status(403).json({ error: { code: "not_admin" } });
    return;
  }

  const code = String((req.body as { code?: unknown })?.code ?? "").trim();
  if (!code) {
    res.status(400).json({ error: { code: "code_required" } });
    return;
  }

  const { data: status, error } = await tenantRpc(
    asTenantId(auth.tenant_id),
    "confirm_whatsapp_bind",
    { p_confirm_code: code },
  );
  if (error) {
    console.warn("[whatsapp-confirm] confirm_whatsapp_bind failed:", error.message);
    res.status(500).json({ error: { code: "confirm_failed" } });
    return;
  }

  if (status === "ok") {
    await logEvent({
      level: "info",
      source: "connectors.whatsapp.confirm",
      code: "whatsapp_bind_confirmed",
      tenant_id: auth.tenant_id,
      meta: { actor_user_id: auth.user_id },
    }).catch(() => {});
    res.json({ ok: true });
    return;
  }

  const known = new Set(["no_pending", "bad_code", "expired", "too_many_attempts"]);
  const codeStr = String(status ?? "unknown");
  await logEvent({
    level: "warn",
    source: "connectors.whatsapp.confirm",
    code: `whatsapp_bind_${known.has(codeStr) ? codeStr : "unknown"}`,
    tenant_id: auth.tenant_id,
    meta: { actor_user_id: auth.user_id },
  }).catch(() => {});
  res.status(400).json({ error: { code: known.has(codeStr) ? codeStr : "confirm_failed" } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function whatsappDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireAdmin(auth.tenant_id, auth.user_id))) {
    res.status(403).json({ error: { code: "not_admin" } });
    return;
  }

  const rawThreadId = (req.body as { thread_id?: unknown } | undefined)?.thread_id;
  if (rawThreadId !== undefined && rawThreadId !== null && rawThreadId !== "") {
    const threadId = String(rawThreadId).trim();
    if (!UUID_RE.test(threadId)) {
      res.status(400).json({ error: { code: "thread_id_invalid" } });
      return;
    }
    const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "unset_whatsapp_thread", {
      p_thread_id: threadId,
    });
    if (error) {
      res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
      return;
    }
    if (data === null || data === undefined) {
      res.status(404).json({ error: { code: "thread_not_found" } });
      return;
    }
    const left = Number(data);
    await logEvent({
      level: "info",
      source: "connectors.whatsapp.disconnect",
      code: "whatsapp_thread_disconnected",
      tenant_id: auth.tenant_id,
      meta: { actor_user_id: auth.user_id, threads_left: left },
    }).catch(() => {});
    res.json({ ok: true, connected: left > 0, threads: left });
    return;
  }

  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "unset_whatsapp_connection", {});
  if (error) {
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }

  await logEvent({
    level: "info",
    source: "connectors.whatsapp.disconnect",
    code: "whatsapp_disconnected",
    tenant_id: auth.tenant_id,
    meta: { actor_user_id: auth.user_id, threads: Number(data ?? 0) },
  }).catch(() => {});

  res.json({ ok: true, connected: false, threads: 0 });
}
