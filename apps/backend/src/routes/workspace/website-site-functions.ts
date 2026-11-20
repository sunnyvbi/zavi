
import type { Request, Response } from "express";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";
import { buildSessionParam, resolveBuildSessionApp, sendBuildSessionError, type BuildSessionApp } from "@/services/sites/session-site";
import {
  getSiteFunctionsService,
  redactSecretLike,
  secretNameIssue,
  secretValueIssue,
  SiteFunctionsError,
  type RunDetail,
  type SiteFunctionsService,
  type SiteRef,
} from "@/services/site-functions/contract";

const FN_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_LOG_LINES = 200;
const MAX_LOG_CHARS = 2000;
export const MAX_RUNS = 50;

export type SiteFunctionsRouteDeps = {
  requireAuth: (req: Request, res: Response) => Promise<AuthedRequest | null>;
  requireOwnerOrAdmin: (auth: AuthedRequest, res: Response) => Promise<boolean>;
  resolveSession: (auth: AuthedRequest, raw: unknown) => Promise<BuildSessionApp>;
  service: () => SiteFunctionsService | null;
};

const defaultDeps: SiteFunctionsRouteDeps = {
  requireAuth,
  requireOwnerOrAdmin: (auth, res) => requireTenantRole(auth, ["owner", "admin"], res),
  resolveSession: (auth, raw) => resolveBuildSessionApp(serverClientFromBearer(auth.access_token), auth.tenant_id, raw),
  service: getSiteFunctionsService,
};

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

async function gate(
  req: Request,
  res: Response,
  deps: SiteFunctionsRouteDeps,
): Promise<{ auth: AuthedRequest; site: SiteRef; svc: SiteFunctionsService } | null> {
  const auth = await deps.requireAuth(req, res);
  if (!auth) return null;
  if (!(await deps.requireOwnerOrAdmin(auth, res))) return null;
  const raw = buildSessionParam(req);
  if (raw === undefined || raw === null) {
    fail(res, 400, "build_session_required", "Open the site first.");
    return null;
  }
  let app: BuildSessionApp;
  try {
    app = await deps.resolveSession(auth, raw);
  } catch (e) {
    sendBuildSessionError(res, e);
    return null;
  }
  if (app.kind !== "site") {
    fail(res, 409, "not_a_site", "Secrets and server functions are available on sites made with the new builder.");
    return null;
  }
  const svc = deps.service();
  if (!svc) {
    fail(res, 503, "functions_unavailable", "Server functions are not available yet. Try again later.");
    return null;
  }
  return { auth, site: { tenant_id: auth.tenant_id, site_id: app.site.id }, svc };
}

function runtimeFailure(res: Response, e: unknown, what: string, value?: string): void {
  const scrub = (t: string) => redactSecretLike(value ? t.split(value).join("[secret]") : t);
  if (e instanceof SiteFunctionsError) {
    fail(res, e.status, e.code, scrub(e.message));
    return;
  }
  console.error(`[site-functions] ${what} failed: ${scrub(e instanceof Error ? e.message : String(e))}`);
  fail(res, 503, "functions_unavailable", "Couldn't reach your site's functions. Try again in a moment.");
}

function cleanRuns(runs: RunDetail[]): RunDetail[] {
  return runs.slice(0, MAX_RUNS).map((r) => ({
    id: r.id,
    started_at: r.started_at,
    duration_ms: r.duration_ms,
    status: r.status,
    http_status: r.http_status,
    log: (r.log ?? []).slice(0, MAX_LOG_LINES).map((l) => ({
      at: l.at,
      level: l.level,
      message: redactSecretLike(String(l.message ?? "")).slice(0, MAX_LOG_CHARS),
    })),
  }));
}

