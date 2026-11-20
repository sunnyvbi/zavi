
import { z } from "zod";
import { CREATOR_NICHES } from "@zavi/shared";
import { tenantRpc, asTenantId } from "@/services/tenant-client";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";

const NEUTRAL_ORDER = "newest";

const SEARCH_LIMIT = 100;

const stem = (w: string) => w.toLowerCase().replace(/s$/, "");

export function mapSkillsToNiches(raw: readonly string[]): { niches: string[]; ignored: string[] } {
  const niches: string[] = [];
  const ignored: string[] = [];
  for (const skill of raw) {
    const key = stem(skill.trim());
    const hit =
      CREATOR_NICHES.find((n) => stem(n) === key) ??
      CREATOR_NICHES.find((n) => n.split(/\s+/).filter((w) => w.toLowerCase() !== "and").some((w) => stem(w) === key));
    if (!hit) {
      if (!ignored.includes(skill)) ignored.push(skill);
    } else if (!niches.includes(hit)) {
      niches.push(hit);
    }
  }
  return { niches, ignored };
}

const LANE_ALIASES: Record<string, string> = {
  ugc_video: "ugc_video",
  ugc_creator: "ugc_video",
  ugc: "ugc_video",
};

export function normalizeLane(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (key === "") return null;
  return LANE_ALIASES[key] ?? key;
}

const inputSchema = z.object({
  lane: z
    .string()
    .max(40)
    .optional()
    .describe(
      "Filter by lane: 'ugc_video' (videos a brand runs as ads), the only lane. " +
        "The older words 'ugc_creator' and 'ugc' are accepted. Omit for all creators.",
    ),
  skills: z
    .array(z.string().min(1).max(60))
    .max(20)
    .optional()
    .describe(
      `Niches, any of: ${CREATOR_NICHES.join(", ")}. Other words are ignored. ` +
        "Matches ANY of them; a filter, not a ranking.",
    ),
  max_rate_usd: z
    .number()
    .nonnegative()
    .max(1000000)
    .optional()
    .describe(
      "Price ceiling in USD for the creator's cheapest package. Creators with NO " +
        "active package are EXCLUDED when this is set. An unknown price is not " +
        "evidence of a cheap one.",
    ),
});

export type HumanCandidate = {
  human_member_id: string;
  slug: string;
  display_name: string;
  lanes: string[];
  niches: string[];
  platforms: string[];
  city: string | null;
  country_code: string | null;
  bookable: boolean;
  self_reported_metrics: Record<string, unknown>;
  from_price_usd: number | null;
  packages: CandidatePackage[];
};

export type CandidatePackage = {
  package_id: string;
  title: string;
  kind: string;
  price_usd: number;
  delivery_days: number | null;
};

export type SearchHumanMembersResult = {
  candidates: HumanCandidate[];
  count: number;
  more_available: boolean;
  bookable_count: number;
  filters: { lane: string | null; skills: string[]; ignored_skills: string[]; max_rate_usd: number | null };
  order_applied: string;
  notice: string;
  next_step: string;
};

const PROJECTION = [
  "human_member_id",
  "slug",
  "display_name",
  "lanes",
  "niches",
  "platforms",
  "city",
  "country_code",
  "bookable",
  "self_reported_metrics",
  "from_price_usd",
  "packages",
] as const;

type RawRow = Record<string, unknown>;

function strArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((s) => String(s)) : [];
}

function projectPackages(raw: unknown, lane: string | null): CandidatePackage[] {
  if (!Array.isArray(raw)) return [];
  const out: CandidatePackage[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const pkg = p as Record<string, unknown>;
    const cents = Number(pkg.price_cents);
    if (typeof pkg.id !== "string" || !Number.isFinite(cents)) continue;
    const kind = typeof pkg.kind === "string" ? pkg.kind : "";
    if (lane !== null && kind !== lane) continue;
    const days = Number(pkg.delivery_days);
    out.push({
      package_id: pkg.id,
      title: typeof pkg.title === "string" ? pkg.title : "",
      kind,
      price_usd: cents / 100,
      delivery_days: pkg.delivery_days === null || pkg.delivery_days === undefined || !Number.isFinite(days) ? null : days,
    });
  }
  return out;
}

function project(row: RawRow, lane: string | null): HumanCandidate {
  const cents =
    row.from_price_cents === null || row.from_price_cents === undefined
      ? null
      : Number(row.from_price_cents);
  return {
    human_member_id: String(row.human_member_id ?? ""),
    slug: String(row.slug ?? ""),
    display_name: String(row.display_name ?? ""),
    lanes: strArray(row.lanes),
    niches: strArray(row.niches),
    platforms: strArray(row.platforms),
    city: typeof row.city === "string" ? row.city : null,
    country_code: typeof row.country_code === "string" ? row.country_code : null,
    bookable: row.bookable === true,
    self_reported_metrics:
      row.self_reported_metrics &&
      typeof row.self_reported_metrics === "object" &&
      !Array.isArray(row.self_reported_metrics)
        ? (row.self_reported_metrics as Record<string, unknown>)
        : {},
    from_price_usd: cents === null || !Number.isFinite(cents) ? null : cents / 100,
    packages: row.bookable === true ? projectPackages(row.packages, lane) : [],
  };
}

