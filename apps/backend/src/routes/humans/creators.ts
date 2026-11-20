
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { tenantRpc, asTenantId } from "@/services/tenant-client";
import { BUSINESS_FEE_BPS, CREATOR_NICHES, SELF_REPORTED_LABEL, SOCIAL_PLATFORMS, businessTotalCents } from "@zavi/shared";
import { CREATOR_PAYOUT_COUNTRIES } from "@/services/creators/payout-countries";
import {
  notBookableMessage,
  projectPackages,
  projectSocials,
  toSelfReportedAudience,
  SELF_REPORTED_NOTE,
  type CreatorAudienceEntry,
  type CreatorPackageView,
  type CreatorSocial,
} from "@/services/creators/creator-fields";
import { INVITED_NOTE, countInvitedCreators, searchInvitedCreators, type InvitedCreatorResult } from "@/services/creators/invite-messages";

export const NEUTRAL_ORDERS = ["newest", "a_to_z"] as const;
export type NeutralOrder = (typeof NEUTRAL_ORDERS)[number];

export const ORDER_LABELS: Record<NeutralOrder, string> = {
  newest: "Newest first",
  a_to_z: "A to Z",
};

export const NEUTRALITY_NOTE =
  "Zavi does not rank creators and does not pick one for you. Everyone who matches your filters is shown, in the order you chose.";

type FilterOption<T extends string | number> = { value: T; label: string };

const PLATFORM_LABELS: Record<(typeof SOCIAL_PLATFORMS)[number], string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  x: "X",
  linkedin: "LinkedIn",
};

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;
const compact = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1_000 ? `${n / 1_000}k` : String(n));
const regionName = new Intl.DisplayNames(["en"], { type: "region" });

export const FILTER_OPTIONS = {
  platforms: SOCIAL_PLATFORMS.map((v): FilterOption<string> => ({ value: v, label: PLATFORM_LABELS[v] })),
  niches: CREATOR_NICHES.map((v): FilterOption<string> => ({ value: v, label: v })),
  lanes: [
    { value: "ugc_video", label: "UGC video" },
  ] as FilterOption<string>[],
  max_price_cents: [5_000, 10_000, 25_000, 50_000, 100_000].map(
    (v): FilterOption<number> => ({ value: v, label: `A package up to ${usd(v)}` }),
  ),
  max_delivery_days: [3, 7, 14, 30].map((v): FilterOption<number> => ({ value: v, label: `${v} days or less` })),
  min_followers: [1_000, 10_000, 100_000, 1_000_000].map(
    (v): FilterOption<number> => ({ value: v, label: `${compact(v)}+ followers` }),
  ),
  countries: [...CREATOR_PAYOUT_COUNTRIES]
    .map((v): FilterOption<string> => ({ value: v, label: regionName.of(v) ?? v }))
    .sort((a, b) => a.label.localeCompare(b.label)),
} as const;

export const FILTER_LABELS = {
  platforms: { name: "Platform", any: "Any platform" },
  keyword: { name: "Keyword or niche", placeholder: "Search names, handles, niches or packages" },
  niches: { name: "Niches" },
  lanes: { name: "Content type", any: "Any content" },
  max_price_cents: { name: "Price", any: "Any price" },
  max_delivery_days: { name: "Delivery", any: "Any time" },
  min_followers: { name: "Followers", any: "Any following", note: `${SELF_REPORTED_LABEL}.` },
  countries: { name: "Location", any: "Anywhere" },
  order: { name: "Sort" },
} as const;

export const RESULTS_NOTES = {
  summary: "Not ranked by Zavi · Followers self-reported",
  fee: `Book shows what you pay: the creator's price plus Zavi's ${BUSINESS_FEE_BPS / 100}% fee.`,
} as const;

export const MAX_SEARCH_OFFSET = 10_000;

const QuerySchema = z.object({
  order: z.enum(NEUTRAL_ORDERS).default("newest"),
  lane: z.enum(["ugc_video"]).optional(),
  platform: z.string().min(1).max(40).optional(),
  niches: z.array(z.string().min(1).max(60)).max(20).optional(),
  max_price_cents: z.number().int().positive().max(10_000_000).optional(),
  max_delivery_days: z.number().int().min(1).max(90).optional(),
  country_code: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  city: z.string().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(MAX_SEARCH_OFFSET).default(0),
  invited_offset: z.number().int().min(0).max(MAX_SEARCH_OFFSET).optional(),
});

export type CreatorSearchResult = {
  human_member_id: string;
  slug: string;
  display_name: string;
  lanes: string[];
  niches: string[];
  platforms: string[];
  location: { city: string | null; country_code: string | null };
  bookable: boolean;
  not_bookable_message: string | null;
  self_reported_audience: CreatorAudienceEntry[];
  handles: CreatorSocial[];
  packages: CreatorPackageView[];
  from_price_cents: number | null;
  from_price_business_total_cents: number | null;
  joined_at: string | null;
};