export function createSiteFunctionsHandlers(deps: SiteFunctionsRouteDeps = defaultDeps) {
  return {
    async overview(req: Request, res: Response): Promise<void> {
      const g = await gate(req, res, deps);
      if (!g) return;
      try {
        const [secrets, functions] = await Promise.all([g.svc.listSecrets(g.site), g.svc.listFunctions(g.site)]);
        res.json({
          secrets: {
            secrets: secrets.secrets.map((s) => ({ name: s.name, updated_at: s.updated_at })),
            required: [...new Set(secrets.required)],
          },
          functions: functions.map((f) => ({
            name: f.name,
            kind: f.kind,
            url: f.url,
            cron: f.cron,
            enabled: f.enabled,
            last_run: f.last_run
              ? { id: f.last_run.id, started_at: f.last_run.started_at, duration_ms: f.last_run.duration_ms, status: f.last_run.status, http_status: f.last_run.http_status }
              : null,
          })),
        });
      } catch (e) {
        runtimeFailure(res, e, "overview");
      }
    },

    async runs(req: Request, res: Response): Promise<void> {
      const g = await gate(req, res, deps);
      if (!g) return;
      const name = String(req.params.name ?? "");
      if (!FN_NAME.test(name)) return fail(res, 400, "invalid_function", "That is not a function name.");
      const n = Number(req.query.limit ?? 20);
      const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_RUNS) : 20;
      try {
        const runs = await g.svc.listRuns(g.site, name, { limit });
        if (!runs) return fail(res, 404, "function_not_found", "This site has no function by that name.");
        res.json({ runs: cleanRuns(runs) });
      } catch (e) {
        runtimeFailure(res, e, "runs");
      }
    },

    async putSecret(req: Request, res: Response): Promise<void> {
      const g = await gate(req, res, deps);
      if (!g) return;
      const name = String(req.params.name ?? "");
      const nameIssue = secretNameIssue(name);
      if (nameIssue) return fail(res, 400, "invalid_secret_name", nameIssue);
      const value = (req.body as { value?: unknown } | undefined)?.value;
      const valueIssue = secretValueIssue(value);
      if (valueIssue) return fail(res, 400, "invalid_secret_value", valueIssue);
      try {
        const saved = await g.svc.putSecret(g.site, name, value as string, { user_id: g.auth.user_id });
        console.info(`[site-functions] secret set site=${g.site.site_id} name=${name} by=${g.auth.user_id}`);
        res.json({ secret: { name: saved.name, updated_at: saved.updated_at } });
      } catch (e) {
        runtimeFailure(res, e, "put secret", value as string);
      }
    },

    async deleteSecret(req: Request, res: Response): Promise<void> {
      const g = await gate(req, res, deps);
      if (!g) return;
      const name = String(req.params.name ?? "");
      const nameIssue = secretNameIssue(name);
      if (nameIssue) return fail(res, 400, "invalid_secret_name", nameIssue);
      try {
        const deleted = await g.svc.deleteSecret(g.site, name, { user_id: g.auth.user_id });
        if (!deleted) return fail(res, 404, "secret_not_found", "There is no secret with that name.");
        console.info(`[site-functions] secret deleted site=${g.site.site_id} name=${name} by=${g.auth.user_id}`);
        res.json({ deleted: true });
      } catch (e) {
        runtimeFailure(res, e, "delete secret");
      }
    },

    async setSchedule(req: Request, res: Response): Promise<void> {
      const g = await gate(req, res, deps);
      if (!g) return;
      const name = String(req.params.name ?? "");
      if (!FN_NAME.test(name)) return fail(res, 400, "invalid_function", "That is not a schedule name.");
      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== "boolean") return fail(res, 400, "invalid_enabled", "Say whether the schedule should run.");
      try {
        const fn = await g.svc.setScheduleEnabled(g.site, name, enabled, { user_id: g.auth.user_id });
        if (!fn) return fail(res, 404, "schedule_not_found", "This site has no schedule by that name.");
        res.json({ function: { name: fn.name, kind: fn.kind, url: fn.url, cron: fn.cron, enabled: fn.enabled, last_run: fn.last_run } });
      } catch (e) {
        runtimeFailure(res, e, "set schedule");
      }
    },
  };
}

const handlers = createSiteFunctionsHandlers();
export const getSiteFunctionsHandler = handlers.overview;
export const getSiteFunctionRunsHandler = handlers.runs;
export const putSiteSecretHandler = handlers.putSecret;
export const deleteSiteSecretHandler = handlers.deleteSecret;
export const setSiteScheduleHandler = handlers.setSchedule;
