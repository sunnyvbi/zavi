
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";

export const COMPETITOR_INTEL_SOURCE = "competitor_intel_weekly" as const;

export const NO_MATERIAL_CHANGE_REPORT =
  "No material change in the competitive landscape this week.";

export function isCompetitorIntelWeeklyPayload(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    (payload as { source?: unknown }).source === COMPETITOR_INTEL_SOURCE
  );
}

type LooseBlock = {
  type?: unknown;
  rows?: Array<{ brand?: unknown }>;
  cards?: Array<{ title?: unknown }>;
  body_md?: unknown;
};

function blocksOf(landscape: unknown): LooseBlock[] {
  if (!landscape || typeof landscape !== "object") return [];
  const blocks = (landscape as { blocks?: unknown }).blocks;
  return Array.isArray(blocks) ? (blocks as LooseBlock[]) : [];
}

export function extractBrands(landscape: unknown): string[] {
  const blocks = blocksOf(landscape);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const name = raw.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };

  for (const b of blocks) {
    if (b.type === "competitive_table" && Array.isArray(b.rows)) {
      for (const row of b.rows) push(row?.brand);
    }
  }
  if (out.length > 0) return out;

  for (const b of blocks) {
    if (b.type === "cards_grid" && Array.isArray(b.cards)) {
      for (const card of b.cards) push(card?.title);
    }
  }
  return out;
}

const WHAT_CHANGED_HEADING = /^(#{1,6})\s*What changed this week\s*$/im;

export function extractWhatChangedNarrative(
  landscape: unknown,
  outputText?: string | null,
): string | null {
  const candidates: string[] = [];
  for (const b of blocksOf(landscape)) {
    if (b.type === "markdown" && typeof b.body_md === "string") {
      candidates.push(b.body_md);
    }
  }
  if (typeof outputText === "string" && outputText.length > 0) {
    candidates.push(outputText);
  }

  for (const text of candidates) {
    const m = WHAT_CHANGED_HEADING.exec(text);
    if (!m) continue;
    const headingLevel = m[1].length;
    const afterHeading = text.slice((m.index ?? 0) + m[0].length);
    const nextHeading = new RegExp(`^#{1,${headingLevel}}\\s`, "m").exec(afterHeading);
    const body = (nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading).trim();
    if (body) return body;
  }
  return null;
}

export function mondayUtc(d: Date): string {
  const day = d.getUTCDay();
  const back = (day + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
  return monday.toISOString().slice(0, 10);
}

export type CompetitorDelta = {
  added_brands: string[];
  removed_brands: string[];
  narrative_md: string | null;
};

export function normalizeBrandKey(brand: string): string {
  const stripped = brand
    .toLowerCase()
    .replace(/\s*[([{].*$/su, "")
    .replace(/[\s/,.\-–—]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || brand.trim().toLowerCase();
}

export function computeBrandDelta(
  newBrands: string[],
  priorBrands: string[],
  narrative_md: string | null,
): CompetitorDelta {
  const priorKeys = new Set(priorBrands.map(normalizeBrandKey));
  const newKeys = new Set(newBrands.map(normalizeBrandKey));
  return {
    added_brands: newBrands.filter((b) => !priorKeys.has(normalizeBrandKey(b))),
    removed_brands: priorBrands.filter((b) => !newKeys.has(normalizeBrandKey(b))),
    narrative_md,
  };
}

export function isQuietWeekDelta(delta: CompetitorDelta): boolean {
  const noNarrative = typeof delta.narrative_md !== "string" || delta.narrative_md.trim() === "";
  return delta.added_brands.length === 0 && delta.removed_brands.length === 0 && noNarrative;
}

const PDF_ARTIFACT_MIME = "application/pdf";

async function suppressPdfArtifactForRun(
  tenant_id: string,
  run_id: string | undefined,
): Promise<void> {
  if (!run_id) return;
  try {
    const sb = serviceClient();
    const { error } = await sb
      .from("run_artifacts")
      .delete()
      .eq("tenant_id", tenant_id)
      .eq("run_id", run_id)
      .eq("mime", PDF_ARTIFACT_MIME);
    if (error) {
      console.warn(
        `[competitor-intel persist] PDF artifact suppression failed for tenant=${tenant_id} run=${run_id}: ${error.message}`,
      );
    }
  } catch (e) {
    console.warn(
      `[competitor-intel persist] PDF artifact suppression threw for run=${run_id}: ${(e as Error).message}`,
    );
  }
}

export async function competitorSnapshotPostProcess(
  ctx: AgentContext,
  result: DispatcherResult,
  payload?: unknown,
): Promise<void> {
  try {
    if (ctx.trigger === "chat") return;
    if (!isCompetitorIntelWeeklyPayload(payload)) return;
    if (!result.parse_ok || !result.parsed) return;
    const parsed = result.parsed as { kind?: unknown };
    if (parsed.kind !== "report") return;

    const tenant_id = ctx.tenant_id;
    const week_bucket = mondayUtc(new Date());
    const sb = serviceClient();

    let priorLandscape: unknown = null;
    const { data: priorRows, error: priorErr } = await sb
      .from("competitor_snapshots")
      .select("week_bucket, landscape")
      .eq("tenant_id", tenant_id)
      .lt("week_bucket", week_bucket)
      .order("week_bucket", { ascending: false })
      .limit(1);
    if (priorErr) {
      console.warn(
        `[competitor-intel persist] prior snapshot read failed for tenant=${tenant_id}: ${priorErr.message} — persisting without delta`,
      );
    } else if (priorRows && priorRows.length > 0) {
      priorLandscape = priorRows[0].landscape;
    }

    const narrative = extractWhatChangedNarrative(result.parsed, result.output_text);
    let delta: CompetitorDelta | null = null;
    let cleanDiffComputed = false;
    if (priorLandscape !== null) {
      const newBrands = extractBrands(result.parsed);
      const priorBrands = extractBrands(priorLandscape);
      if (priorBrands.length === 0) {
        delta = { added_brands: [], removed_brands: [], narrative_md: narrative };
      } else {
        delta = computeBrandDelta(newBrands, priorBrands, narrative);
        cleanDiffComputed = true;
      }
    }

    const { error: rpcErr } = await sb.rpc("upsert_competitor_snapshot", {
      p_tenant_id: tenant_id,
      p_week_bucket: week_bucket,
      p_landscape: result.parsed,
      p_delta: delta,
      p_source_run_id: ctx.runId,
    });
    if (rpcErr) {
      console.warn(
        `[competitor-intel persist] upsert_competitor_snapshot failed for tenant=${tenant_id} run=${ctx.runId}: ${rpcErr.message}`,
      );
      return;
    }
    console.log(
      `[competitor-intel persist] snapshot upserted tenant=${tenant_id} week=${week_bucket} run=${ctx.runId} delta=${delta ? "yes" : "first-scan"}`,
    );

    if (cleanDiffComputed && delta && isQuietWeekDelta(delta)) {
      result.output_text = NO_MATERIAL_CHANGE_REPORT;
      await suppressPdfArtifactForRun(tenant_id, ctx.runId);
      void logEvent({
        level: "info",
        source: "research",
        code: "competitor_intel.brief_suppressed",
        tenant_id,
        run_id: ctx.runId,
        message: "quiet week — no material change; operator brief suppressed",
        meta: { agent_slug: "research", run_id_ref: ctx.runId ?? "" },
      });
    }
  } catch (e) {
    console.warn(
      `[competitor-intel persist] threw for run=${ctx?.runId}: ${(e as Error).message}`,
    );
  }
}
