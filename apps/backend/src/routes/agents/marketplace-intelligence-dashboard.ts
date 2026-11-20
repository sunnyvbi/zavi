
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { getBoolSetting, getSetting } from "@/services/settings";
import { serverClientFromBearer } from "@/services/supabase";
import { getMarketplaceIntel } from "@/services/tools/growth/marketplace_intelligence";
import { getCatalog } from "@/services/tools/operator-db/catalog";
import { getConfirmedMapping } from "@/services/tools/operator-db/mapping";
import {
  getSupplyDemandSetup,
  isSupplyDemandDialect,
  mergeSupplyDemandAnswers,
  SELF_SERVE_PROVENANCE_SOURCE,
  type SupplyDemandAnswers,
} from "@/services/marketplace-intel/self-serve";
import { unbackedRefs, type ProposalSchema } from "@/services/marketplace-intel/proposal";
import { inngest } from "@/../workers/client";
import type { MarketplaceIntel } from "@/services/marketplace-intel/contract";

function numberQuery(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function invalidNumberQuery(value: unknown, min: number, max: number): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.trim() === "") return false;
  const n = Number(raw);
  return Number.isFinite(n) && (!Number.isInteger(n) || n < min || n > max);
}

function stringQuery(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function withLegacyAliases<T extends MarketplaceIntel>(intel: T) {
  return {
    ...intel,
    states: intel.regions.map((region) => ({
      state: region.state ?? region.region_label,
      geo_label: region.region_label,
      bookings_n: region.bookings_n,
      active_supply_n: region.active_supply_n,
      total_listings: region.total_listings,
      completed_listings: region.completed_listings,
      balance_label:
        region.balance_label === "not_enough_locations" || region.balance_label === "not_compared"
          ? "insufficient_data"
          : region.balance_label,
      confidence: region.confidence,
      suppressed: region.suppressed,
    })),
    us_total: intel.total,
  };
}

function withErrorResponse(
  name: string,
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`[marketplace-intel] ${name} failed: ${(e as Error).message}`);
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    }
  };
}

export const marketplaceIntelligenceDashboard = withErrorResponse(
  "dashboard",
  marketplaceIntelligenceDashboardInner,
);

async function marketplaceIntelligenceDashboardInner(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  if (!(await getBoolSetting("marketplace_intel_dashboard_enabled", auth.tenant_id))) {
    res.json({ configured: false, tenant_id: auth.tenant_id });
    return;
  }

  if (invalidNumberQuery(req.query.window_weeks, 1, 104) || invalidNumberQuery(req.query.min_cell, 1, 1000)) {
    res.status(400).json({
      error: {
        code: "invalid_query",
        message: "window_weeks must be a whole number of weeks from 1 to 104, and min_cell from 1 to 1000.",
      },
    });
    return;
  }

  const intel = await getMarketplaceIntel(auth.tenant_id, {
    window_weeks: numberQuery(req.query.window_weeks),
    min_cell: numberQuery(req.query.min_cell),
    focus_region: stringQuery(req.query.focus_region) ?? stringQuery(req.query.focus_state),
  });

  if (!intel.configured) {
    const disabled =
      "message" in intel && intel.message === "marketplace intelligence disabled";
    if (disabled) {
      res.json(intel);
      return;
    }
    try {
      let setup = await getSupplyDemandSetup(auth.tenant_id);
      if (setup.state === "needs_confirm") {
        const gate = await serverClientFromBearer(auth.access_token).rpc(
          "_assert_tenant_admin",
          { p_tenant_id: auth.tenant_id },
        );
        if (gate.error) setup = { state: "needs_admin" };
      }
      res.json({ ...intel, setup });
    } catch {
      res.json(intel);
    }
    return;
  }

  if (stringQuery(req.query.edit_setup)) {
    const gate = await serverClientFromBearer(auth.access_token).rpc("_assert_tenant_admin", {
      p_tenant_id: auth.tenant_id,
    });
    if (gate.error) {
      res.status(403).json({ error: { code: "admin_required", message: "Only a workspace owner or admin can change this setup." } });
      return;
    }
    const setup = await getSupplyDemandSetup(auth.tenant_id, { formEvenIfConfirmed: true });
    res.json({ ...withLegacyAliases(intel), setup });
    return;
  }

  if (intel.provenance.source === SELF_SERVE_PROVENANCE_SOURCE) {
    const hasRows = intel.regions.length > 0 || intel.weeks.length > 0;
    let lastRun: { status?: string; at?: string; code?: string; setup_id?: string } = {};
    try {
      lastRun = ((await getSetting("marketplace_rollup_last_run", auth.tenant_id)) ?? {}) as typeof lastRun;
    } catch {
    }
    const setupId = intel.provenance.setup_id;
    const ranSinceConfirm = !!setupId && lastRun.setup_id === setupId;
    const rowsAreCurrent = hasRows && ranSinceConfirm && lastRun.status === "ok";

    if (ranSinceConfirm && lastRun.status === "failed") {
      const code = lastRun.code ?? "other";
      let form: unknown = undefined;
      if (code === "bad_date_field") {
        const gate = await serverClientFromBearer(auth.access_token).rpc(
          "_assert_tenant_admin",
          { p_tenant_id: auth.tenant_id },
        );
        if (!gate.error) {
          const setup = await getSupplyDemandSetup(auth.tenant_id, { formEvenIfConfirmed: true });
          if (setup.state === "needs_confirm") form = setup;
        }
      }
      res.json({ ...withLegacyAliases(intel), setup: { state: "calculation_failed", code, form } });
      return;
    }
    if (!rowsAreCurrent) {
      res.json({
        ...withLegacyAliases(intel),
        setup:
          ranSinceConfirm && lastRun.status === "ok"
            ? { state: "no_recent_bookings", window_weeks: intel.window_weeks }
            : { state: "waiting_first_run" },
      });
      return;
    }
  }

  res.json(withLegacyAliases(intel));
}

