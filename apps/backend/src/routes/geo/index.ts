
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { getBoolSetting } from "@/services/settings";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";
import { inngest } from "@/../workers/client";
import { setCompanyFact, joinCompetitors } from "@/services/company/facts";
import { validateCustomBrands } from "@/services/competitor-intel/brands";
import { getGeoMetrics } from "@/services/tools/growth/geo/panel";
import { getEvidence, getSweepStatus } from "@/services/tools/growth/geo/visibility/read";
import {
  acceptSuggestions,
  addCustomPrompt,
  archivePrompt,
  ensureStarterPrompts,
  listPrompts,
  suggestPrompts,
  type PromptWriteError,
} from "@/services/tools/growth/geo/visibility/prompts";
import { openSweep, type SweepRefusalReason } from "@/services/tools/growth/geo/visibility/sweep";
import { GEO_ENGINE_IDS, type GeoEngine } from "@/services/tools/growth/geo/visibility/engines";
import { loadBrandContext, setHash } from "@/services/tools/growth/geo/visibility/context";
import { getCrawlerBotDetail, getCrawlerHits } from "@/services/tools/growth/geo/crawler-hits/read";
import {
  ingestLogBatch,
  ingestTokenStatus,
  resolveIngestToken,
  revokeIngestToken,
  rotateIngestToken,
} from "@/services/tools/growth/geo/crawler-hits/ingest";
import { LogPayloadError } from "@/services/tools/growth/geo/crawler-hits/parse";
import { cloudflareWorkerSetup, ingestUrl } from "@/services/tools/growth/geo/crawler-hits/cloudflare-worker";

const bad = (res: Response, code: string, message: string, status = 400): void => {
  res.status(status).json({ error: { code, message } });
};

const serverError = (res: Response, where: string, e: unknown): void => {
  console.error(`[geo] ${where}: ${(e as Error)?.message ?? String(e)}`);
  bad(res, "geo_unavailable", "Zavi could not load this right now.", 500);
};

const Engine = z.enum(GEO_ENGINE_IDS as [string, ...string[]]);
const Days = z.coerce.number().int().optional();
const Country = z.string().regex(/^[A-Za-z]{2}$/).optional();

async function isTenantAdmin(auth: AuthedRequest): Promise<boolean> {
  const { data, error } = await serverClientFromBearer(auth.access_token)
    .from("tenant_users")
    .select("role")
    .eq("tenant_id", auth.tenant_id)
    .eq("user_id", auth.user_id)
    .maybeSingle();
  if (error || !data) return false;
  const role = (data as { role?: unknown }).role;
  return role === "owner" || role === "admin";
}

async function requireAdmin(req: Request, res: Response): Promise<AuthedRequest | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (!(await isTenantAdmin(auth))) {
    bad(res, "not_admin", "Only a workspace owner or admin can change this.", 403);
    return null;
  }
  return auth;
}

const MetricsQuery = z.object({
  country: Country,
  engine: Engine.optional(),
  days: Days,
  refresh: z.string().optional(),
});

export async function geoMetricsGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const q = MetricsQuery.safeParse(req.query);
  if (!q.success) return bad(res, "invalid_query", q.error.message);
  try {
    res.json(
      await getGeoMetrics(auth.tenant_id, {
        country: q.data.country,
        engine: (q.data.engine ?? null) as GeoEngine | null,
        days: q.data.days,
        refresh: q.data.refresh === "1",
      }),
    );
  } catch (e) {
    serverError(res, "metrics", e);
  }
}

const EvidenceQuery = z.object({
  prompt_id: z.string().uuid(),
  engine: Engine.optional(),
  country: Country,
  days: Days,
});

export async function geoEvidenceGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const q = EvidenceQuery.safeParse(req.query);
  if (!q.success) return bad(res, "invalid_query", q.error.message);
  try {
    res.json(
      await getEvidence(auth.tenant_id, {
        prompt_id: q.data.prompt_id,
        engine: (q.data.engine ?? null) as GeoEngine | null,
        country: q.data.country,
        days: q.data.days,
      }),
    );
  } catch (e) {
    serverError(res, "evidence", e);
  }
}

const PROMPT_ERROR_STATUS: Record<PromptWriteError["code"], number> = {
  prompt_too_short: 400,
  prompt_too_long: 400,
  prompt_is_branded: 422,
  prompt_duplicate: 409,
  prompt_set_full: 409,
  brand_unknown: 409,
  draft_unavailable: 503,
  write_failed: 500,
};

export async function geoPromptsGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json(await listPrompts(auth.tenant_id));
  } catch (e) {
    serverError(res, "prompts list", e);
  }
}

const PromptBody = z.object({ text: z.string().max(2000) });

