
import { z } from "zod";
import { rationaleInput } from "@/services/tools/_shared/rationale";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";
import { isMetaAdsWriteEnabled } from "./_flag-check";
import { promotedObjectSchema } from "./_targeting-validate";
import { createAdSetBodySchema, metaBidStrategySchema } from "./_decision-bodies";
import { resolveCreateAdSetBid } from "./_ad-set-bid";
import { isRetryableMetaReadError } from "../_retryable";
import { readTenantCapAndToday } from "./cap-reader";
import { formatMoney } from "./_currency";
import { simulateCreateWrite } from "./_simulate";
import { FINAL_CREATE_CLASS } from "@/services/meta-ads/strategist-gate/constants";
import { isHumanAuthoredCommand } from "@/services/agents/untrusted-context";

export async function withCgoCountryDefault(
  ctx: Parameters<ToolSpec["execute"]>[0],
  targeting: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (targeting.geo_locations !== undefined || isHumanAuthoredCommand(ctx, "budget")) return targeting;
  const { cgoAdBudget } = await import("@/services/growth/cgo-ads");
  if (!(await cgoAdBudget(ctx.tenant_id))) return targeting;
  const { businessCountry } = await import("@/services/ad-locations/country");
  const country = await businessCountry(ctx.tenant_id);
  return country ? { ...targeting, geo_locations: { countries: [country.code] } } : targeting;
}

type Geo = Record<string, unknown> & { countries?: unknown[]; regions?: unknown[]; cities?: unknown[] };

const hasKey = (e: unknown) => !!e && typeof e === "object" && (e as { key?: unknown }).key != null;
const nameOf = (e: unknown): string | null => {
  if (!e || typeof e !== "object") return null;
  const { name, region } = e as { name?: unknown; region?: unknown };
  if (typeof name !== "string" || !name.trim()) return null;
  return typeof region === "string" && region.trim() ? `${name.trim()}, ${region.trim()}` : name.trim();
};

export async function resolveCreateLocations(
  tenant_id: string,
  targeting: Record<string, unknown>,
  locations: readonly string[] | undefined,
): Promise<Record<string, unknown>> {
  const geo = (targeting.geo_locations && typeof targeting.geo_locations === "object" ? targeting.geo_locations : null) as Geo | null;
  const named = (["regions", "cities"] as const).flatMap((k) =>
    Array.isArray(geo?.[k])
      ? (geo![k] as unknown[])
          .filter((e) => !hasKey(e))
          .map(nameOf)
          .filter((n): n is string => n !== null)
          .map((label) => ({ label, kind: k === "regions" ? ("State" as const) : ("City" as const) }))
      : [],
  );
  const wanted: Array<{ label: string; kind?: "City" | "State" }> = [...(locations ?? []).map((label) => ({ label })), ...named];
  if (wanted.length === 0) return targeting;

  const { parseMetaPlaceId, resolvePlaceDetailed } = await import("@/services/ad-locations/places");
  const { businessCountry } = await import("@/services/ad-locations/country");
  const country = await businessCountry(tenant_id);
  const picked: Array<{ type: "country" | "region" | "city"; key: string }> = [];
  const unclear: string[] = [];
  for (const { label, kind } of wanted) {
    const id = parseMetaPlaceId(label.trim());
    if (id) {
      picked.push(id);
      continue;
    }
    let r: Awaited<ReturnType<typeof resolvePlaceDetailed>>;
    try {
      r = await resolvePlaceDetailed(tenant_id, "meta", label, country?.code ?? null, kind);
    } catch (e) {
      throw new ExpectedToolError(
        "meta_ads_location_lookup_failed",
        `Meta's place search failed for "${label}" (${(e as Error).message}). Nothing was proposed; try again shortly.`,
      );
    }
    if (r.status === "resolved") {
      const p = parseMetaPlaceId(r.place.id);
      if (p) picked.push(p);
      else unclear.push(`"${label}": Meta returned an unusable place id`);
    } else if (r.status === "ambiguous") {
      unclear.push(`"${label}" could be ${r.candidates.map((c) => `${c.name} (${c.id})`).join(" or ")}`);
    } else {
      unclear.push(`"${label}": no place found${country ? ` in ${country.name}` : ""}`);
    }
  }
  if (unclear.length > 0) {
    throw new ExpectedToolError(
      "meta_ads_location_unclear",
      `Some locations are not clear: ${unclear.join("; ")}. Ask the founder which place they mean, then propose again with the chosen id (for example "city:2421836") in \`locations\`. Nothing was proposed.`,
    );
  }

  const keyed = (k: "regions" | "cities") => (Array.isArray(geo?.[k]) ? (geo![k] as unknown[]).filter(hasKey) : []);
  const merge = (k: "regions" | "cities", type: "region" | "city") => {
    const out = keyed(k);
    const seen = new Set(out.map((e) => String((e as { key: unknown }).key)));
    for (const p of picked) {
      if (p.type !== type || seen.has(p.key)) continue;
      seen.add(p.key);
      out.push({ key: p.key });
    }
    return out;
  };
  const countries = [
    ...new Set([...(Array.isArray(geo?.countries) ? geo!.countries : []), ...picked.filter((p) => p.type === "country").map((p) => p.key.toUpperCase())]),
  ];
  const next: Geo = { ...(geo ?? {}) };
  delete next.countries;
  delete next.regions;
  delete next.cities;
  if (countries.length) next.countries = countries;
  const regions = merge("regions", "region");
  const cities = merge("cities", "city");
  if (regions.length) next.regions = regions;
  if (cities.length) next.cities = cities;
  return { ...targeting, geo_locations: next };
}

