
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import { openSitePreviewSession } from "@/services/sandbox/browser-mcp/anchor-backend";
import { closeBrowserSession } from "@/services/sandbox/browser-mcp/browser-sessions";
import { deleteAnchorSessionById } from "@/services/sandbox/browser-mcp/anchor-rest-client";
import {
  engineerSitePreviewEnabled,
  validateSitePreviewUrl,
  rememberPreviewCdp,
  forgetPreviewCdp,
} from "@/services/sandbox/engineer-site-preview";

async function deriveSessionRow(
  session_id: string,
): Promise<{ tenant_id: string; provider_session_id: string | null } | null> {
  const sb = serviceClient();
  const { data } = await sb
    .from("browser_sessions")
    .select("tenant_id, provider_session_id")
    .eq("id", session_id)
    .maybeSingle<{ tenant_id: string; provider_session_id: string | null }>();
  return data ?? null;
}

export async function openEngineerSitePreview(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!(await engineerSitePreviewEnabled(auth.tenant_id))) {
    res.status(403).json({
      error: { code: "disabled", message: "Live site preview is disabled for this tenant." },
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const check = validateSitePreviewUrl(body.url);
  if (!check.ok) {
    res.status(400).json({
      error: { code: "bad_url", message: `URL rejected (${check.reason}).` },
    });
    return;
  }

  const opened = await openSitePreviewSession({
    tenant_id: auth.tenant_id,
    url: check.url.toString(),
  });
  if (!opened.ok) {
    const status =
      opened.error_code === "anchor_budget_exceeded"
        ? 429
        : opened.error_code === "anchor_not_configured"
          ? 503
          : 502;
    res.status(status).json({
      error: { code: opened.error_code, message: opened.error_message },
    });
    return;
  }

  if (opened.cdp_url) {
    rememberPreviewCdp(opened.session_id, auth.tenant_id, opened.cdp_url);
  }

  res.setHeader("Cache-Control", "no-store");
  res
    .status(200)
    .json({ session_id: opened.session_id, live_view_url: opened.live_view_url });
}

export async function closeEngineerSitePreview(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sessionId = String(req.params.sessionId ?? "");
  if (!sessionId) {
    res.status(400).json({ error: { code: "bad_session", message: "missing session id" } });
    return;
  }

  const row = await deriveSessionRow(sessionId);
  if (!row) {
    res.status(200).json({ ok: true, closed: false });
    return;
  }
  if (row.tenant_id !== auth.tenant_id) {
    res.status(403).json({ error: { code: "forbidden", message: "not your session" } });
    return;
  }

  const apiKey = process.env.ANCHOR_API_KEY;
  if (apiKey && row.provider_session_id) {
    await deleteAnchorSessionById(apiKey, row.provider_session_id).catch(() => {
    });
  }
  await closeBrowserSession({ session_id: sessionId, reason: "preview_closed" }).catch(() => {
  });
  forgetPreviewCdp(sessionId);

  res.status(200).json({ ok: true, closed: true });
}
