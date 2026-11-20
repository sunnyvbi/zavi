
import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import { buildSessionParam, resolveBuildSessionApp, sendBuildSessionError, type BuildSessionApp } from "@/services/sites/session-site";
import { defaultSiteSeoDeps, siteSeo, type SiteSeoDeps } from "@/services/sites/site-seo";

export type SiteSeoRouteDeps = {
  requireAuth: (req: Request, res: Response) => Promise<AuthedRequest | null>;
  requireOwnerOrAdmin: (auth: AuthedRequest, res: Response) => Promise<boolean>;
  resolveSession: (auth: AuthedRequest, raw: unknown) => Promise<BuildSessionApp>;
  seo: SiteSeoDeps;
};

const defaultDeps: SiteSeoRouteDeps = {
  requireAuth,
  requireOwnerOrAdmin: (auth, res) => requireTenantRole(auth, ["owner", "admin"], res),
  resolveSession: (auth, raw) => resolveBuildSessionApp(serverClientFromBearer(auth.access_token), auth.tenant_id, raw),
  seo: defaultSiteSeoDeps,
};

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createSiteSeoHandlers(deps: SiteSeoRouteDeps = defaultDeps) {
  async function handle(req: Request, res: Response, refresh: boolean): Promise<void> {
    const auth = await deps.requireAuth(req, res);
    if (!auth) return;
    if (refresh && !(await deps.requireOwnerOrAdmin(auth, res))) return;
    const raw = buildSessionParam(req);
    if (raw === undefined || raw === null) return fail(res, 400, "build_session_required", "Open the site first.");
    let app: BuildSessionApp;
    try {
      app = await deps.resolveSession(auth, raw);
    } catch (e) {
      sendBuildSessionError(res, e);
      return;
    }
    if (app.kind !== "site") return fail(res, 409, "not_a_site", "SEO & AI search is available on sites made with the new builder.");
    if (app.site.tenant_id !== auth.tenant_id) return fail(res, 404, "build_session_not_found", "That build was not found.");
    try {
      res.json(await siteSeo(deps.seo, app.site, { refresh }));
    } catch (e) {
      console.error(`[site-seo] site=${app.site.id} read failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      fail(res, 503, "seo_unavailable", "Couldn't check your site right now. Try again in a moment.");
    }
  }
  return {
    get: (req: Request, res: Response) => handle(req, res, false),
    refresh: (req: Request, res: Response) => handle(req, res, true),
  };
}

const handlers = createSiteSeoHandlers();
export const getSiteSeoHandler = handlers.get;
export const refreshSiteSeoHandler = handlers.refresh;
