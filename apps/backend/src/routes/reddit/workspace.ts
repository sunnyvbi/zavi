import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { redditDb as serviceClient } from "@/services/channels/reddit/db";
import {
  REDDIT_FIELDS,
  WorkspaceConflictError,
  communityCreateSchema,
  communityUpdateSchema,
  competitorCreateSchema,
  competitorUpdateSchema,
  createCommunity,
  createCompetitor,
  trackedCompetitorMatching,
  readCompetitorName,
  seedCompetitorsFromRecord,
  createKeyword,
  deleteRow,
  keywordCreateSchema,
  keywordUpdateSchema,
  readRedditWorkspace,
  updateCommunity,
  updateCompetitor,
  updateKeyword,
} from "@/services/channels/reddit/workspace";
import { suggestRedditSetup } from "@/services/channels/reddit/suggest";
import { backfillTermMentions, type TrackedTerm } from "@/services/channels/reddit/sweep";
import { addCompetitorToRecord, removeCompetitorFromRecord } from "@/services/company/facts";
import { consumeTenantRateLimit, tenantMarkerAt, type TenantId } from "@/services/tenant-client";

const idSchema = z.string().uuid();

function fail(res: Response, err: unknown, route: string): void {
  if (err instanceof WorkspaceConflictError) {
    res.status(409).json({ error: "already_exists" });
    return;
  }
  console.error(`[reddit-workspace] ${route} failed`, err instanceof Error ? err.message : err);
  res.status(500).json({ error: "reddit_workspace_failed" });
}

function badRequest(res: Response, issues: z.ZodIssue[]): void {
  res.status(400).json({ error: "invalid_request", issues: issues.map((i) => i.message) });
}

export async function redditWorkspaceGet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    try {
      await seedCompetitorsFromRecord(serviceClient(), auth.tenant_id);
    } catch {
    }
    res.json(await readRedditWorkspace(serviceClient(), auth.tenant_id));
  } catch (err) {
    fail(res, err, "get");
  }
}

function competitorName(tenantId: string, id: string): Promise<string | null> {
  return readCompetitorName(serviceClient(), tenantId, id);
}

async function backfill(tenantId: string, term: TrackedTerm): Promise<void> {
  try {
    await backfillTermMentions(serviceClient(), tenantId, term);
  } catch (err) {
    console.error(`[reddit] mention backfill failed for "${term.term}": ${(err as Error)?.message ?? err}`);
  }
}

const keywordTerm = (k: { id: string; term: string; type: string }): TrackedTerm => ({
  term: k.term,
  kind: k.type === "brand" ? "brand" : "keyword",
  keyword_id: k.id,
  competitor_id: null,
});

const competitorTerm = (c: { id: string; name: string }): TrackedTerm => ({
  term: c.name,
  kind: "competitor",
  keyword_id: null,
  competitor_id: c.id,
});

export async function redditKeywordCreate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = keywordCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    const row = await createKeyword(serviceClient(), auth.tenant_id, auth.user_id, parsed.data);
    if (row.status === "tracking") await backfill(auth.tenant_id, keywordTerm(row));
    res.status(201).json(row);
  } catch (err) {
    fail(res, err, "keyword.create");
  }
}

export async function redditKeywordUpdate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = idSchema.safeParse(req.params.id);
  const parsed = keywordUpdateSchema.safeParse(req.body ?? {});
  if (!id.success) return badRequest(res, id.error.issues);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    const row = await updateKeyword(serviceClient(), auth.tenant_id, id.data, parsed.data);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (parsed.data.status === "tracking") await backfill(auth.tenant_id, keywordTerm(row));
    res.json(row);
  } catch (err) {
    fail(res, err, "keyword.update");
  }
}

export async function redditCompetitorCreate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = competitorCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    if (await trackedCompetitorMatching(serviceClient(), auth.tenant_id, parsed.data.name)) {
      res.status(409).json({ error: "already_exists", message: "Already saved." });
      return;
    }
    const rec = await addCompetitorToRecord(
      auth.tenant_id,
      parsed.data.name,
      `reddit panel, user ${auth.user_id}`,
    );
    if (rec.full) {
      res.status(409).json({ error: "competitor_list_full", message: rec.error });
      return;
    }
    if (!rec.ok) throw new Error(rec.error ?? "could not add the competitor to the company record");

    const row = await createCompetitor(serviceClient(), auth.tenant_id, auth.user_id, parsed.data);
    if (row.status === "tracking") await backfill(auth.tenant_id, competitorTerm(row));
    res.status(201).json(row);
  } catch (err) {
    fail(res, err, "competitor.create");
  }
}

