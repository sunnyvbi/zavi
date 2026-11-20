
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import { requestConductorTick } from "@/services/agents/conductor-kick";
import { inngest } from "../../../workers/client";
import { logEvent } from "@/services/logging/logEvent";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import { refusalFor } from "@/services/agents/refusal";
import {
  startProductBuild,
  DoubleBuildInFlight,
  TooManyBuildsToday,
  ProvisionBudgetExceeded,
  InvalidCompanyName,
  BuildRepoNotProvisioned,
  buildSetupFailedBody,
} from "@/services/agents/start-product-build";
import {
  NoOldSite,
  RebuildClaimLost,
  rebuildOldSite,
  realOldSiteRebuildDeps,
  type OldSiteRebuildDeps,
} from "@/services/sites/old-site-rebuild";

const REBUILD_ROLES = ["owner", "admin"] as const;

export function realRebuildDeps(): OldSiteRebuildDeps {
  return {
    ...realOldSiteRebuildDeps(),
    startBuild: async ({ started_by_user_id: user_id, ...input }) => {
      const result = await startProductBuild({
        tenant_id: input.tenant_id,
        company_name: input.company_name,
        idea: input.idea,
        site_name: input.site_name,
        started_by_user_id: user_id,
        onRunCreated: input.onRunCreated,
      });
      return { conductor_run_id: result.conductor_run_id };
    },
  };
}

export async function postRebuildOldSite(req: Request, res: Response): Promise<void> {
  await handleRebuildOldSite(req, res, realRebuildDeps());
}

export async function handleRebuildOldSite(req: Request, res: Response, deps: OldSiteRebuildDeps): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (!(await requireTenantRole(auth, REBUILD_ROLES, res))) return;
  if (!(await isProductBuilderEnabled())) {
    res.status(403).json({ error: { code: "product_builder_disabled", message: "Building sites isn't turned on for this workspace." } });
    return;
  }

  const warn = (event: string, meta: Record<string, unknown>) => {
    void logEvent({
      level: "warn",
      source: "website.rebuild_old_site",
      code: event,
      tenant_id: auth.tenant_id,
      ...(typeof meta.error === "string" ? { message: meta.error.slice(0, 300) } : {}),
      meta: typeof meta.conductor_run_id === "string" ? { run_id_ref: meta.conductor_run_id } : {},
    });
  };

  try {
    const result = await rebuildOldSite(
      { tenant_id: auth.tenant_id, started_by_user_id: auth.user_id },
      { ...deps, warn },
    );
    if (result.kind === "starting") {
      res.status(202).json({ ok: true, starting: true, message: "Your new site is already starting. It will show up under Build in a moment." });
      return;
    }
    if (result.kind === "started") await requestConductorTick(inngest, result.conductor_run_id);
    res.json({ ok: true, conductor_run_id: result.conductor_run_id, already: result.kind === "existing" });
  } catch (e) {
    if (e instanceof RebuildClaimLost) {
      res.status(409).json({ error: { code: e.code, message: e.message } });
      return;
    }
    if (e instanceof NoOldSite) {
      res.status(404).json({ error: { code: e.code, message: e.message } });
      return;
    }
    if (e instanceof DoubleBuildInFlight) {
      res.status(409).json({
        error: { code: "build_already_in_progress", message: "Another build is running in this workspace. Start the rebuild once it finishes." },
      });
      return;
    }
    if (e instanceof TooManyBuildsToday) {
      res.status(429).json({ error: { code: "daily_build_limit_reached", message: "You've reached today's build limit. You can rebuild tomorrow." } });
      return;
    }
    if (e instanceof InsufficientCreditsForBuild) {
      res.status(402).json({
        error: {
          code: "insufficient_credits_for_build",
          message: refusalFor({
            kind: "credits_for_build",
            required_credits: e.required_credits,
            remaining_credits: e.remaining_credits,
            free_plan: e.free_plan,
          }).message,
          required_credits: e.required_credits,
          remaining_credits: e.remaining_credits,
          free_plan: e.free_plan,
        },
      });
      return;
    }
    if (e instanceof ProvisionBudgetExceeded) {
      res.status(402).json({ error: { code: "provision_budget_exceeded", message: "This workspace is out of build budget for today." } });
      return;
    }
    if (e instanceof BuildRepoNotProvisioned) {
      void logEvent({ level: "warn", source: "website.rebuild_old_site", code: "old_site_rebuild_setup_failed", tenant_id: auth.tenant_id, error: e });
      res.status(503).json({ error: buildSetupFailedBody(e) });
      return;
    }
    if (e instanceof InvalidCompanyName) {
      void logEvent({ level: "error", source: "website.rebuild_old_site", code: "old_site_rebuild_refused", tenant_id: auth.tenant_id, error: e });
      res.status(503).json({ error: { code: "rebuild_unavailable", message: "We couldn't start the rebuild just now. Nothing was charged. Please try again later." } });
      return;
    }
    void logEvent({ level: "error", source: "website.rebuild_old_site", code: "old_site_rebuild_failed", tenant_id: auth.tenant_id, error: e });
    res.status(500).json({ error: { code: "rebuild_failed", message: "We couldn't start the rebuild. Nothing was changed. Please try again." } });
  }
}