export async function geoPromptCreate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = PromptBody.safeParse(req.body);
  if (!body.success) return bad(res, "invalid_body", "text is required");
  try {
    const r = await addCustomPrompt(auth.tenant_id, body.data.text, auth.user_id);
    if (!r.ok) return bad(res, r.code, r.message, PROMPT_ERROR_STATUS[r.code]);
    res.status(201).json({ prompt: r.prompt, baseline_reset: true });
  } catch (e) {
    serverError(res, "prompt create", e);
  }
}

export async function geoPromptSuggest(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const planRefusal = await refuseIfChannelPlanLocked(auth.tenant_id, "geo");
  if (planRefusal) {
    res.status(403).json(planRefusal.body);
    return;
  }
  try {
    const r = await suggestPrompts(auth.tenant_id);
    if (!r.ok) return bad(res, r.code, r.message, PROMPT_ERROR_STATUS[r.code]);
    res.json({ suggestions: r.suggestions });
  } catch (e) {
    serverError(res, "prompt suggest", e);
  }
}

export async function geoPromptStarter(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const planRefusal = await refuseIfChannelPlanLocked(auth.tenant_id, "geo");
  if (planRefusal) {
    res.status(403).json(planRefusal.body);
    return;
  }
  try {
    const r = await ensureStarterPrompts(auth.tenant_id);
    if (!r.ok) return bad(res, r.code, r.message, PROMPT_ERROR_STATUS[r.code]);
    if (r.state === "started" && r.accepted > 0) {
      void logEvent({
        level: "info",
        source: "geo.prompts",
        code: "geo.prompts.started",
        tenant_id: auth.tenant_id,
        message: `GEO starter prompt set created (${r.accepted} prompts)`,
      });
    }
    res.json(r);
  } catch (e) {
    serverError(res, "prompt starter", e);
  }
}

const AcceptBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(25) });

export async function geoPromptAccept(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = AcceptBody.safeParse(req.body);
  if (!body.success) return bad(res, "invalid_body", "ids must be 1-25 prompt ids");
  try {
    const r = await acceptSuggestions(auth.tenant_id, body.data.ids);
    res.json({ ...r, baseline_reset: r.accepted.length > 0 });
  } catch (e) {
    serverError(res, "prompt accept", e);
  }
}

const IdParam = z.object({ id: z.string().uuid() });

export async function geoPromptArchive(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const p = IdParam.safeParse(req.params);
  if (!p.success) return bad(res, "invalid_id", "id must be a prompt id");
  try {
    const archived = await archivePrompt(auth.tenant_id, p.data.id);
    if (!archived) return bad(res, "not_found", "No such prompt in the set.", 404);
    res.json({ archived: true, baseline_reset: true });
  } catch (e) {
    serverError(res, "prompt archive", e);
  }
}

const RivalsBody = z.object({ rivals: z.array(z.unknown()).max(40) });

export async function geoRivalsPut(req: Request, res: Response): Promise<void> {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = RivalsBody.safeParse(req.body);
  if (!body.success) return bad(res, "invalid_body", "rivals must be an array of names");
  await saveRivals(auth, res, () => Promise.resolve(body.data.rivals));
}

const RivalAddBody = z.object({ name: z.string().trim().min(1).max(200) });

export async function geoRivalAdd(req: Request, res: Response): Promise<void> {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = RivalAddBody.safeParse(req.body);
  if (!body.success) return bad(res, "invalid_body", "name is required");
  await saveRivals(auth, res, async () => [...(await loadBrandContext(auth.tenant_id)).rivals, body.data.name]);
}

async function saveRivals(auth: { tenant_id: string; user_id: string }, res: Response, list: () => Promise<unknown[]>): Promise<void> {
  try {
    const before = await loadBrandContext(auth.tenant_id);
    const v = validateCustomBrands(await list());
    if (!v.ok) return bad(res, v.code, v.message);
    const w = await setCompanyFact(
      auth.tenant_id,
      "competitors",
      joinCompetitors(v.brands),
      `set from the GEO rival list by user ${auth.user_id}`,
    );
    if (!w.ok) return bad(res, "write_failed", w.error ?? "could not save the rival list", 500);
    const after = await loadBrandContext(auth.tenant_id);
    res.json({
      rivals: after.rivals,
      rival_set_hash: setHash(after.rivals),
      baseline_reset: setHash(before.rivals) !== setHash(after.rivals),
      dropped: v.dropped,
    });
  } catch (e) {
    serverError(res, "rivals", e);
  }
}

const SWEEP_REFUSAL_STATUS: Record<SweepRefusalReason, number> = {
  disabled: 503,
  not_configured: 503,
  unknown_country: 400,
  brand_unknown: 409,
  no_prompts: 409,
  already_running: 409,
  tenant_cap_reached: 402,
  tenant_limit_reached: 429,
  fleet_cap_reached: 429,
  nothing_to_run: 409,
  unavailable: 503,
};

const SweepBody = z.object({ country: Country.optional() }).optional();