const inputSchema = z.object({
  campaign_id: z.string().min(1),
  name: z.string().min(1).max(200),
  daily_budget_usd: z.number().positive().describe("Daily budget in the ad account's currency (list_ad_sets `currency`, e.g. USD or INR)."),
  optimization_goal: z
    .string()
    .min(1)
    .describe(
      "Meta optimization_goal enum, e.g. OFFSITE_CONVERSIONS, LINK_CLICKS, IMPRESSIONS. See Meta docs.",
    ),
  billing_event: z
    .string()
    .min(1)
    .describe("Meta billing_event enum, e.g. IMPRESSIONS, LINK_CLICKS."),
  targeting: z
    .record(z.string(), z.unknown())
    .describe(
      "Raw Meta targeting JSON. A region or city in geo_locations must carry its Meta key; put place names in `locations` instead.",
    ),
  locations: z
    .array(z.string().trim().min(2).max(120))
    .max(25)
    .optional()
    .describe(
      'Places to show the ad set in, by name ("Austin, TX", "Texas") or by an id the founder picked ("city:2421836"). Each name is resolved to its Meta location before the card is made; an ambiguous or unknown name is refused with the choices, so ask the founder. Never guess.',
    ),
  rationale: rationaleInput(),
  promoted_event: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "ADVISORY LABEL ONLY — never sent to Meta. To actually optimize toward a conversion event you MUST pass promoted_object.",
    ),
  promoted_object: promotedObjectSchema
    .optional()
    .describe(
      "REQUIRED when optimization_goal is conversion-shaped (e.g. OFFSITE_CONVERSIONS): {pixel_id, custom_event_type}. Get a REAL pixel_id from meta_ads_pixel_health for this ad account — never invent one. Without this, Meta rejects the create with a bare 'integer expected, NULL received' 400.",
    ),
  bid_strategy: metaBidStrategySchema
    .optional()
    .describe(
      "Usually omit. If the campaign sets a bid strategy, the ad set follows it: under a bid cap or cost cap Zavi copies the bid from the campaign's ad sets buying the same result and shows it on the card. Set this only when the campaign sets none: LOWEST_COST_WITH_BID_CAP or COST_CAP with bid_amount_usd.",
    ),
  bid_amount_usd: z
    .number()
    .positive()
    .optional()
    .describe("The bid cap or target cost per result, in the ad account's currency: with bid_strategy (a bid cap or cost cap), or alone to choose the amount in a campaign that uses one."),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "If true, returns a pure simulation of the new ad set (budget, PAUSED-on-create, cap-state, today-aggregate-after) and emits NO decision — zero side effect, no spend.",
    ),
});

