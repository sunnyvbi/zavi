
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { requireTenantRole } from "@/services/auth/tenant-role";

const MONTHLY_BUDGET_CHANNELS: ReadonlySet<string> = new Set(["google_ads"]);
const MAX_MONTHLY_USD = 100_000_000;

export async function putChannelMonthlyBudget(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." } });
    return;
  }

  const allowed = await requireTenantRole(auth, ["owner", "admin"], res);
  if (!allowed) return;

  const slug = String(req.params.slug ?? "").trim();
  if (!MONTHLY_BUDGET_CHANNELS.has(slug)) {
    res.status(400).json({ error: { code: "unknown_channel", message: "That channel has no monthly plan." } });
    return;
  }

  const raw = ((req.body ?? {}) as Record<string, unknown>).usd;
  const usd = raw === null ? null : typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= MAX_MONTHLY_USD ? Math.round(raw * 100) / 100 : undefined;
  if (usd === undefined) {
    res.status(400).json({ error: { code: "bad_request", message: "Enter a monthly amount in dollars, or clear it." } });
    return;
  }

  try {
    const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "set_channel_monthly_budget", {
      p_channel_slug: slug,
      p_usd: usd,
    });
    if (error) {
      res.status(500).json({ error: { code: "write_failed", message: error.message } });
      return;
    }
    if (data !== true) {
      res.status(500).json({ error: { code: "write_unconfirmed", message: "The plan did not save. Try again." } });
      return;
    }
    res.json({ channel_slug: slug, monthly_budget_usd: usd });
  } catch (e) {
    res.status(500).json({ error: { code: "write_failed", message: (e as Error).message } });
  }
}
