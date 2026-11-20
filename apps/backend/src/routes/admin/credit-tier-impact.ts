
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import {
  creditsPerUsdRejection,
  creditTiersRejection,
  pricingFromBlob,
} from "@/services/billing/credit-rate";
import { creditsForUsd } from "@/services/billing/plans";

const Body = z.object({
  credits_per_usd: z.unknown().optional(),
  credit_tiers: z.unknown().optional(),
});

type Row = {
  tenant_id: string;
  monthly_usd: number | null;
  tenants: { slug: string | null; name: string | null } | null;
};

export async function staffCreditTierImpact(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_body", message: parsed.error.message } });
    return;
  }
  if (parsed.data.credits_per_usd !== undefined) {
    const why = creditsPerUsdRejection(parsed.data.credits_per_usd);
    if (why) {
      res.status(400).json({ error: { code: "invalid_credits_per_usd", message: why } });
      return;
    }
  }
  if (parsed.data.credit_tiers !== undefined) {
    const why = creditTiersRejection(parsed.data.credit_tiers);
    if (why) {
      res.status(400).json({ error: { code: "invalid_credit_tiers", message: why } });
      return;
    }
  }

  const sb = staffCrossTenantClient("admin/credit-tier-impact: cross-tenant pricing dry run");

  const { data: cfg, error: cfgErr } = await sb
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> | null }>();
  if (cfgErr) {
    res.status(500).json({ error: { code: "config_read_failed", message: cfgErr.message } });
    return;
  }

  const proposedBlob: Record<string, unknown> = { ...(cfg?.blob ?? {}) };
  if (parsed.data.credits_per_usd !== undefined) proposedBlob.credits_per_usd = parsed.data.credits_per_usd;
  if (parsed.data.credit_tiers !== undefined) proposedBlob.credit_tiers = parsed.data.credit_tiers;
  const proposed = pricingFromBlob(proposedBlob);

  const { data: subs, error: subErr } = await sb
    .from("tenant_subscriptions")
    .select("tenant_id, monthly_usd, tenants(slug, name)")
    .not("monthly_usd", "is", null)
    .is("credits_revoked_at", null);
  if (subErr) {
    res.status(500).json({ error: { code: "subs_read_failed", message: subErr.message } });
    return;
  }

  const rows = (subs ?? []) as unknown as Row[];
  const ids = rows.map((r) => r.tenant_id);
  const balances = new Map<string, { allowance: number; used: number }>();
  if (ids.length > 0) {
    const { data: bals, error: balErr } = await sb
      .from("tenant_credit_balances")
      .select("tenant_id, included_allowance, included_used")
      .in("tenant_id", ids);
    if (balErr) {
      res.status(500).json({ error: { code: "balances_read_failed", message: balErr.message } });
      return;
    }
    for (const b of (bals ?? []) as {
      tenant_id: string;
      included_allowance: number;
      included_used: number;
    }[]) {
      balances.set(b.tenant_id, { allowance: b.included_allowance, used: b.included_used });
    }
  }

  const impact = rows
    .map((r) => {
      const usd = r.monthly_usd as number;
      const bal = balances.get(r.tenant_id) ?? { allowance: 0, used: 0 };
      const next = creditsForUsd(usd, proposed);
      return {
        tenant_id: r.tenant_id,
        slug: r.tenants?.slug ?? null,
        name: r.tenants?.name ?? null,
        monthly_usd: usd,
        used_this_period: bal.used,
        current_allowance: bal.allowance,
        new_allowance: next,
        delta: next - bal.allowance,
        current_remaining: bal.allowance - bal.used,
        new_remaining: next - bal.used,
        underwater: next < bal.used,
      };
    })
    .sort((a, b) => a.delta - b.delta);

  res.json({
    affected: impact.length,
    increases: impact.filter((r) => r.delta > 0).length,
    decreases: impact.filter((r) => r.delta < 0).length,
    underwater: impact.filter((r) => r.underwater).length,
    tenants: impact,
  });
}
