
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { tenantRpc } from "@/services/tenant-client";
import { SENTRY_API_BASE } from "@/services/tools/sentry/keys";
import { notifyFounderActivity } from "@/services/tenants/founder-activity-alert";

const PROBE_TIMEOUT_MS = 15_000;

const connectSchema = z.object({
  auth_token: z.string().min(10),
  org_slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9-]+$/, "org_slug must be the Sentry organization's URL slug (lowercase, digits, hyphens)."),
});

type SentryProject = { id: string; slug: string; name: string };

async function listOrgProjects(
  authToken: string,
  orgSlug: string,
): Promise<SentryProject[] | "unauthorized" | "error"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${SENTRY_API_BASE}/organizations/${encodeURIComponent(orgSlug)}/projects/`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return "unauthorized";
    if (!res.ok) return "error";
    const json = await res.json();
    if (!Array.isArray(json)) return "error";
    return json
      .map((p) => p as { id?: unknown; slug?: unknown; name?: unknown })
      .filter((p) => p.id !== undefined && p.slug !== undefined)
      .map((p) => ({ id: String(p.id), slug: String(p.slug), name: String(p.name ?? p.slug) }));
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}

export async function sentryConnect(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }
  const { auth_token, org_slug } = parsed.data;

  const projects = await listOrgProjects(auth_token, org_slug);
  if (projects === "unauthorized") {
    console.error("sentry_connect_validate_rejected", { tenant_id: auth.tenant_id, org_slug });
    res.status(400).json({
      error: {
        code: "sentry_key_invalid",
        message:
          "Sentry rejected this token/org. Use an org auth token (Settings → Auth Tokens) scoped with org:read + project:read + event:read, and check the org slug (the part after sentry.io/organizations/).",
      },
    });
    return;
  }
  if (projects === "error") {
    console.error("sentry_connect_validate_failed", { tenant_id: auth.tenant_id, org_slug });
    res.status(400).json({
      error: {
        code: "sentry_connect_unavailable",
        message: "Could not reach Sentry to validate this token. Try again.",
      },
    });
    return;
  }

  const { error } = await tenantRpc(auth.tenant_id, "set_sentry_connection", {
    p_auth_token: auth_token,
    p_org_slug: org_slug,
  });

  if (error) {
    console.error("sentry_connect_failed", { tenant_id: auth.tenant_id, error_code: error.code });
    res.status(500).json({
      error: { code: "sentry_connect_failed", message: "Could not save the Sentry connection. Try again." },
    });
    return;
  }

  void notifyFounderActivity({ event: "first_connector", tenant_id: auth.tenant_id, user_id: auth.user_id, details: { connector: "sentry" } });
  res.status(200).json({ ok: true, org_slug, projects });
}
