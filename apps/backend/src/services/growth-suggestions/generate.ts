import { z } from "zod";
import { SUGGESTION_CATEGORIES, SUGGESTION_PRIORITIES } from "@zavi/shared";
import { callModel } from "@/services/llm/call-model";
import { MODELS } from "@/services/llm/models";
import { ExpectedToolError, type ToolContext } from "@/services/tools/types";
import { metaListCampaignsTool } from "@/services/tools/meta-ads/list_campaigns";
import { metaPixelHealthTool } from "@/services/tools/meta-ads/pixel_health";
import {
  loadClientContext,
  type ClientContext,
  type EvidenceRef,
} from "@/services/client-context";
import {
  buildEvidenceCatalog,
  renderEvidenceCatalog,
  resolveEvidenceRefs,
} from "@/services/client-context/evidence";

export const growthSuggestionCategorySchema = z.enum(SUGGESTION_CATEGORIES);
export const growthSuggestionPrioritySchema = z.enum(SUGGESTION_PRIORITIES);

const generatedSuggestionSchema = z.object({
  title: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(5000),
  category: growthSuggestionCategorySchema,
  priority: growthSuggestionPrioritySchema,
  campaign_ids: z.array(z.string().trim().min(1).max(128)).max(12).default([]),
  evidence_refs: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
});

const generatedEnvelopeSchema = z.object({
  suggestions: z.array(generatedSuggestionSchema).min(3).max(8),
});

type CampaignMetric = {
  campaign_id: string;
  campaign_name: string;
  spend_usd: number;
  impressions: number;
  clicks: number;
  ctr_percent: number;
  frequency: number;
  conversions: number;
  purchases: number;
  purchase_value_usd: number;
  roas: number | null;
  cpa_usd: number | null;
};

type CampaignRead = {
  campaigns: CampaignMetric[];
  time_range: { since: string; until: string };
  status_filter: string;
  ad_account_id: string;
};

export type GrowthSuggestionSourcePayload = {
  campaign_ids: string[];
  sources: string[];
  evidence_refs: string[];
  metrics_snapshot: CampaignMetric[];
  time_range: { since: string; until: string };
  prior_time_range: { since: string; until: string };
  pixel_health: { overall_status: string | null; pixels_found: number | null };
  evidence?: EvidenceRef[];
  context_generated_at?: string;
};

export type GrowthSuggestionPreview = {
  preview_id: string;
  title: string;
  body: string;
  category: z.infer<typeof growthSuggestionCategorySchema>;
  priority: z.infer<typeof growthSuggestionPrioritySchema>;
  source: "ai_evidence";
  source_payload: GrowthSuggestionSourcePayload;
};

export type ExistingOpenSuggestion = {
  id: string;
  title: string;
  body: string;
  status: "draft" | "awaiting_client" | string;
};

export type SuggestionDuplicate = {
  id: string;
  title: string;
  status: string;
  similarity: number;
};

export type PreviewWithDuplicate = GrowthSuggestionPreview & {
  duplicate: SuggestionDuplicate | null;
};

export type GrowthSuggestionGenerationResult =
  | {
      status: "ready";
      suggestions: GrowthSuggestionPreview[];
      meta: {
        campaigns_scanned: number;
        current_window: CampaignRead["time_range"];
      };
    }
  | {
      status: "not_connected" | "empty";
      suggestions: [];
      message: string;
      connect_path?: string;
    };

export type SuggestionModel = (prompt: string) => Promise<string>;

export function describeGeneration(count: number, duplicates: number): string {
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  const duplicateNote =
    duplicates > 0
      ? ` I found ${plural(duplicates, "possible duplicate")}.`
      : "";
  return `I drafted ${plural(count, "suggestion")} from this client's available evidence.${duplicateNote} They are saved as drafts — tweak them here, then push the ones you want to the client.`;
}

function finiteNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function sanitizeCampaign(value: unknown): CampaignMetric | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const campaign_id =
    typeof row.campaign_id === "string" ? row.campaign_id.trim() : "";
  if (!campaign_id) return null;
  return {
    campaign_id,
    campaign_name:
      typeof row.campaign_name === "string"
        ? row.campaign_name.slice(0, 300)
        : "",
    spend_usd: finiteNumber(row.spend_usd),
    impressions: finiteNumber(row.impressions),
    clicks: finiteNumber(row.clicks),
    ctr_percent: finiteNumber(row.ctr_percent),
    frequency: finiteNumber(row.frequency),
    conversions: finiteNumber(row.conversions),
    purchases: finiteNumber(row.purchases),
    purchase_value_usd: finiteNumber(row.purchase_value_usd),
    roas: nullableNumber(row.roas),
    cpa_usd: nullableNumber(row.cpa_usd),
  };
}

