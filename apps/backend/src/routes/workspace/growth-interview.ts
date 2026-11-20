
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { sanitizeGapAnswer } from "@/services/memory/brain-slots";
import { writeNote } from "@/services/memory";
import { releaseTodaysDraftSlot } from "./growth-strategy-draft";
import { asTenantId, tenantRpc } from "@/services/tenant-client";
import { getSeoSiteHealth } from "@/services/tools/growth/seo/snapshot";
import { marketingUrlOf } from "@/services/brand/resolve-brand-kit";
import {
  buildHypothesis,
  type GrowthHypothesis,
  type HypothesisResearchInput,
} from "@/services/growth/hypothesis";
import { readTodaysResearch } from "./growth-intake-research";
import { CURRENT_STRATEGY_TAG } from "@/services/growth/strategy-note";
import { getCompanyFacts } from "@/services/company/facts";
import {
  buildInterview,
  extractCompanyFacts,
  interviewNoteFields,
  type StrategyNote,
  playback,
  type KnownContext,
  type SlotKey,
} from "@/services/growth/interview";

const ANSWER_KEYS = ["metric", "constraint", "channels", "customers"] as const;

const AnswerBody = z.object({
  key: z.enum(ANSWER_KEYS),
  answer: z.string().trim().min(1).max(2000),
});

type StoredInterview = {
  answers?: Partial<Record<SlotKey | "customers", string>>;
  skipped?: boolean;
};

