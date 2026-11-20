
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { loadTenantRole, requireTenantRole } from "@/services/auth/tenant-role";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { mintChatLinkToken } from "@/services/connectors/chat-link-route";
import { bindPrefill } from "@/services/connectors/bind-code";
import { imessageEnabled, sendblueEnv } from "@/services/connectors/imessage/sendblue";
import { maskHandle } from "@/services/connectors/imessage/handle";
import { logEvent } from "@/services/logging/logEvent";

const ADMIN = ["owner", "admin"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIRM_CODES = new Set(["no_pending", "bad_code", "expired", "too_many_attempts"]);

export function imessageLink(line: string, prefill: string): string {
  return `sms:${line}&body=${encodeURIComponent(prefill)}`;
}

export async function imessageStatus(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const configured = imessageEnabled();
  let threads = 0;
  let pending = 0;
  let handsets: Array<{ id: string; number: string }> = [];
  if (configured) {
    const tc = tenantClient(asTenantId(auth.tenant_id));
    const [{ count: enabledCount }, { count: pendingCount }] = await Promise.all([
      tc.from("imessage_threads").select("id", { count: "exact", head: true }).eq("status", "enabled"),
      tc.from("imessage_threads").select("id", { count: "exact", head: true }).eq("status", "pending"),
    ]);
    threads = enabledCount ?? 0;
    pending = pendingCount ?? 0;
    const role = threads > 0 ? await loadTenantRole(auth) : null;
    if (role && (ADMIN as readonly string[]).includes(role)) {
      const { data } = await tc
        .from("imessage_threads")
        .select("id, handle")
        .eq("status", "enabled")
        .order("created_at", { ascending: true })
        .limit(50);
      handsets = ((data ?? []) as Array<{ id: string; handle: string }>).map((r) => ({
        id: String(r.id),
        number: maskHandle(String(r.handle)),
      }));
    }
  }
  res.json({ configured, connected: threads > 0, threads, pending, handsets });
}

export async function imessageLinkRoute(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const env = sendblueEnv();
  if (!env) {
    res.status(503).json({ error: { code: "imessage_disabled" } });
    return;
  }
  const minted = await mintChatLinkToken(auth, res, {
    slug: "imessage",
    rpc: "create_imessage_link_token",
    liveRpc: "live_imessage_link_token",
    fresh: (req.body as { fresh?: unknown } | undefined)?.fresh === true,
  });
  if (!minted) return;
  const prefill = bindPrefill(minted.token);
  res.json({
    ok: true,
    imessage_url: imessageLink(env.line, prefill),
    prefill,
    line: env.line,
    expires_in: minted.expires_in,
  });
}

export async function imessageConfirm(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!imessageEnabled()) {
    res.status(503).json({ error: { code: "imessage_disabled" } });
    return;
  }
  if (!(await requireTenantRole(auth, ADMIN, res))) return;

  const code = String((req.body as { code?: unknown } | undefined)?.code ?? "").trim();
  if (!code) {
    res.status(400).json({ error: { code: "code_required" } });
    return;
  }
  const { data: status, error } = await tenantRpc(asTenantId(auth.tenant_id), "confirm_imessage_bind", {
    p_confirm_code: code,
  });
  if (error) {
    console.warn("[imessage-confirm] confirm_imessage_bind failed:", error.message);
    res.status(500).json({ error: { code: "confirm_failed" } });
    return;
  }
  const result = String(status ?? "unknown");
  await logEvent({
    level: result === "ok" ? "info" : "warn",
    source: "connectors.imessage.confirm",
    code: `imessage_bind_${result === "ok" ? "confirmed" : CONFIRM_CODES.has(result) ? result : "unknown"}`,
    tenant_id: auth.tenant_id,
    meta: { actor_user_id: auth.user_id },
  }).catch(() => {});
  if (result === "ok") {
    res.json({ ok: true });
    return;
  }
  res.status(400).json({ error: { code: CONFIRM_CODES.has(result) ? result : "confirm_failed" } });
}

export async function imessageDisconnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, ADMIN, res))) return;
  const tid = asTenantId(auth.tenant_id);

  const raw = (req.body as { thread_id?: unknown } | undefined)?.thread_id;
  if (raw !== undefined && raw !== null && raw !== "") {
    const threadId = String(raw).trim();
    if (!UUID_RE.test(threadId)) {
      res.status(400).json({ error: { code: "thread_id_invalid" } });
      return;
    }
    const { data, error } = await tenantRpc(tid, "unset_imessage_thread", { p_thread_id: threadId });
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
      source: "connectors.imessage.disconnect",
      code: "imessage_thread_disconnected",
      tenant_id: auth.tenant_id,
      meta: { actor_user_id: auth.user_id, threads_left: left },
    }).catch(() => {});
    res.json({ ok: true, connected: left > 0, threads: left });
    return;
  }

  const { data, error } = await tenantRpc(tid, "unset_imessage_connection", {});
  if (error) {
    res.status(500).json({ error: { code: "rpc_failed", message: error.message } });
    return;
  }
  await logEvent({
    level: "info",
    source: "connectors.imessage.disconnect",
    code: "imessage_disconnected",
    tenant_id: auth.tenant_id,
    meta: { actor_user_id: auth.user_id, threads: Number(data ?? 0) },
  }).catch(() => {});
  res.json({ ok: true, connected: false, threads: 0 });
}
