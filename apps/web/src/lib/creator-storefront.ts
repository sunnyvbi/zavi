
export type FeeBreakdown = {
  price_cents: number;
  business_fee_cents: number;
  business_total_cents: number;
  creator_fee_cents: number;
  creator_payout_cents: number;
};

export type StorefrontPackage = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  currency: string;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  addons: Array<{ code: string; price_cents: number }>;
  pricing: FeeBreakdown;
};

export type StorefrontAudienceEntry = {
  label: string;
  value: string;
  self_reported: true;
};

export type CreatorSocial = {
  platform: string;
  handle: string;
  url: string | null;
  followers: number | null;
  label: string;
};

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
  self_reported_audience: StorefrontAudienceEntry[];
  handles: CreatorSocial[];
  packages: StorefrontPackage[];
  from_price_cents: number | null;
  from_price_business_total_cents: number | null;
  joined_at: string | null;
  invited?: boolean;
  status_label?: string;
};

export type FilterOption<T extends string | number = string> = { value: T; label: string };

export type CreatorFilterOptions = {
  platforms: FilterOption[];
  niches: FilterOption[];
  lanes: FilterOption[];
  max_price_cents: FilterOption<number>[];
  max_delivery_days: FilterOption<number>[];
  min_followers: FilterOption<number>[];
  countries: FilterOption[];
};

type PillLabel = { name: string; any: string };

export type CreatorFilterLabels = {
  platforms: PillLabel;
  keyword: { name: string; placeholder: string };
  niches: { name: string };
  lanes: PillLabel;
  max_price_cents: PillLabel;
  max_delivery_days: PillLabel;
  min_followers: PillLabel & { note: string };
  countries: PillLabel;
  order: { name: string };
};

export type CreatorResultsNotes = { summary: string; fee: string };

export type CreatorSearchResponse = {
  creators: CreatorSearchResult[];
  count: number;
  order_applied: string;
  order_label: string;
  order_options: Array<{ value: string; label: string }>;
  neutrality_note: string;
  filter_options?: CreatorFilterOptions;
  filter_labels?: CreatorFilterLabels;
  results_notes?: CreatorResultsNotes;
  self_reported_note: string;
  self_reported_label: string;
  filters: Record<string, unknown>;
  page: { limit: number; offset: number; has_more: boolean };
  invited?: CreatorSearchResult[];
  invited_note?: string;
  invited_page?: { limit: number; offset: number; has_more: boolean; failed?: boolean };
  invited_total?: number | null;
};

export function formatUsd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function locationLabel(loc: {
  city: string | null;
  country_code: string | null;
}): string | null {
  const parts = [loc.city, loc.country_code].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

export const LANE_LABELS: Record<string, string> = {
  ugc_video: "Videos for your ads",
};

export function laneLabel(lane: string): string {
  return LANE_LABELS[lane] ?? "";
}

export function bookingTarget(packageId: string, briefId?: string | null): string {
  const q = new URLSearchParams({ package_id: packageId });
  if (briefId) q.set("brief_id", briefId);
  return `/humans/book?${q.toString()}`;
}