export const metaProposeNewAdSetTool: ToolSpec = {
  name: "meta_ads_propose_new_ad_set",
  effect: "write",
  description:
    "Propose creating a new Meta ad set under an existing campaign. The founder approves it, or cgo can when Autopilot runs the ads under a budget. The created ad set starts PAUSED; resume it via propose_status_change.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    if (!(await isMetaAdsWriteEnabled())) {
      throw new ExpectedToolError(
        "meta_ads_write_disabled",
        "Meta Ads write is disabled at the platform level.",
      );
    }
    if (typeof ctx.emit_decision !== "function") {
      throw new ExpectedToolError(
        "meta_ads_propose_no_emit",
        "Cannot emit a decision in this context (no emit_decision plumbed).",
      );
    }
    const args = inputSchema.parse(input);

    const { cap, today_total_change_usd, currency } = await readTenantCapAndToday(ctx.tenant_id);

    if (args.dry_run === true) {
      return {
        dry_run: true as const,
        simulation: simulateCreateWrite({
          campaign_id: args.campaign_id,
          name: args.name,
          daily_budget_usd: args.daily_budget_usd,
          today_total_change_usd,
          cap,
        }),
      };
    }

    if (
      cap?.enabled &&
      cap.max_daily_budget_usd != null &&
      args.daily_budget_usd > cap.max_daily_budget_usd
    ) {
      throw new ExpectedToolError(
        "meta_ads_proposal_over_absolute_cap",
        `Proposed daily budget ${formatMoney(args.daily_budget_usd, currency)} exceeds the tenant ceiling ${formatMoney(cap.max_daily_budget_usd, currency)}. Lower the proposal or ask the operator to raise the cap.`,
      );
    }

    const create_body_draft = {
      campaign_id: args.campaign_id,
      name: args.name,
      daily_budget_usd: args.daily_budget_usd,
      currency,
      optimization_goal: args.optimization_goal,
      billing_event: args.billing_event,
      targeting: await withCgoCountryDefault(ctx, await resolveCreateLocations(ctx.tenant_id, args.targeting, args.locations)),
      rationale: args.rationale,
      ...(args.promoted_object ? { promoted_object: args.promoted_object } : {}),
      ...(args.bid_strategy ? { bid_strategy: args.bid_strategy } : {}),
      ...(args.bid_amount_usd !== undefined ? { bid_amount_usd: args.bid_amount_usd } : {}),
    };

    const invalid = (issues: { message: string }[]) =>
      new ExpectedToolError(
        "meta_ads_invalid_create_body",
        `This ad set cannot be created as specified: ${issues.map((i) => i.message).join(" | ")}`,
      );
    const { bid_strategy: _bs, bid_amount_usd: _ba, ...no_bid } = create_body_draft;
    const parsed = createAdSetBodySchema.safeParse(no_bid);
    if (!parsed.success) throw invalid(parsed.error.issues);
    let resolved: Awaited<ReturnType<typeof resolveCreateAdSetBid>>;
    try {
      resolved = await resolveCreateAdSetBid(ctx.tenant_id, {
        ...parsed.data,
        ...(create_body_draft.bid_strategy ? { bid_strategy: create_body_draft.bid_strategy } : {}),
        ...(create_body_draft.bid_amount_usd !== undefined ? { bid_amount_usd: create_body_draft.bid_amount_usd } : {}),
      });
    } catch (e) {
      if (!isRetryableMetaReadError(e)) throw e;
      throw new ExpectedToolError(
        "meta_ads_temporarily_unavailable",
        `Meta did not answer the campaign read (${(e as Error).message.slice(0, 300)}). Nothing was created or sent to approvals. This is temporary: propose the same ad set again in a few minutes.`,
        { next_step: "retry" },
      );
    }
    const with_bid = createAdSetBodySchema.safeParse(resolved);
    if (!with_bid.success) throw invalid(with_bid.error.issues);
    const create_body = with_bid.data;

    const decision_id = await ctx.emit_decision(FINAL_CREATE_CLASS, create_body);
    return {
      decision_id,
      decision_class: FINAL_CREATE_CLASS,
      notice: "Sent to approvals. Nothing is created until it is approved.",
    };
  },
};