async function knownContext(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
): Promise<{ ctx: KnownContext; orgName: string | null }> {
  let shape: string | null = null;
  let orgName: string | null = null;
  try {
    const { data } = await sb
      .from("tenants")
      .select("display_name, company_shape")
      .eq("id", tenant_id)
      .limit(1);
    const row = data?.[0] as { display_name?: string; company_shape?: string } | undefined;
    shape = row?.company_shape ?? null;
    orgName = row?.display_name ?? null;
  } catch {
  }

  let recordOneLiner: string | null = null;
  try {
    const record = await getCompanyFacts(tenant_id);
    if (record.name) orgName = record.name;
    recordOneLiner = record.facts.what_we_sell?.value ?? null;
  } catch {
  }

  let gtmMotion: string | null = null;
  let stage: number | null = null;
  let oneLiner: string | null = null;
  try {
    const { data } = await sb
      .from("memory_note")
      .select("body_markdown, metadata")
      .eq("tenant_id", tenant_id)
      .eq("slug", "company")
      .limit(1);
    const row = data?.[0] as
      | { body_markdown?: string; metadata?: Record<string, unknown> }
      | undefined;

    const facts = extractCompanyFacts(row?.body_markdown);
    oneLiner = recordOneLiner ?? facts.oneLiner;
    if (!shape) shape = facts.shape;

    const line = (row?.body_markdown ?? "")
      .split("\n")
      .find((l) => /GTM motion/i.test(l));
    if (line) {
      gtmMotion = line.replace(/^[*\s#]*\**GTM motion:?\**\s*/i, "").trim() || null;
    }

    if (!shape) {
      const facts = (row?.metadata as { key_facts?: Array<{ label?: string; value?: string }> })
        ?.key_facts;
      const industry = Array.isArray(facts)
        ? facts.find((f) => /industry|shape|business type/i.test(f?.label ?? ""))?.value
        : undefined;
      if (typeof industry === "string" && industry.trim()) {
        const lowered = industry.toLowerCase();
        for (const candidate of ["marketplace", "saas", "ecommerce", "fintech", "services"]) {
          if (lowered.includes(candidate)) {
            shape = candidate;
            break;
          }
        }
      }
    }
    void stage;
  } catch {
  }

  return { ctx: { shape, stage, gtmMotion, oneLiner }, orgName };
}

export async function readNote(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
  opts: { strict?: boolean } = {},
): Promise<StrategyNote> {
  try {
    const { data, error } = await sb
      .from("memory_note")
      .select("id, metadata, title, body_markdown, source, source_ref, tags")
      .eq("tenant_id", tenant_id)
      .eq("note_type", "growth_strategy")
      .contains("tags", [CURRENT_STRATEGY_TAG])
      .is("superseded_by", null)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const row = data?.[0] as (Partial<StrategyNote> & { id?: string }) | undefined;
    return {
      id: row?.id ?? null, metadata: row?.metadata ?? {},
      title: row?.title, body_markdown: row?.body_markdown, source: row?.source, source_ref: row?.source_ref, tags: row?.tags,
    };
  } catch (e) {
    if (opts.strict) throw e;
    return { id: null, metadata: {} };
  }
}

function researchInputOf(
  row: Awaited<ReturnType<typeof readTodaysResearch>>,
): HypothesisResearchInput | null {
  if (!row) return null;
  const pages = row.payload?.research_pages ?? [];
  const hosts: string[] = [];
  for (const p of pages) {
    try {
      const host = new URL(p.url).hostname.replace(/^www\./, "").toLowerCase();
      if (!hosts.includes(host)) hosts.push(host);
    } catch {
    }
  }
  return {
    status: row.status,
    source_count: pages.length,
    source_hosts: hosts,
    competitors: (row.payload?.competitors ?? []).map((c) => ({ name: c.name, url: c.url })),
  };
}

async function hypothesisFor(
  sb: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
  ctx: { stage?: number | null; oneLiner?: string | null; gtmMotion?: string | null },
): Promise<GrowthHypothesis | null> {
  try {
    const [{ data }, research] = await Promise.all([
      sb.from("tenants").select("product_url").eq("id", tenant_id).limit(1),
      readTodaysResearch(asTenantId(tenant_id)),
    ]);
    const hasSite =
      marketingUrlOf((data?.[0] as { product_url?: unknown } | undefined)?.product_url) !== null;

    const seo = hasSite
      ? await getSeoSiteHealth(tenant_id, { maxAgeMs: Number.MAX_SAFE_INTEGER })
      : null;
    return buildHypothesis({
      oneLiner: ctx.oneLiner ?? null,
      stage: ctx.stage ?? null,
      gtmMotion: ctx.gtmMotion ?? null,
      hasSite,
      seo: seo
        ? {
            status: seo.status,
            error_code: seo.error_code,
            pages_analyzed: seo.pages_analyzed,
            web_pages: seo.pages.length,
            non_html_urls: seo.non_html_urls,
            findings: seo.findings,
          }
        : null,
      research: researchInputOf(research),
    });
  } catch {
    return null;
  }
}

async function respond(
  res: Response,
  sb: ReturnType<typeof serverClientFromBearer>,
  tenant_id: string,
): Promise<void> {
  const [{ ctx, orgName }, note] = await Promise.all([
    knownContext(sb, tenant_id),
    readNote(sb, tenant_id),
  ]);
  const stored = (note.metadata.interview ?? {}) as StoredInterview;
  const { slots, next, complete } = buildInterview(ctx, stored.answers ?? {});
  const hypothesis =
    note.metadata.strategy == null ? await hypothesisFor(sb, tenant_id, ctx) : null;
  res.json({
    playback: playback(ctx, orgName),
    hypothesis,
    slots,
    next,
    complete,
    has_strategy: note.metadata.strategy != null,
    skipped: stored.skipped === true,
    customers_answered: !!stored.answers?.customers?.trim(),
  });
}

export async function getGrowthInterview(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  await respond(res, serverClientFromBearer(auth.access_token), auth.tenant_id);
}

export async function postGrowthInterviewSkip(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(auth.access_token);
  let note: Awaited<ReturnType<typeof readNote>>;
  try {
    note = await readNote(sb, auth.tenant_id, { strict: true });
  } catch (e) {
    res.status(500).json({ error: { code: "skip_read_failed", message: (e as Error).message } });
    return;
  }
  const stored = (note.metadata.interview ?? {}) as StoredInterview;

  try {
    await writeNote(auth.tenant_id, {
      ...(note.id ? { id: note.id } : {}),
      note_type: "growth_strategy",
      ...interviewNoteFields(note, "_Interview skipped._", CURRENT_STRATEGY_TAG),
      metadata: {
        ...note.metadata,
        kind: "growth_strategy",
        accepted: note.metadata.accepted === true,
        interview: { ...stored, skipped: true },
      },
    });
  } catch (e) {
    res.status(500).json({
      error: { code: "skip_write_failed", message: (e as Error).message },
    });
    return;
  }
  res.json({ ok: true, skipped: true });
}

export async function postGrowthStrategyReset(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "reset_growth_strategy_delivery", {});
    if (error || !data || (data as { ok?: boolean }).ok !== true) throw new Error("reset_failed");
    const draft_slot_freed = await releaseTodaysDraftSlot(asTenantId(auth.tenant_id)).catch(() => false);
    res.json({ ok: true, cleared: true, draft_slot_freed, plan_retired: (data as { plan_retired?: number }).plan_retired ?? 0 });
  } catch {
    res.status(500).json({ error: { code: "reset_incomplete", message: "Your strategy could not be reset. Please try again." } });
  }
}

export async function postGrowthInterviewAnswer(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = AnswerBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: parsed.error.issues[0]?.message ?? "invalid answer",
      },
    });
    return;
  }
  const answer = sanitizeGapAnswer(parsed.data.answer).trim();
  if (!answer) {
    res.status(400).json({
      error: { code: "bad_request", message: "answer is empty after sanitization" },
    });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  let note: Awaited<ReturnType<typeof readNote>>;
  try {
    note = await readNote(sb, auth.tenant_id, { strict: true });
  } catch (e) {
    res.status(500).json({ error: { code: "answer_read_failed", message: (e as Error).message } });
    return;
  }
  const stored = (note.metadata.interview ?? {}) as StoredInterview;
  const answers = { ...(stored.answers ?? {}), [parsed.data.key]: answer };

  try {
    await writeNote(auth.tenant_id, {
      ...(note.id ? { id: note.id } : {}),
      note_type: "growth_strategy",
      ...interviewNoteFields(note, "_Interview in progress._", CURRENT_STRATEGY_TAG),
      metadata: {
        ...note.metadata,
        kind: "growth_strategy",
        accepted: note.metadata.accepted === true,
        interview: { ...stored, answers },
      },
    });
  } catch (e) {
    res.status(500).json({
      error: { code: "answer_write_failed", message: (e as Error).message },
    });
    return;
  }

  await respond(res, sb, auth.tenant_id);
}