export async function geoSweepCreate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = SweepBody.safeParse(req.body ?? {});
  if (!body.success) return bad(res, "invalid_body", "country must be a two-letter code");
  const planRefusal = await refuseIfChannelPlanLocked(auth.tenant_id, "geo");
  if (planRefusal) {
    res.status(403).json(planRefusal.body);
    return;
  }
  const r = await openSweep(
    auth.tenant_id,
    { country: body.data?.country ?? null, requestedBy: auth.user_id },
    { send: (event) => inngest.send(event) },
  );
  if (!r.ok) {
    res.status(SWEEP_REFUSAL_STATUS[r.reason]).json({
      error: { code: r.reason, message: r.message, used_7d: r.used_7d, cap_7d: r.cap_7d },
    });
    return;
  }
  void logEvent({
    level: "info",
    source: "geo.sweep",
    code: "geo.sweep.opened",
    tenant_id: auth.tenant_id,
    message: `GEO sweep opened (${r.planned} responses planned, ${r.country})`,
  });
  res.status(202).json(r);
}

export async function geoSweepGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const p = IdParam.safeParse(req.params);
  if (!p.success) return bad(res, "invalid_id", "id must be a sweep id");
  try {
    const s = await getSweepStatus(auth.tenant_id, p.data.id);
    if (!s) return bad(res, "not_found", "No such sweep.", 404);
    res.json(s);
  } catch (e) {
    serverError(res, "sweep status", e);
  }
}

const DaysQuery = z.object({ days: Days });

export async function geoCrawlerHitsGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const q = DaysQuery.safeParse(req.query);
  if (!q.success) return bad(res, "invalid_query", q.error.message);
  try {
    res.json(await getCrawlerHits(auth.tenant_id, { days: q.data.days }));
  } catch (e) {
    serverError(res, "crawler hits", e);
  }
}

export async function geoCrawlerBotGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const q = DaysQuery.safeParse(req.query);
  const bot = typeof req.params.bot === "string" ? req.params.bot.slice(0, 64) : "";
  if (!q.success || !bot) return bad(res, "invalid_query", "bot and days are invalid");
  try {
    const d = await getCrawlerBotDetail(auth.tenant_id, bot, { days: q.data.days });
    if (!d) return bad(res, "unknown_bot", "That is not a tracked AI crawler.", 404);
    res.json(d);
  } catch (e) {
    serverError(res, "crawler bot", e);
  }
}

export async function geoIngestTokenRotate(req: Request, res: Response): Promise<void> {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  try {
    const t = await rotateIngestToken(auth.tenant_id, auth.user_id);
    void logEvent({
      level: "info",
      source: "geo.crawler_hits",
      code: "geo.ingest_token.rotated",
      tenant_id: auth.tenant_id,
      message: "GEO crawler-log ingest token minted",
    });
    res.status(201).json({
      token: t.token,
      token_prefix: t.token_prefix,
      ingest_url: ingestUrl(),
      auth_header: "Authorization: Bearer <token>",
      cloudflare_worker: cloudflareWorkerSetup(),
    });
  } catch (e) {
    serverError(res, "token rotate", e);
  }
}

export async function geoCrawlerSetupGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    res.json({
      ingest_url: ingestUrl(),
      token: await ingestTokenStatus(auth.tenant_id),
      cloudflare_worker: cloudflareWorkerSetup(),
    });
  } catch (e) {
    serverError(res, "crawler setup", e);
  }
}

export async function geoIngestTokenRevoke(req: Request, res: Response): Promise<void> {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  try {
    res.json({ revoked: await revokeIngestToken(auth.tenant_id) });
  } catch (e) {
    serverError(res, "token revoke", e);
  }
}

export async function geoCrawlerIngest(req: Request, res: Response): Promise<void> {
  const header = (req.headers.authorization as string | undefined) ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!raw) return bad(res, "unauthenticated", "Missing bearer token.", 401);

  let scope: { tenant_id: string; token_id: string } | null;
  try {
    scope = await resolveIngestToken(raw);
  } catch {
    return bad(res, "unavailable", "Try again shortly.", 503);
  }
  if (!scope) return bad(res, "unauthenticated", "Invalid token.", 401);
  if (!(await getBoolSetting("geo_crawler_ingest_enabled"))) {
    return bad(res, "ingest_paused", "Log ingest is paused. Nothing was stored.", 503);
  }

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  try {
    const result = await ingestLogBatch(scope, body);
    res.status(200).json(result);
  } catch (e) {
    if (e instanceof LogPayloadError) {
      const status = e.code === "too_large" ? 413 : 400;
      return bad(res, `log_${e.code}`, "The log batch could not be read.", status);
    }
    console.error(`[geo] ingest: ${(e as Error)?.message ?? String(e)}`);
    bad(res, "unavailable", "Try again shortly.", 503);
  }
}
