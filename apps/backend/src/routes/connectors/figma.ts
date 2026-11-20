
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { tenantRpc } from "@/services/tenant-client";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const PROBE_TIMEOUT_MS = 15_000;
const FIGMA_API_BASE = "https://api.figma.com";

const connectSchema = z.object({
  api_key: z.string().trim().min(20).max(500),
});

type MeProbeResult = { ok: true; handle: string | null; email: string | null } | "unauthorized" | "error";

async function probeToken(apiKey: string): Promise<MeProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${FIGMA_API_BASE}/v1/me`, {
      headers: { "X-Figma-Token": apiKey },
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status === 401 || res.status === 403) return "unauthorized";
    if (!res.ok) return "error";
    const body = (await res.json()) as { handle?: unknown; email?: unknown };
    return {
      ok: true,
      handle: typeof body.handle === "string" ? body.handle : null,
      email: typeof body.email === "string" ? body.email : null,
    };
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}

export async function figmaConnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }
  const { api_key } = parsed.data;

  const probe = await probeToken(api_key);
  if (probe === "unauthorized") {
    console.error("figma_connect_key_rejected", { tenant_id: auth.tenant_id });
    res.status(400).json({
      error: {
        code: "figma_key_invalid",
        message:
          "Figma rejected this token. Use a personal access token (Settings → Security → Personal access tokens) " +
          "scoped with at least current_user:read, file_content:read, and projects:read.",
      },
    });
    return;
  }
  if (probe === "error") {
    console.error("figma_connect_probe_failed", { tenant_id: auth.tenant_id });
    res.status(400).json({
      error: {
        code: "figma_probe_failed",
        message: "Could not validate that token against Figma right now. Try again.",
      },
    });
    return;
  }

  const { error } = await tenantRpc(auth.tenant_id, "set_figma_connection", {
    p_api_key: api_key,
    p_handle: probe.handle,
  });

  if (error) {
    console.error("figma_connect_failed", { tenant_id: auth.tenant_id, error_code: error.code });
    res.status(500).json({
      error: { code: "figma_connect_failed", message: "Could not save the Figma connection. Try again." },
    });
    return;
  }

  void notifyFounderActivity({ event: "first_connector", tenant_id: auth.tenant_id, user_id: auth.user_id, details: { connector: "figma" } });
  res.status(200).json({ ok: true, handle: probe.handle });
}
