
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { getVisibility, VISIBILITY_WINDOWS, type VisibilityPanel } from "./geo/visibility/read";
import { VISIBILITY_DISCLOSURE, type Rate } from "./geo/visibility/metrics";
import { listingTargetsOf } from "./geo/visibility/listing-targets";
import { ensureStarterPrompts, listPrompts } from "./geo/visibility/prompts";
import { refuseIfChannelPlanLocked } from "@/services/growth/preview-plan";

const TOP_DOMAINS = 10;
const TOP_RIVAL_ONLY_PROMPTS = 10;

const inputSchema = z.object({
  days: z.number().int().optional(),
  country: z.string().min(2).max(2).optional(),
});

type SlimRate = { rate: number | null; numerator: number; n: number; ci95: { low: number; high: number } | null };

const slimRate = (r: Rate): SlimRate => ({ rate: r.rate, numerator: r.numerator, n: r.denominator, ci95: r.ci95 });

export function slimVisibility(p: VisibilityPanel) {
  const m = p.metrics;
  return {
    state: p.state,
    country: p.country,
    window_days: p.window_days,
    window: p.window,
    disclosure: VISIBILITY_DISCLOSURE,
    runs: { used: p.config.runs_used, limit: p.config.run_limit, limit_reached: p.config.run_limit_reached },
    sweep_running: p.running !== null,
    responses: m ? { planned: m.responses.planned, collected: m.responses.collected, failed: m.responses.failed, sweeps: m.responses.sweeps } : null,
    mention_rate: m
      ? { ...slimRate(m.mention_rate), by_engine: m.mention_rate.by_engine.map((e) => ({ engine: e.label, ...slimRate(e) })) }
      : null,
    citation_rate: m
      ? { ...slimRate(m.citation_rate), by_engine: m.citation_rate.by_engine.map((e) => ({ engine: e.label, ...slimRate(e) })) }
      : null,
    share_of_voice: m
      ? {
          state: m.share_of_voice.state,
          share: m.share_of_voice.share,
          brand_mentions: m.share_of_voice.brand_mentions,
          rival_mentions: m.share_of_voice.rival_mentions,
          rivals: m.share_of_voice.rivals.slice(0, TOP_DOMAINS).map((r) => ({ name: r.name, mentions: r.mentions })),
        }
      : null,
    deltas: p.deltas,
    top_source_domains: m
      ? m.source_mix.domains.slice(0, TOP_DOMAINS).map((d) => ({ domain: d.domain, kind: d.kind, rival: d.rival, responses: d.responses, used: d.used }))
      : [],
    rival_only_prompts: m
      ? m.prompt_grid.rows
          .filter((r) => r.rival_only_responses > 0)
          .sort((a, b) => b.rival_only_responses - a.rival_only_responses)
          .slice(0, TOP_RIVAL_ONLY_PROMPTS)
          .map((r) => ({
            prompt: r.prompt_text,
            rival_only_responses: r.rival_only_responses,
            collected: r.all.collected,
            rivals_named_on_prompt: r.top_rivals.slice(0, 3).map((t) => t.name),
            cited_domains_on_prompt: r.cited_domains.map((d) => ({ domain: d.domain, kind: d.kind, responses: d.responses })),
          }))
      : [],
    ...listingTargetsOf(m),
  };
}

export type GeoVisibilityToolResult = ReturnType<typeof slimVisibility>;

export const geoVisibilityTool: ToolSpec = {
  name: "growth_geo_visibility",
  effect: "read",
  description:
    "Read the company's SAMPLED AI-answer visibility: mention rate, citation rate (each overall and per engine, " +
    "with numerator, n and a 95% interval), share of voice against its tracked rivals, change vs the previous " +
    "window (or why no change can be stated), the top cited source domains, and the tracked prompts where a rival " +
    "is named and the brand is not, each with the domains its answers cited, and `listing_target`: the one cited " +
    "site with a confirmed sign-up page the company can get listed on (null when none). Computed from stored answers to the company's tracked prompt set in one " +
    "country; it describes that prompt set, never every AI answer. `state` other than `ok` means nothing was " +
    "measured in the window. Runs no new sample. With no tracked questions it creates the starter set first; " +
    "`tracked_questions` says how many Check AI answers would ask, with a few verbatim. Input: days (7, 30 or 90; default 90), country (optional).",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { days, country } = inputSchema.parse(input ?? {});
    if (days !== undefined && !(VISIBILITY_WINDOWS as readonly number[]).includes(days)) {
      throw new ExpectedToolError("geo_visibility_bad_window", "days must be 7, 30 or 90");
    }
    const opts = { days: days ?? 90, country: country ?? null, engine: null };
    let panel = await getVisibility(ctx.tenant_id, opts);
    const started = panel.state === "no_prompts" && !ctx.writes_suppressed ? await startQuestions(ctx.tenant_id) : false;
    if (started) panel = await getVisibility(ctx.tenant_id, opts);
    const out = { ...slimVisibility(panel), tracked_questions: await trackedQuestions(ctx.tenant_id, panel, started) };
    ctx.log("geo_visibility read", { state: out.state, days: out.window_days, questions_started: started });
    return out;
  },
};

const QUESTION_SAMPLE = 5;

async function startQuestions(tenant_id: string): Promise<boolean> {
  try {
    if (await refuseIfChannelPlanLocked(tenant_id, "geo")) return false;
    const r = await ensureStarterPrompts(tenant_id);
    return r.ok && r.state === "started" && r.accepted > 0;
  } catch {
    return false;
  }
}

async function trackedQuestions(tenant_id: string, panel: VisibilityPanel, created_this_run: boolean) {
  const base = { active: panel.config.prompts_active, waiting_for_review: panel.config.suggestions_pending, created_this_run, sample: [] as string[] };
  if (panel.config.prompts_active === 0) return base;
  try {
    const { active } = await listPrompts(tenant_id);
    return { ...base, sample: active.slice(0, QUESTION_SAMPLE).map((p) => p.prompt_text) };
  } catch {
    return base;
  }
}
