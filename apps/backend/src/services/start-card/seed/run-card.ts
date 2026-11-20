import type { StartCardParts, StartCardPartKey, StartCardProfileEvidence, StartCardScore } from "@zavi/shared";
import { runAi } from "../checks/ai";
import { runCompare } from "../checks/compare";
import { runDesign } from "../checks/design";
import { runDiagnosis } from "../checks/diagnosis";
import { runGoogle } from "../checks/google";
import { runProfile } from "../checks/profile";
import { runSeo } from "../checks/seo";
import type { CompleteFn } from "../checks/model";
import type { RenderSites } from "../checks/render";
import { runEnrichment } from "@/services/onboarding/enrichment/run";
import type { EnrichmentComplete } from "@/services/onboarding/enrichment/text-model";
import { SCORER_VERSION, StageUnavailableError, scoreCard, type StageContext, type StageOutcome } from "../stages";
import { ANCHOR_SESSION_EST_USD, ENRICH_MODELS_EST_USD, MODEL_CALL_EST_USD, roundUsd } from "../checks/costs";
import { applyProfileToRow, contextFor, runAndWriteStage, type StageResult } from "../pipeline";
import type { StartCardRow } from "../store";

export type SeedAdapters = { complete: CompleteFn; enrichment: EnrichmentComplete; render: RenderSites };

type StageFn = (ctx: StageContext) => Promise<StageOutcome<unknown>>;
export type SeedStages = {
  profile: StageFn;
  google: StageFn;
  ai: StageFn;
  seo: StageFn;
  design: StageFn;
  compare: StageFn;
  diagnosis: (ctx: StageContext & { score: StartCardScore }) => Promise<StageOutcome<unknown>>;
};

type Counted = { complete: CompleteFn; enrichment: EnrichmentComplete; calls: { complete: number; enrichment: number } };

function counted(a: SeedAdapters): Counted {
  const calls = { complete: 0, enrichment: 0 };
  return {
    calls,
    complete: (system, user) => (calls.complete++, a.complete(system, user)),
    enrichment: (args) => (calls.enrichment++, a.enrichment(args)),
  };
}

export function localSavingsUsd(stage: "profile" | "google" | "design" | "diagnosis", calls: Counted["calls"]): number {
  if (stage === "design") return ANCHOR_SESSION_EST_USD;
  const models = calls.complete * MODEL_CALL_EST_USD;
  return stage === "profile" && calls.enrichment > 0 ? models + ENRICH_MODELS_EST_USD : models;
}

function lessLocal<C>(
  stage: "profile" | "google" | "design" | "diagnosis",
  a: SeedAdapters,
  fn: (ctx: C, c: Counted) => Promise<StageOutcome<unknown>>,
): (ctx: C) => Promise<StageOutcome<unknown>> {
  return async (ctx) => {
    const c = counted(a);
    const adjust = (cost: number) => roundUsd(Math.max(0, cost - localSavingsUsd(stage, c.calls)));
    try {
      const o = await fn(ctx, c);
      return { ...o, cost_usd: adjust(o.cost_usd) };
    } catch (e) {
      if (e instanceof StageUnavailableError) throw new StageUnavailableError(e.reason, adjust(e.cost_usd));
      throw e;
    }
  };
}

export function seedStages(a: SeedAdapters): SeedStages {
  return {
    profile: lessLocal("profile", a, (ctx: StageContext, c) =>
      runProfile(ctx, { complete: c.complete, enrich: (input) => runEnrichment(input, { complete: c.enrichment }) }),
    ),
    google: lessLocal("google", a, (ctx: StageContext, c) => runGoogle(ctx, { complete: c.complete })),
    ai: (ctx) => runAi(ctx),
    seo: (ctx) => runSeo(ctx),
    design: lessLocal("design", a, (ctx: StageContext) => runDesign(ctx, { render: a.render })),
    compare: (ctx) => runCompare(ctx),
    diagnosis: lessLocal("diagnosis", a, (ctx: StageContext & { score: StartCardScore }, c) => runDiagnosis(ctx, { complete: c.complete })),
  };
}

export type SeedCardDeps = {
  runStage: typeof runAndWriteStage;
  applyProfile: typeof applyProfileToRow;
  saveScore: (cardId: string, score: StartCardScore, parts: StartCardParts) => Promise<void>;
};

const PARALLEL: Array<[StartCardPartKey, keyof SeedStages]> = [
  ["google", "google"],
  ["ai", "ai"],
  ["seo", "seo"],
  ["design", "design"],
];

export async function runSeedCard(
  card: Pick<StartCardRow, "id" | "domain" | "locale" | "parts">,
  stages: SeedStages,
  deps: SeedCardDeps,
): Promise<{ cost_usd: number; score: StartCardScore }> {
  const parts: StartCardParts = { ...((card.parts ?? {}) as StartCardParts) };
  const done = (k: StartCardPartKey) => (parts as Record<string, { state?: string }>)[k]?.state === "done";
  let cost = 0;
  const take = (k: StartCardPartKey, r: StageResult) => {
    (parts as Record<string, unknown>)[k] = r.part;
    cost += r.cost_usd;
  };
  const ctx = () => contextFor(card, parts);

  let ranEarlier = false;
  if (!done("profile")) {
    ranEarlier = true;
    const r = await deps.runStage("profile", stages.profile, ctx());
    take("profile", r);
    if (r.part.state === "done") await deps.applyProfile(card.id, r.part.evidence as StartCardProfileEvidence);
  }

  const todo = PARALLEL.filter(([k]) => !done(k));
  if (todo.length > 0) ranEarlier = true;
  const results = await Promise.all(todo.map(([k, s]) => deps.runStage(k, stages[s] as StageFn, ctx())));
  todo.forEach(([k], i) => take(k, results[i]));

  if (ranEarlier || !done("compare")) {
    ranEarlier = true;
    take("compare", await deps.runStage("compare", stages.compare, ctx()));
  }

  const score = scoreCard(parts);
  await deps.saveScore(card.id, score, parts);

  if (ranEarlier || !done("diagnosis")) {
    take("diagnosis", await deps.runStage("diagnosis", (c) => stages.diagnosis({ ...c, score }), ctx()));
  }
  return { cost_usd: Number(cost.toFixed(4)), score };
}

export const SEED_SCORER_VERSION = SCORER_VERSION;