export const marketplaceIntelligenceSetup = withErrorResponse(
  "confirm-setup",
  marketplaceIntelligenceSetupInner,
);

async function marketplaceIntelligenceSetupInner(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = (req.body ?? {}) as {
    catalog_hash?: unknown;
    answers?: SupplyDemandAnswers;
  };
  if (typeof body.catalog_hash !== "string" || !body.catalog_hash) {
    res.status(400).json({ error: "invalid_answers" });
    return;
  }

  const catalog = await getCatalog(auth.tenant_id);
  if (!catalog || !isSupplyDemandDialect(catalog.dialect) || !catalog.catalog_hash) {
    res.status(409).json({ error: "database_not_ready" });
    return;
  }
  if (catalog.catalog_hash !== body.catalog_hash) {
    res.status(409).json({ error: "database_changed" });
    return;
  }

  const existing = await getConfirmedMapping(auth.tenant_id, catalog.catalog_hash);
  const merged = mergeSupplyDemandAnswers(
    existing?.confirmed_map,
    body.answers as SupplyDemandAnswers,
  );
  if ("error" in merged) {
    res.status(400).json({ error: merged.error, field: merged.field, reason: merged.reason });
    return;
  }

  const unbacked = unbackedRefs(catalog.catalog as ProposalSchema, merged.map);
  if (unbacked.length > 0) {
    res.status(400).json({
      error: "invalid_answers",
      field: unbacked[0],
      reason: unbacked[0].endsWith(".table") ? "unknown_table" : "unknown_column",
    });
    return;
  }

  const { error } = await serverClientFromBearer(auth.access_token).rpc(
    "set_mapping_confirmed",
    {
      p_tenant_id: auth.tenant_id,
      p_catalog_hash: catalog.catalog_hash,
      p_confirmed_map: merged.map,
    },
  );
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      res.status(403).json({ error: "admin_required" });
      return;
    }
    res.status(400).json({ error: "mapping_rejected" });
    return;
  }

  try {
    await inngest.send({
      name: "marketplace.rollup.requested",
      data: { tenant_id: auth.tenant_id },
    });
  } catch (e) {
    console.warn(
      `[marketplace-intel] enqueue first rollup failed for tenant ${auth.tenant_id}: ${(e as Error).message}`,
    );
  }

  res.json({ ok: true });
}