function sanitizeCampaignRead(value: unknown): CampaignRead {
  const row =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const time =
    row.time_range && typeof row.time_range === "object"
      ? (row.time_range as Record<string, unknown>)
      : {};
  return {
    campaigns: Array.isArray(row.campaigns)
      ? row.campaigns
          .map(sanitizeCampaign)
          .filter((x): x is CampaignMetric => x !== null)
      : [],
    time_range: {
      since: typeof time.since === "string" ? time.since : "",
      until: typeof time.until === "string" ? time.until : "",
    },
    status_filter:
      typeof row.status_filter === "string" ? row.status_filter : "ALL",
    ad_account_id:
      typeof row.ad_account_id === "string" ? row.ad_account_id : "",
  };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function previousThirtyDayRange(now = new Date()): {
  since: string;
  until: string;
} {
  const until = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  until.setUTCDate(until.getUTCDate() - 31);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - 29);
  return { since: ymd(since), until: ymd(until) };
}

function extractJson(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first)
      return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error("suggestion model returned no JSON object");
  }
}

function asStringList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function normalizeGeneratedEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.suggestions)) return value;
  return {
    ...row,
    suggestions: row.suggestions.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const suggestion = item as Record<string, unknown>;
      return {
        ...suggestion,
        campaign_ids: asStringList(suggestion.campaign_ids),
        evidence_refs: asStringList(suggestion.evidence_refs),
      };
    }),
  };
}

export function parseGeneratedSuggestions(raw: string) {
  return generatedEnvelopeSchema.parse(
    normalizeGeneratedEnvelope(extractJson(raw)),
  ).suggestions;
}

function buildPrompt(input: {
  current: CampaignRead;
  prior: CampaignRead;
  pixel: Record<string, unknown>;
  notes: string;
  evidence: EvidenceRef[];
}): string {
  const current = [...input.current.campaigns]
    .sort((a, b) => b.spend_usd - a.spend_usd)
    .slice(0, 30);
  const priorById = new Map(
    input.prior.campaigns.map((c) => [c.campaign_id, c]),
  );
  const rows = current.map((c) => ({
    ...c,
    prior: priorById.get(c.campaign_id) ?? null,
  }));
  const hasCampaigns = rows.length > 0;
  return [
    "Create 3 to 8 staff-reviewable growth recommendations from the supplied evidence about this client.",
    "Return ONLY one JSON object with key suggestions. Each suggestion must contain:",
    "title, body, category (creative|campaign|landing_page|budget|other), priority (high|medium|low),",
    "campaign_ids (string array), evidence_refs (string array).",
    "Rules:",
    "- Be specific, concise, and actionable, but do not claim any change has already been made.",
    "- Do not invent campaign ids, metrics, audiences, landing pages, or creative facts.",
    "- Label platform attribution honestly. Prefer tests/reviews over irreversible changes.",
    "- Budget recommendations may identify where to review/reallocate; do not fabricate a dollar amount.",
    '- Cite evidence by its id from the CLIENT EVIDENCE list below, e.g. "E3". Every recommendation needs at least one.',
    "- Do NOT restate a number that is not in the evidence list. If the evidence does not support a claim, do not make it.",
    "- Never emit campaign_ids or evidence_refs as a bare string; always use JSON arrays.",
    `Optional staff notes: ${JSON.stringify(input.notes || "(none)")}`,
    "",
    "CLIENT EVIDENCE (computed by Zavi from this client's connected sources — every entry carries its source and observation time):",
    renderEvidenceCatalog(input.evidence),
    "",
    hasCampaigns
      ? `Meta Ads campaign detail — current window ${JSON.stringify(input.current.time_range)}, prior window ${JSON.stringify(input.prior.time_range)}, pixel health ${JSON.stringify(input.pixel)}:\n${JSON.stringify(rows)}`
      : "Meta Ads campaign detail: not available for this client. Do not reference campaigns, creatives, or ad spend you cannot see.",
  ].join("\n");
}

