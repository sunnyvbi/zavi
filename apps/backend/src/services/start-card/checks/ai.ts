
import { START_CARD_AI_ENGINES, type StartCardAiEvidence, type StartCardProfileEvidence } from "@zavi/shared";
import { askEngine, type AskOptions, type EngineAnswer } from "@/services/tools/growth/geo/visibility/dataforseo";
import { isOutOfCredit } from "@/services/tools/growth/geo/visibility/dataforseo-credit";
import { brandAliasesOf, mentionSpans } from "@/services/tools/growth/geo/visibility/detect";
import { engineDef, localeFor, type EngineDef } from "@/services/tools/growth/geo/visibility/engines";
import { getStringSetting } from "@/services/settings";
import { StageUnavailableError, rivalsWithSite, type StageContext, type StageOutcome } from "./contract";
import { aiPoints } from "./points";
import { roundUsd } from "./costs";
import { aiNote } from "./notes";

export type AiDeps = {
  ask?: (engine: EngineDef, prompt: string, opts: AskOptions) => Promise<EngineAnswer>;
  models?: () => Promise<{ claude: string; perplexity: string }>;
};

const defaultModels = async () => {
  const [claude, perplexity] = await Promise.all([
    getStringSetting("geo_prompt_claude_model"),
    getStringSetting("geo_prompt_perplexity_model"),
  ]);
  return { claude: claude.trim() || "claude-sonnet-5", perplexity: perplexity.trim() || "sonar" };
};

export function aiPromptFor(p: Pick<StartCardProfileEvidence, "category" | "search_term" | "city" | "country" | "country_from" | "country_label">): string | null {
  const topic = p.category.trim() || p.search_term.trim();
  if (!topic) return null;
  const where = p.city
    ? ` in ${p.city}`
    : p.country !== "US" && p.country_from !== "default_us"
      ? ` in ${p.country_label ?? localeFor(p.country)?.label ?? p.country}`
      : "";
  return `What are the best ${topic} options${where}? Name the specific businesses you would recommend.`;
}

export function aliasesFor(name: string, domain: string | null): string[] {
  const aliases = brandAliasesOf(name, domain ? [domain] : []);
  const label = (domain ?? "").split(".")[0]?.toLowerCase() ?? "";
  const first = name.trim().split(/\s+/)[0] ?? "";
  if (first.length >= 4 && first.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === label && first !== name.trim()) {
    aliases.push(first);
  }
  return aliases;
}

export function mentions(text: string, name: string, domain: string | null): boolean {
  return mentionSpans(text, aliasesFor(name, domain)).length > 0;
}

export async function runAi(ctx: StageContext, deps: AiDeps = {}): Promise<StageOutcome<StartCardAiEvidence>> {
  const profile = ctx.profile;
  if (!profile) throw new StageUnavailableError("no_profile");
  const prompt = aiPromptFor(profile);
  if (!prompt) throw new StageUnavailableError("no_search_term");
  const locale = localeFor(profile.country) ?? localeFor("US")!;
  const opts: AskOptions = {
    locationCode: locale.location_code,
    languageCode: locale.language_code,
    country: locale.country,
    models: await (deps.models ?? defaultModels)(),
  };
  const ask = deps.ask ?? askEngine;
  const rivals = rivalsWithSite(ctx);

  const answers = await Promise.all(
    START_CARD_AI_ENGINES.map(async (id) => {
      const def = engineDef(id)!;
      return { id, def, answer: await ask(def, prompt, opts).catch(() => null) };
    }),
  );

  let cost = 0;
  const engines: StartCardAiEvidence["engines"] = answers.map(({ id, def, answer }) => {
    if (!answer) {
      cost += def.est_cost_usd;
      return { engine: id, answered: false, mentioned: null };
    }
    if (!answer.ok) {
      const unbilled = answer.error_code === "dataforseo_not_configured" || isOutOfCredit(answer.error_code);
      cost += answer.cost_usd ?? (unbilled ? 0 : def.est_cost_usd);
      return { engine: id, answered: false, mentioned: null };
    }
    cost += answer.cost_usd ?? def.est_cost_usd;
    return {
      engine: id,
      answered: true,
      mentioned: mentions(answer.text, profile.company_name, ctx.domain),
      rivals_mentioned: rivals.filter((r) => mentions(answer.text, r.name, r.domain)).map((r) => r.domain),
    };
  });

  const evidence: StartCardAiEvidence = { prompt, engines };
  const points = aiPoints(evidence);
  if (points === null) {
    const allFailedWith = (hit: (code: string) => boolean) =>
      answers.every((a) => a.answer && !a.answer.ok && hit(a.answer.error_code));
    const reason = allFailedWith((c) => c === "dataforseo_not_configured")
      ? "vendor_not_configured"
      : allFailedWith(isOutOfCredit)
        ? "vendor_out_of_credit"
        : "no_engine_answered";
    throw new StageUnavailableError(reason, roundUsd(cost));
  }
  evidence.note = aiNote(evidence);
  return { evidence, points, max_points: 20, cost_usd: roundUsd(cost) };
}
