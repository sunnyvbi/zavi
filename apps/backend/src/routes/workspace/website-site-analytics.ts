
import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { buildSessionParam, resolveBuildSessionApp, sendBuildSessionError, type BuildSessionApp } from "@/services/sites/session-site";
import {
  AnalyticsUnavailable,
  parseRange,
  parseTimeZone,
  readTrafficStats,
  siteAnalytics,
  type SiteAnalyticsDeps,
} from "@/services/sites/site-analytics";
import { siteAuthDirectory } from "@/services/site-auth";
import { requestSchemaRepair } from "@/services/site-shards/auto-rollout";

export type SiteAnalyticsRouteDeps = {
  requireAuth: (req: Request, res: Response) => Promise<AuthedRequest | null>;
  resolveSession: (auth: AuthedRequest, raw: unknown) => Promise<BuildSessionApp>;
  analytics: SiteAnalyticsDeps;
};

const defaultDeps: SiteAnalyticsRouteDeps = {
  requireAuth,
  resolveSession: (auth, raw) => resolveBuildSessionApp(serverClientFromBearer(auth.access_token), auth.tenant_id, raw),
  analytics: { directory: siteAuthDirectory, traffic: readTrafficStats, now: () => new Date(), requestSchema: requestSchemaRepair },
};

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createSiteAnalyticsHandler(deps: SiteAnalyticsRouteDeps = defaultDeps) {
  return async function getSiteAnalytics(req: Request, res: Response): Promise<void> {
    const auth = await deps.requireAuth(req, res);
    if (!auth) return;
    const raw = buildSessionParam(req);
    if (raw === undefined || raw === null) return fail(res, 400, "build_session_required", "Open the site first.");
    let app: BuildSessionApp;
    try {
      app = await deps.resolveSession(auth, raw);
    } catch (e) {
      sendBuildSessionError(res, e);
      return;
    }
    if (app.kind !== "site") return fail(res, 409, "not_a_site", "Analytics are available on sites made with the new builder.");
    try {
      const out = await siteAnalytics(deps.analytics, app.site, parseRange(req.query.days), parseTimeZone(req.query.tz));
      res.json(out);
    } catch (e) {
      if (e instanceof AnalyticsUnavailable) return fail(res, 503, e.code, e.message);
      console.error(`[site-analytics] site=${app.site.id} read failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      fail(res, 503, "analytics_unavailable", "Couldn't load your site's numbers. Try again in a moment.");
    }
  };
}

export const getSiteAnalyticsHandler = createSiteAnalyticsHandler();