export const defaultSuggestionModel: SuggestionModel = async (prompt) => {
  const result = await callModel({
    provider: "anthropic",
    model: MODELS.anthropic.haiku,
    system:
      "You are the growth recommendation analyst for a staff curation queue. Produce strict JSON grounded only in the supplied client evidence.",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2200,
    temperature: 0.2,
    maxAttempts: 2,
    tags: { agentSlug: "admin-growth-suggestions" },
  });
  return result.text;
};

const EMPTY_CAMPAIGN_READ: CampaignRead = {
  campaigns: [],
  time_range: { since: "", until: "" },
  status_filter: "ALL",
  ad_account_id: "",
};

async function readMetaEvidence(
  ctx: ToolContext,
  now: Date,
): Promise<{
  current: CampaignRead;
  prior: CampaignRead;
  pixel: Record<string, unknown>;
  connected: boolean;
}> {
  let current: CampaignRead;
  try {
    current = sanitizeCampaignRead(
      await metaListCampaignsTool.execute(ctx, {
        date_preset: "last_30d",
        status: "ALL",
      }),
    );
  } catch (error) {
    if (
      error instanceof ExpectedToolError &&
      error.code === "meta_ads_not_connected"
    ) {
      return {
        current: EMPTY_CAMPAIGN_READ,
        prior: EMPTY_CAMPAIGN_READ,
        pixel: {},
        connected: false,
      };
    }
    throw error;
  }

  const priorRange = previousThirtyDayRange(now);
  const [priorRaw, pixelRaw] = await Promise.all([
    metaListCampaignsTool
      .execute(ctx, { status: "ALL", time_range: priorRange })
      .catch(() => ({
        campaigns: [],
        time_range: priorRange,
        status_filter: "ALL",
        ad_account_id: "",
      })),
    metaPixelHealthTool.execute(ctx, { lookback_days: 7 }).catch((error) => ({
      overall_status: "unavailable",
      pixels_found: null,
      error_code:
        error instanceof ExpectedToolError ? error.code : "pixel_health_failed",
    })),
  ]);

  return {
    current,
    prior: sanitizeCampaignRead(priorRaw),
    pixel:
      pixelRaw && typeof pixelRaw === "object" && !Array.isArray(pixelRaw)
        ? (pixelRaw as Record<string, unknown>)
        : {},
    connected: true,
  };
}

function describeMissingEvidence(
  context: ClientContext | null,
  metaConnected: boolean,
): string {
  const missing: string[] = [];
  if (!metaConnected) missing.push("Meta Ads");
  if (context) {
    if (context.channels.status === "not_connected")
      missing.push("ad + analytics channels");
    if (context.analytics.status === "not_connected")
      missing.push("KPI snapshots");
    if (context.goals.status === "not_configured") missing.push("goals");
  }
  const list = [...new Set(missing)];
  return list.length > 0
    ? `There is nothing to ground a suggestion on for this client yet — no ${list.join(", no ")}. Connect a source or add a suggestion manually.`
    : "There is nothing to ground a suggestion on for this client yet. Add a suggestion manually.";
}

export const UNSOURCED_EVIDENCE = "model_assertion";

export function evidenceSources(
  refs: Array<Pick<EvidenceRef, "source">>,
  campaignIds: string[],
): string[] {
  const sources = new Set<string>();
  if (campaignIds.length > 0) sources.add("meta_ads");
  for (const ref of refs) if (ref.source && ref.source !== UNSOURCED_EVIDENCE) sources.add(ref.source);
  return [...sources];
}

export type GeneratedSuggestion = z.infer<typeof generatedSuggestionSchema>;

