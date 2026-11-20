
import type { Request, Response } from "express";
import { liveRunsRejection, liveRunStartMoveRejection, parseLiveRuns } from "@/services/live-stunt/config";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  creditsPerUsdRejection,
  creditTiersRejection,
  patchTouchesPricing,
} from "@/services/billing/credit-rate";
import { tierConfigRejection } from "@/services/billing/tiers";
import { freeDailyCreditsRejection } from "@/services/agents/credits";

const TIER_CONFIG_KEYS = [
  "tier_credits",
  "tier_agent_min",
  "tier_gate_enforced",
  "tier_pro_tenants",
  "tier_always_pro",
  "tier_invite_emails_per_day",
] as const;

const PatchBody = z.object({
  patch: z.record(z.string(), z.unknown()),
});

type ConfigRow = {
  blob: Record<string, unknown>;
  updated_at: string;
  updated_by: string | null;
};

export async function staffConfigGet(_req: Request, res: Response): Promise<void> {
  assertStaff(_req);
  const { data, error } = await serviceClient()
    .from("system_config")
    .select("blob, updated_at, updated_by")
    .eq("id", 1)
    .maybeSingle<ConfigRow>();
  if (error) {
    res.status(500).json({ error: { code: "config_query_failed", message: error.message } });
    return;
  }
  res.json({
    blob: data?.blob ?? {},
    updated_at: data?.updated_at ?? null,
    updated_by: data?.updated_by ?? null,
  });
}

export async function staffConfigPatch(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "invalid_body", message: parsed.error.message } });
    return;
  }

  const sb = serviceClient();
  const { data: current, error: getErr } = await sb
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> }>();
  if (getErr) {
    res.status(500).json({ error: { code: "config_read_failed", message: getErr.message } });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(parsed.data.patch, "credits_per_usd")) {
    const why = creditsPerUsdRejection(parsed.data.patch.credits_per_usd);
    if (why) {
      res.status(400).json({ error: { code: "invalid_credits_per_usd", message: why } });
      return;
    }
  }
  if (Object.prototype.hasOwnProperty.call(parsed.data.patch, "live_runs")) {
    const why = liveRunsRejection(parsed.data.patch.live_runs) ?? liveRunStartMoveRejection(parsed.data.patch.live_runs, parseLiveRuns(current?.blob ?? {}), new Date());
    if (why) {
      res.status(400).json({ error: { code: "invalid_live_runs", message: why } });
      return;
    }
  }
  if (Object.prototype.hasOwnProperty.call(parsed.data.patch, "free_daily_credits")) {
    const why = freeDailyCreditsRejection(parsed.data.patch.free_daily_credits);
    if (why) {
      res.status(400).json({ error: { code: "invalid_free_daily_credits", message: why } });
      return;
    }
  }
  if (Object.prototype.hasOwnProperty.call(parsed.data.patch, "credit_tiers")) {
    const why = creditTiersRejection(parsed.data.patch.credit_tiers);
    if (why) {
      res.status(400).json({ error: { code: "invalid_credit_tiers", message: why } });
      return;
    }
  }

  for (const key of TIER_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(parsed.data.patch, key)) continue;
    const why = tierConfigRejection(key, parsed.data.patch[key]);
    if (why) {
      res.status(400).json({ error: { code: `invalid_${key}`, message: why } });
      return;
    }
  }

  const before = current?.blob ?? {};
  const after = { ...before, ...parsed.data.patch };

  const { error: upsertErr } = await sb
    .from("system_config")
    .upsert(
      {
        id: 1,
        blob: after,
        updated_at: new Date().toISOString(),
        updated_by: staff.user_id,
      },
      { onConflict: "id" },
    );
  if (upsertErr) {
    res.status(500).json({ error: { code: "config_write_failed", message: upsertErr.message } });
    return;
  }

  let resync: { tenants: number; changed: ResyncRow[]; error: string | null } | null = null;
  if (patchTouchesPricing(parsed.data.patch)) {
    const { data: rows, error: rErr } = await sb.rpc("resync_credit_allowances");
    if (rErr) {
      resync = { tenants: 0, changed: [], error: rErr.message };
      console.warn(`[staff/config] allowance resync failed (config saved): ${rErr.message}`);
    } else {
      const all = (rows ?? []) as ResyncRow[];
      resync = {
        tenants: all.length,
        changed: all.filter((r) => r.previous_allowance !== r.new_allowance),
        error: null,
      };
    }
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "config.patch",
    target_table: "system_config",
    target_id: "1",
    meta: { before, after, patch: parsed.data.patch, resync },
  });

  res.json({ ok: true, blob: after, resync });
}

type ResyncRow = {
  tenant_id: string;
  previous_allowance: number;
  new_allowance: number;
  used_this_period: number;
};
