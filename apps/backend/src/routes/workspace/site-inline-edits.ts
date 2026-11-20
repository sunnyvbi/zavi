import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import { DEFAULT_REFINE_MAX_USD, refineProduct, type RefineProductInput } from "@/services/agents/refine-product";
import { requestConductorTick } from "@/services/agents/conductor-kick";
import type { SiteRow, SiteStore } from "@/services/sites/contract";
import { isVisibleSite } from "@/services/sites/site-build-status";
import { siteStore } from "@/services/sites/store";
import {
  loadSiteEditRows,
  siteEditsRefineMessage,
  siteIdFromEditsApp,
  type SiteEditRow,
} from "@/services/sites/site-inline-edits";
import type { TenantId } from "@/services/tenant-client";
import { getBoolSetting } from "@/services/settings";
import { applySiteTextEditsDirect, realDirectTextDeps, type DirectTextResult } from "@/services/sites/site-text-direct";
import { mapRefineRejection } from "./website-chat";
import { inngest } from "../../../workers/client";

const APPLY_ROLES = ["owner", "admin", "member"] as const;

export type ApplySiteEditsDeps = {
  store: Pick<SiteStore, "get">;
  loadRows: (tid: TenantId, appId: string) => Promise<SiteEditRow[] | { error: string }>;
  refine: (input: RefineProductInput) => Promise<{ conductor_run_id: string }>;
  tick: (conductor_run_id: string) => Promise<unknown>;
  direct?: {
    enabled: (tid: TenantId) => Promise<boolean>;
    apply: (input: { tenant_id: TenantId; site: SiteRow; app_id: string; rows: SiteEditRow[] }) => Promise<DirectTextResult>;
  };
};

export function realApplySiteEditsDeps(): ApplySiteEditsDeps {
  return {
    store: siteStore(),
    loadRows: loadSiteEditRows,
    refine: (input) => refineProduct(input),
    tick: (id) => requestConductorTick(inngest, id),
    direct: {
      enabled: (tid) => getBoolSetting("site_text_edit_direct", tid),
      apply: (input) => applySiteTextEditsDirect({ ...input, label: appliedEditsLabel }, realDirectTextDeps()),
    },
  };
}

export async function postApplySiteEdits(req: Request, res: Response): Promise<void> {
  await handleApplySiteEdits(req, res, realApplySiteEditsDeps());
}

export function appliedEditsLabel(count: number): string {
  return count === 1 ? "Applied 1 edit" : `Applied ${count} edits`;
}

function refuse(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error: { code, message }, ...extra });
}