export function toPreview(
  generated: GeneratedSuggestion,
  index: number,
  input: {
    current: CampaignRead;
    prior: CampaignRead;
    pixel: Record<string, unknown>;
    evidence: EvidenceRef[];
    generated_at: string;
  },
): GrowthSuggestionPreview {
  const knownById = new Map(input.current.campaigns.map((c) => [c.campaign_id, c]));
  const campaignIds = [...new Set(generated.campaign_ids.filter((id) => knownById.has(id)))];
  const metrics = campaignIds
    .map((id) => knownById.get(id))
    .filter((x): x is CampaignMetric => Boolean(x));
  const typed = resolveEvidenceRefs(generated.evidence_refs, input.evidence, input.generated_at);
  return {
    preview_id: `preview-${index + 1}`,
    title: generated.title,
    body: generated.body,
    category: generated.category,
    priority: generated.priority,
    source: "ai_evidence",
    source_payload: {
      campaign_ids: campaignIds,
      sources: evidenceSources(typed, campaignIds),
      evidence_refs: typed.map((ref) => `${ref.label}: ${ref.value}`.slice(0, 500)),
      metrics_snapshot: metrics,
      time_range: input.current.time_range,
      prior_time_range: input.prior.time_range,
      pixel_health: {
        overall_status:
          typeof input.pixel.overall_status === "string" ? input.pixel.overall_status : null,
        pixels_found: typeof input.pixel.pixels_found === "number" ? input.pixel.pixels_found : null,
      },
      evidence: typed,
      context_generated_at: input.generated_at,
    },
  };
}

export async function generateGrowthSuggestionPreview(
  input: { tenant_id: string; notes?: string },
  deps: {
    model?: SuggestionModel;
    now?: Date;
    context?: ClientContext | null;
  } = {},
): Promise<GrowthSuggestionGenerationResult> {
  const now = deps.now ?? new Date();
  const ctx: ToolContext = {
    tenant_id: input.tenant_id,
    agent_slug: "performance-marketer",
    log: (message, meta) =>
      console.info(`[growth-suggestions] ${message}`, meta ?? {}),
  };

  const [meta, context] = await Promise.all([
    readMetaEvidence(ctx, now),
    deps.context !== undefined
      ? Promise.resolve(deps.context)
      : loadClientContext(input.tenant_id, { now }).catch((e: Error) => {
          console.warn(
            `[growth-suggestions] client context unavailable: ${e.message}`,
          );
          return null;
        }),
  ]);

  const evidence = context ? buildEvidenceCatalog(context) : [];
  const { current, prior, pixel } = meta;

  if (current.campaigns.length === 0 && evidence.length === 0) {
    return {
      status: meta.connected ? "empty" : "not_connected",
      suggestions: [],
      message: describeMissingEvidence(context, meta.connected),
      connect_path: "/workspace?tab=settings",
    };
  }

  const raw = await (deps.model ?? defaultSuggestionModel)(
    buildPrompt({
      current,
      prior,
      pixel,
      notes: input.notes?.trim().slice(0, 5000) ?? "",
      evidence,
    }),
  );
  const generated = parseGeneratedSuggestions(raw);
  const suggestions = generated.map((s, index) =>
    toPreview(s, index, {
      current,
      prior,
      pixel,
      evidence,
      generated_at: context?.generated_at ?? now.toISOString(),
    }),
  );

  return {
    status: "ready",
    suggestions,
    meta: {
      campaigns_scanned: current.campaigns.length,
      current_window: current.time_range,
    },
  };
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
  "your",
]);

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
      .map(stem),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function suggestionSimilarity(
  a: Pick<ExistingOpenSuggestion, "title" | "body">,
  b: Pick<ExistingOpenSuggestion, "title" | "body">,
): number {
  const titleScore = jaccard(tokens(a.title), tokens(b.title));
  const bodyScore = jaccard(tokens(a.body), tokens(b.body));
  const combinedScore = jaccard(
    tokens(`${a.title} ${a.body}`),
    tokens(`${b.title} ${b.body}`),
  );
  return Math.max(
    titleScore,
    combinedScore,
    titleScore * 0.65 + bodyScore * 0.35,
  );
}

export function attachDuplicateWarnings(
  previews: GrowthSuggestionPreview[],
  existing: ExistingOpenSuggestion[],
  threshold = 0.55,
): PreviewWithDuplicate[] {
  return previews.map((preview) => {
    let best: { row: ExistingOpenSuggestion; score: number } | null = null;
    for (const row of existing) {
      const score = suggestionSimilarity(preview, row);
      if (score >= threshold && (!best || score > best.score))
        best = { row, score };
    }
    return {
      ...preview,
      duplicate: best
        ? {
            id: best.row.id,
            title: best.row.title,
            status: best.row.status,
            similarity: Math.round(best.score * 100) / 100,
          }
        : null,
    };
  });
}