function csv(v: unknown): string[] | undefined {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const out = v.split(",").map((s) => s.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function int(v: unknown): number | undefined {
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : Number.NaN;
}

function project(row: Record<string, unknown>): CreatorSearchResult {
  const slug = typeof row.slug === "string" ? row.slug : "";
  const fromPrice =
    row.from_price_cents === null || row.from_price_cents === undefined
      ? null
      : Number(row.from_price_cents);
  const priced = fromPrice !== null && Number.isInteger(fromPrice) && fromPrice > 0 ? fromPrice : null;
  const reason = typeof row.not_bookable_reason === "string" ? row.not_bookable_reason : null;
  return {
    human_member_id: typeof row.human_member_id === "string" ? row.human_member_id : "",
    slug,
    display_name: typeof row.display_name === "string" ? row.display_name : "",
    lanes: Array.isArray(row.lanes) ? row.lanes.map(String) : [],
    niches: Array.isArray(row.niches) ? row.niches.map(String) : [],
    platforms: Array.isArray(row.platforms) ? row.platforms.map(String) : [],
    location: {
      city: typeof row.city === "string" ? row.city : null,
      country_code: typeof row.country_code === "string" ? row.country_code : null,
    },
    bookable: row.bookable === true,
    not_bookable_message:
      row.bookable === true ? null : notBookableMessage(reason ?? "payout_country_unsupported"),
    self_reported_audience: toSelfReportedAudience(row.self_reported_metrics),
    handles: projectSocials(row.handles),
    packages: projectPackages(row.packages),
    from_price_cents: priced,
    from_price_business_total_cents: priced === null ? null : businessTotalCents(priced),
    joined_at: typeof row.joined_at === "string" ? row.joined_at : null,
  };
}

export async function searchCreators(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = QuerySchema.safeParse({
    order: typeof req.query.order === "string" && req.query.order !== "" ? req.query.order : undefined,
    lane: typeof req.query.lane === "string" && req.query.lane !== "" ? req.query.lane : undefined,
    platform:
      typeof req.query.platform === "string" && req.query.platform !== ""
        ? req.query.platform
        : undefined,
    niches: csv(req.query.niches),
    max_price_cents: int(req.query.max_price_cents),
    max_delivery_days: int(req.query.max_delivery_days),
    country_code:
      typeof req.query.country_code === "string" && req.query.country_code !== ""
        ? req.query.country_code
        : undefined,
    city: typeof req.query.city === "string" && req.query.city !== "" ? req.query.city : undefined,
    limit: int(req.query.limit),
    offset: int(req.query.offset),
    invited_offset: int(req.query.invited_offset),
  });

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "bad_search",
        message:
          "Check the filters. `order` must be newest or a_to_z: Zavi has no ranked order to offer.",
      },
    });
    return;
  }
  const q = parsed.data;

  const args = {
    p_order: q.order,
    p_lane: q.lane ?? null,
    p_platform: q.platform ?? null,
    p_niches: q.niches && q.niches.length > 0 ? q.niches : null,
    p_max_price_cents: q.max_price_cents ?? null,
    p_max_delivery_days: q.max_delivery_days ?? null,
    p_country_code: q.country_code ? q.country_code.toUpperCase() : null,
    p_city: q.city ?? null,
    p_limit: q.limit,
    p_offset: q.offset,
  };
  const { data, error } = await tenantRpc(asTenantId(auth.tenant_id), "search_creators", args);

  if (error) {
    res.status(503).json({
      error: { code: "creator_search_failed", message: "Could not search creators just now." },
    });
    return;
  }

  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const creators = rows.map(project);

  let membersHaveMore = false;
  if (creators.length === q.limit && q.offset + q.limit <= MAX_SEARCH_OFFSET) {
    const next = await tenantRpc(asTenantId(auth.tenant_id), "search_creators", {
      ...args,
      p_limit: 1,
      p_offset: q.offset + q.limit,
    });
    membersHaveMore = next.error ? true : Array.isArray(next.data) && next.data.length > 0;
  }

  const invitedOffset = q.invited_offset ?? q.offset;
  let invited: InvitedCreatorResult[] = [];
  let invitedHaveMore = false;
  let invitedFailed = false;
  let invitedTotal: number | null = null;
  const inviteFilters = {
    lane: q.lane ?? null,
    platform: q.platform ?? null,
    needsMemberData: Boolean(
      (q.niches && q.niches.length > 0) || q.max_price_cents || q.max_delivery_days || q.country_code || q.city,
    ),
  };
  try {
    const read = await searchInvitedCreators({
      ...inviteFilters,
      order: q.order,
      limit: q.limit + 1,
      offset: invitedOffset,
    });
    invitedHaveMore = read.length > q.limit && invitedOffset + q.limit <= MAX_SEARCH_OFFSET;
    invited = read.slice(0, q.limit);
  } catch {
    invitedFailed = true;
  }
  if (q.offset === 0 && invitedOffset === 0) {
    try {
      invitedTotal = await countInvitedCreators(inviteFilters);
    } catch {
      invitedTotal = null;
    }
  }

  res.json({
    creators,
    count: creators.length,
    order_applied:
      typeof rows[0]?.order_applied === "string" ? String(rows[0].order_applied) : q.order,
    order_label: ORDER_LABELS[q.order],
    order_options: NEUTRAL_ORDERS.map((o) => ({ value: o, label: ORDER_LABELS[o] })),
    neutrality_note: NEUTRALITY_NOTE,
    filter_options: FILTER_OPTIONS,
    filter_labels: FILTER_LABELS,
    results_notes: RESULTS_NOTES,
    self_reported_note: SELF_REPORTED_NOTE,
    self_reported_label: SELF_REPORTED_LABEL,
    filters: {
      lane: q.lane ?? null,
      platform: q.platform ?? null,
      niches: q.niches ?? [],
      max_price_cents: q.max_price_cents ?? null,
      max_delivery_days: q.max_delivery_days ?? null,
      country_code: q.country_code ? q.country_code.toUpperCase() : null,
      city: q.city ?? null,
    },
    page: { limit: q.limit, offset: q.offset, has_more: membersHaveMore },
    invited,
    invited_note: INVITED_NOTE,
    invited_page: {
      limit: q.limit,
      offset: invitedOffset,
      has_more: invitedHaveMore,
      ...(invitedFailed ? { failed: true } : {}),
    },
    invited_total: invitedTotal,
  });
}