export async function handleApplySiteEdits(req: Request, res: Response, deps: ApplySiteEditsDeps): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, APPLY_ROLES, res))) return;
  if (!(await isProductBuilderEnabled())) {
    refuse(res, 403, "product_builder_disabled", "Product builder is not enabled.");
    return;
  }
  const tid = auth.tenant_id;
  const app_id = typeof req.body?.app_id === "string" ? req.body.app_id : "";
  const site_id = siteIdFromEditsApp(app_id);
  if (!site_id) {
    refuse(res, 400, "not_a_site", "app_id must name a site (site:<id>).");
    return;
  }

  let site: SiteRow | null = null;
  try {
    site = await deps.store.get(tid, site_id);
  } catch {
    refuse(res, 503, "site_unreadable", "We couldn't read this site. Nothing was changed. Try again.");
    return;
  }
  if (!site || site.tenant_id !== tid || site.id !== site_id || !isVisibleSite(site)) {
    refuse(res, 403, "not_your_app", "this site is not registered to your workspace");
    return;
  }
  const root = (site.root_conductor_run_id ?? "").trim();
  if (!root) {
    refuse(res, 409, "site_unavailable", "This site has no build to change yet.");
    return;
  }

  const requestedRaw = req.body?.edits;
  let requested: Map<string, { id?: string; updated_at?: string; text?: string }> | null = null;
  if (requestedRaw !== undefined) {
    if (
      !Array.isArray(requestedRaw) ||
      requestedRaw.length === 0 ||
      requestedRaw.length > 100 ||
      requestedRaw.some(
        (edit) =>
          !edit ||
          typeof edit !== "object" ||
          typeof edit.selector !== "string" ||
          edit.selector.trim().length === 0 ||
          edit.selector.length > 1_000 ||
          !(
            (typeof edit.text === "string" && edit.text.length <= 20_000) ||
            (typeof edit.id === "string" && edit.id.length <= 100 && typeof edit.updated_at === "string" && edit.updated_at.length <= 100)
          ),
      )
    ) {
      refuse(res, 400, "bad_edits", "edits must identify the exact saved text changes to apply.");
      return;
    }
    requested = new Map(
      requestedRaw.map((edit) => [
        edit.selector.trim(),
        {
          ...(typeof edit.text === "string" ? { text: edit.text } : {}),
          ...(typeof edit.id === "string" ? { id: edit.id } : {}),
          ...(typeof edit.updated_at === "string" ? { updated_at: edit.updated_at } : {}),
        },
      ]),
    );
  }

  const directP = deps.direct
    ? deps.direct.enabled(tid).then(
        (enabled) => ({ enabled, failed: false as const }),
        () => ({ enabled: false, failed: true as const }),
      )
    : Promise.resolve({ enabled: false, failed: false as const });
  const loadedRows = await deps.loadRows(tid, app_id);
  if ("error" in loadedRows) {
    console.warn(JSON.stringify({ evt: "site_edits_apply_read_failed", tenant_id: tid, site_id, error: String(loadedRows.error).slice(0, 300) }));
    refuse(res, 500, "read_failed", "We couldn't apply your edits. They're still saved. Try again.");
    return;
  }
  const rows = requested
    ? loadedRows.filter((row) => {
        const expected = requested!.get(row.selector);
        if (!expected) return false;
        if (expected.id !== undefined || expected.updated_at !== undefined) {
          return row.id === expected.id && row.updated_at === expected.updated_at;
        }
        const text = row.patch && typeof row.patch.text === "string" ? row.patch.text : null;
        return text !== null && expected.text === text;
      })
    : loadedRows;
  const outsideBatch = loadedRows.length - rows.length;
  if (rows.length === 0) {
    res.status(200).json({ applied: 0, remaining: loadedRows.length, applied_selectors: [] });
    return;
  }
  const directState = await directP;
  if (directState.failed) {
    refuse(res, 503, "settings_unavailable", "We couldn't check how to save these edits. They're still saved. Try again.");
    return;
  }
  let direct: DirectTextResult | null = null;
  if (deps.direct && directState.enabled) {
    direct = await deps.direct
      .apply({ tenant_id: tid, site, app_id, rows })
      .catch((): DirectTextResult => ({ applied: [], fallback: rows, conductor_run_id: null, reason: "threw" }));
  }
  if (direct?.reason === "preview_starting") {
    refuse(res, 409, "preview_starting", "Your preview is starting up. Try again in a minute.", { kept: loadedRows.length });
    return;
  }
  if (direct?.reason === "lease_held") {
    refuse(res, 409, "edits_busy", "Another site change is still being saved. Try again when it finishes.", { kept: loadedRows.length });
    return;
  }
  const directRows = direct?.applied.length ?? 0;
  const directShape = direct && directRows > 0 ? { direct: true, rows_direct: directRows } : {};
  const refineRows = direct ? direct.fallback : rows;
  if (direct && directRows > 0 && refineRows.length === 0) {
    res.status(200).json({
      applied: directRows,
      remaining: outsideBatch,
      applied_selectors: direct.applied.map((row) => row.selector),
      ...directShape,
      rows_fallback: 0,
      ...(direct.conductor_run_id ? { change_id: direct.conductor_run_id } : {}),
    });
    return;
  }
  const { message, included } = siteEditsRefineMessage(refineRows);
  if (included.length === 0) {
    refuse(res, 422, "edits_too_large", "These edits are too large to apply in one change. Discard some and try again.", {
      kept: refineRows.length,
      ...directShape,
    });
    return;
  }

  let conductor_run_id: string;
  try {
    const result = await deps.refine({
      tenant_id: tid,
      message,
      request: appliedEditsLabel(included.length),
      conductor_run_id: root,
      small_edit: true,
      max_usd: DEFAULT_REFINE_MAX_USD,
      site_inline_edits: included.map((r) => ({ id: r.id, updated_at: r.updated_at })),
    });
    conductor_run_id = result.conductor_run_id;
  } catch (e) {
    const shape = mapRefineRejection(e);
    refuse(res, shape.status, shape.code, shape.chat, { kept: refineRows.length, ...directShape });
    return;
  }

  await deps.tick(conductor_run_id);
  res.status(200).json({
    applied: directRows + included.length,
    remaining: outsideBatch + refineRows.length - included.length,
    applied_selectors: [...(direct?.applied ?? []), ...included].map((row) => row.selector),
    conductor_run_id,
    ...(directRows > 0 ? { ...directShape, rows_fallback: included.length } : {}),
  });
}