export async function redditCompetitorUpdate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = idSchema.safeParse(req.params.id);
  const parsed = competitorUpdateSchema.safeParse(req.body ?? {});
  if (!id.success) return badRequest(res, id.error.issues);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    const name = await competitorName(auth.tenant_id, id.data);
    if (!name) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (parsed.data.status === "tracking") {
      const rec = await addCompetitorToRecord(
        auth.tenant_id,
        name,
        `reddit panel accept, user ${auth.user_id}`,
      );
      if (rec.full) {
        res.status(409).json({ error: "competitor_list_full", message: rec.error });
        return;
      }
      if (!rec.ok) throw new Error(rec.error ?? "could not add the competitor to the company record");
    }
    if (parsed.data.status === "dismissed") {
      const { ok, error } = await removeCompetitorFromRecord(
        auth.tenant_id,
        name,
        `reddit panel dismiss, user ${auth.user_id}`,
      );
      if (!ok) throw new Error(error ?? "could not remove the competitor from the company record");
    }

    const row = await updateCompetitor(serviceClient(), auth.tenant_id, id.data, parsed.data);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (parsed.data.status === "tracking") await backfill(auth.tenant_id, competitorTerm(row));
    res.json(row);
  } catch (err) {
    fail(res, err, "competitor.update");
  }
}

export async function redditCommunityCreate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const parsed = communityCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    res.status(201).json(await createCommunity(serviceClient(), auth.tenant_id, auth.user_id, parsed.data));
  } catch (err) {
    fail(res, err, "community.create");
  }
}

export async function redditCommunityUpdate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const id = idSchema.safeParse(req.params.id);
  const parsed = communityUpdateSchema.safeParse(req.body ?? {});
  if (!id.success) return badRequest(res, id.error.issues);
  if (!parsed.success) return badRequest(res, parsed.error.issues);
  try {
    const row = await updateCommunity(serviceClient(), auth.tenant_id, auth.user_id, id.data, parsed.data);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(row);
  } catch (err) {
    fail(res, err, "community.update");
  }
}

const FIELD_BY_KIND = {
  keywords: REDDIT_FIELDS.keywords,
  competitors: REDDIT_FIELDS.competitors,
  communities: REDDIT_FIELDS.communities,
} as const;

export async function redditWorkspaceDelete(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const kind = z.enum(["keywords", "competitors", "communities"]).safeParse(req.params.kind);
  const id = idSchema.safeParse(req.params.id);
  if (!kind.success) return badRequest(res, kind.error.issues);
  if (!id.success) return badRequest(res, id.error.issues);
  try {
    const doomed =
      kind.data === "competitors" ? await competitorName(auth.tenant_id, id.data) : null;

    if (doomed) {
      const { ok, error } = await removeCompetitorFromRecord(
        auth.tenant_id,
        doomed,
        `reddit panel delete, user ${auth.user_id}`,
      );
      if (!ok) throw new Error(error ?? "could not remove the competitor from the company record");
    }
    const removed = await deleteRow(serviceClient(), auth.tenant_id, FIELD_BY_KIND[kind.data], id.data);
    if (!removed) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    fail(res, err, "delete");
  }
}

const SUGGEST_BUCKET = "reddit_suggest";
const SUGGEST_LIMIT = 6;
const SUGGEST_WINDOW_S = 60 * 60;

async function suggestRetryAfterS(tenantId: TenantId): Promise<number> {
  try {
    const start = await tenantMarkerAt(tenantId, SUGGEST_BUCKET);
    if (start !== null) return Math.max(1, Math.ceil((start + SUGGEST_WINDOW_S * 1000 - Date.now()) / 1000));
  } catch (err) {
    console.error("[reddit-workspace] suggest window read failed", err instanceof Error ? err.message : err);
  }
  return SUGGEST_WINDOW_S;
}

export async function redditWorkspaceSuggest(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  try {
    const result = await suggestRedditSetup(serviceClient(), auth.tenant_id, {}, {
      claim: () => consumeTenantRateLimit(auth.tenant_id, SUGGEST_BUCKET, SUGGEST_LIMIT, SUGGEST_WINDOW_S),
    });
    if (!result.ok) {
      if (result.code === "rate_limited") {
        const retryAfter = await suggestRetryAfterS(auth.tenant_id);
        const mins = Math.max(1, Math.ceil(retryAfter / 60));
        res.status(429).json({
          error: "rate_limited",
          message: `Zavi has drafted suggestions ${SUGGEST_LIMIT} times this hour. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`,
          retry_after_s: retryAfter,
        });
        return;
      }
      res.status(result.code === "context_missing" ? 422 : 502).json({ error: result.code, message: result.message });
      return;
    }
    res.json(result);
  } catch (err) {
    fail(res, err, "suggest");
  }
}
