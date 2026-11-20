
import { globalClient } from "@/services/tenant-client";
import {
  packageFeeLine,
  readSelfReportedMetrics,
  type PackageFeeLine,
  type SelfReportedMetrics,
} from "@zavi/shared";
import { readHandles, readPackages, type CreatorPackageRow, type HumanMemberRow } from "@/services/humans/store";
import { creatorPayoutCountrySupported } from "@/services/creators/payout-countries";

export type ApplicantPackageView = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  delivery_days: number;
  video_count: number | null;
  video_length_seconds: number | null;
  ad_rights_days: number | null;
  addons: Array<{ code: string; price_cents: number } & PackageFeeLine>;
  fee: PackageFeeLine;
};

export type ApplicantApplicationView = {
  id: string;
  discipline: string;
  handle: string;
  platform: string;
  handles: Array<{ platform: string; handle: string }>;
  niches: string[];
  rate_usd: number | null;
  bio: string;
  portfolio_urls: string[];
  proof_count: number;
  vetting_state: string;
  rejected_reason: string | null;
  submitted_at: string | null;
  reviewer_opened_at: string | null;
  queue_position: number | null;
  slug: string | null;
  lanes: string[];
  city: string | null;
  country_code: string | null;
  payout_country_supported: boolean | null;
  intro_video_path: string | null;
  sample_video_paths: string[];
  packages: ApplicantPackageView[];
  audience: SelfReportedMetrics;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

async function queuePosition(member: HumanMemberRow): Promise<number | null> {
  if (member.vetting_state !== "pending") return null;
  const { count, error } = await globalClient()
    .from("human_members")
    .select("id", { count: "exact", head: true })
    .eq("vetting_state", "pending")
    .lt("created_at", member.created_at);
  if (error || count === null) return null;
  return count + 1;
}

function packageView(row: CreatorPackageRow): ApplicantPackageView {
  const addons = Array.isArray(row.addons) ? row.addons : [];
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    delivery_days: row.delivery_days,
    video_count: row.video_count,
    video_length_seconds: row.video_length_seconds,
    ad_rights_days: row.ad_rights_days,
    addons: addons.map((a) => ({ ...a, ...packageFeeLine(a.price_cents) })),
    fee: packageFeeLine(row.price_cents),
  };
}

export async function applicantView(member: HumanMemberRow): Promise<ApplicantApplicationView> {
  const [handles, position, packages] = await Promise.all([
    readHandles(member.id),
    queuePosition(member),
    readPackages(member.id),
  ]);
  const profile = (member.profile ?? {}) as Record<string, unknown>;
  const primary = handles[0];
  return {
    id: member.id,
    discipline: member.discipline,
    handle: primary?.handle ?? "",
    platform: primary?.platform ?? "",
    handles: handles.map((h) => ({ platform: h.platform, handle: h.handle })),
    niches: stringArray(member.skills),
    rate_usd: member.rate_usd,
    bio: member.bio ?? "",
    portfolio_urls: stringArray(profile.portfolio_urls),
    proof_count: stringArray(profile.screenshots).length,
    vetting_state: member.vetting_state,
    rejected_reason: member.rejected_reason,
    submitted_at: member.created_at,
    reviewer_opened_at: null,
    queue_position: position,
    slug: member.slug ?? null,
    lanes: Array.isArray(member.lanes) ? [...member.lanes] : [],
    city: member.city ?? null,
    country_code: member.country_code ?? null,
    payout_country_supported: member.country_code
      ? creatorPayoutCountrySupported(member.country_code)
      : null,
    intro_video_path: member.intro_video_path ?? null,
    sample_video_paths: stringArray(member.sample_video_paths),
    packages: packages.map(packageView),
    audience: readSelfReportedMetrics(member.public_metrics),
  };
}