const CREATOR_HIRING_AGENTS = new Set(["ugc"]);

export function searchNextStep(count: number, bookable: number, agent_slug?: string): string {
  if (bookable === 0) {
    return (
      (count === 0
        ? "No approved creator matched. Say which filters you used, and do not invent a candidate. "
        : "None of these creators can be booked through Zavi yet. ") +
      "Write the step 'No Zavi creator fits yet: DM creators yourself' with its first DM."
    );
  }
  return (
    "The UGC page already offers these creators under 'Or book a creator directly'. Mention who " +
    "fits and why, in the order the list came in. " +
    (agent_slug && CREATOR_HIRING_AGENTS.has(agent_slug)
      ? "To propose a hire, use creator__book_package with a package_id from that creator's packages, or creator__offer: the founder approves every hire. Do not write a DM or sourcing step."
      : "THE OPERATOR SELECTS: do not pick one, rank one or contact anyone, and do not write a DM or sourcing step.")
  );
}

export const searchHumanMembersTool: ToolSpec = {
  name: "growth_search_human_members",
  effect: "read",
  description:
    "Find approved creators on Zavi's own creator network (who a business can book or message on Zavi), " +
    "for a brief or for a plain 'which creators are on Zavi' ask. Read-only. " +
    "Returns a PII-free list (display name, lanes, niches, platforms, " +
    "city, starting price, active packages with their package_id and price, self-reported audience numbers), never a legal name, email, " +
    "social handle or payout detail. THE LIST IS NOT RANKED: it comes back newest first, " +
    "and `order_applied` says so. With a brief, match against it; either way present the " +
    "candidates to the operator. The founder decides who to work with: propose a hire only " +
    "where the next step in the result says you may, never contact anyone otherwise.",
  input_schema: inputSchema,
  async execute(ctx, input): Promise<SearchHumanMembersResult> {
    const parsed = inputSchema.parse(input);
    const { niches: skills, ignored: ignoredSkills } = mapSkillsToNiches(
      (parsed.skills ?? []).map((s) => s.trim()).filter(Boolean),
    );
    const lane = normalizeLane(parsed.lane);
    const maxRate = parsed.max_rate_usd ?? null;
    const maxPriceCents = maxRate === null ? null : Math.ceil(maxRate * 100);

    if (skills.length === 0 && ignoredSkills.length > 0) {
      ctx.log("creator search skipped: no skill is a niche", { lane, ignored: ignoredSkills.length });
      return {
        candidates: [],
        count: 0,
        more_available: false,
        bookable_count: 0,
        filters: { lane, skills, ignored_skills: ignoredSkills, max_rate_usd: maxRate },
        order_applied: NEUTRAL_ORDER,
        notice:
          "No search was run: none of filters.ignored_skills is a Zavi niche, so no creator was matched. " +
          `Retry with niches from: ${CREATOR_NICHES.join(", ")}. Do not invent a candidate.`,
        next_step:
          "Call growth_search_human_members again with skills that are Zavi niches, or with no skills " +
          "to list every approved creator.",
      };
    }

    const { data, error } = await tenantRpc(asTenantId(ctx.tenant_id), "search_creators", {
      p_order: NEUTRAL_ORDER,
      p_lane: lane,
      p_niches: skills.length > 0 ? skills : null,
      p_max_price_cents: maxPriceCents,
      p_limit: SEARCH_LIMIT,
    });

    if (error) {
      ctx.log("search_creators rpc failed", { message: error.message });
      throw new ExpectedToolError(
        "human_search_failed",
        "Could not search the creator network. Report the brief to the operator and note that " +
          "candidate matching is unavailable this run, so the work is not lost.",
      );
    }

    const rows: RawRow[] = Array.isArray(data) ? (data as RawRow[]) : [];
    const candidates = rows.map((row) => project(row, lane));
    const orderApplied =
      typeof rows[0]?.order_applied === "string" ? String(rows[0].order_applied) : NEUTRAL_ORDER;

    const bookableCount = candidates.filter((c) => c.bookable).length;
    const moreAvailable = rows.length >= SEARCH_LIMIT;
    ctx.log("creator search", { count: candidates.length, lane, skills: skills.length });

    return {
      candidates,
      count: candidates.length,
      more_available: moreAvailable,
      bookable_count: bookableCount,
      filters: { lane, skills, ignored_skills: ignoredSkills, max_rate_usd: maxRate },
      order_applied: orderApplied,
      notice:
        "Approved creators only. THIS LIST IS NOT RANKED. It is ordered '" +
        orderApplied +
        "', and Zavi does not score fit or quality. Say that when you present it. " +
        "self_reported_metrics are SELF-REPORTED by the creator: label them as such and never " +
        "present them as measured performance. A candidate with bookable=false cannot be paid " +
        "by Zavi yet, so say so instead of proposing them. Contact details and social handles " +
        "are deliberately not available to you." +
        (ignoredSkills.length > 0 ? " filters.ignored_skills are not Zavi niches and were not searched." : "") +
        (moreAvailable ? " More creators match than are listed: count is not the total." : ""),
      next_step: searchNextStep(candidates.length, bookableCount, ctx.agent_slug),
    };
  },
};

export const __projection = PROJECTION;
