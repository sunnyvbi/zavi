
import {
  type GrowthLeaderboardCategory,
  type GrowthLeaderboardRankResponse,
  type GrowthLeaderboardResponse,
  type GrowthLeaderboardRow,
  type StartCardDiagnosisEvidence,
  type StartCardLocale,
  type StartCardPart,
  type StartCardProfileEvidence,
  type StartCardScore,
  START_CARD_CHECK_KEYS,
  START_CARD_LOCALES,
  START_CARD_POINTS_PER_CHECK,
} from "@zavi/shared";
import { getSetting } from "@/services/settings";
import { globalClient } from "@/services/tenant-client";

export const MIN_OUT_OF = 3 * START_CARD_POINTS_PER_CHECK;
export const FULL_OUT_OF = START_CARD_CHECK_KEYS.length * START_CARD_POINTS_PER_CHECK;
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;
const PAGE = 1000;
const MAX_ROWS = 5000;
const CACHE_MS = 60_000;
const MISS_REFRESH_MS = 5_000;

export type LeaderboardSourceRow = {
  public_id: string;
  domain: string;
  locale: string;
  score: StartCardScore | null;
  created_at: string;
  profile: StartCardPart<StartCardProfileEvidence> | null;
  diagnosis: StartCardPart<StartCardDiagnosisEvidence> | null;
};

export function categoryOf(profile: StartCardProfileEvidence | null | undefined): GrowthLeaderboardCategory {
  switch (profile?.company_type) {
    case "ecommerce":
      return "ecommerce";
    case "saas":
      return "saas";
    case "marketplace":
      return "marketplace";
    case "services":
      return profile.city ? "local" : "agency";
    case "fintech":
    case "other":
    default:
      return "other";
  }
}

function countryOf(row: LeaderboardSourceRow): StartCardLocale | null {
  const profile = row.profile?.state === "done" ? row.profile.evidence : null;
  if (!profile || profile.country_from === "default_us" || profile.country_from === "visitor") return null;
  return (START_CARD_LOCALES as readonly string[]).includes(row.locale) ? (row.locale as StartCardLocale) : null;
}

function validScore(s: StartCardScore | null): s is StartCardScore {
  return !!s && Number.isFinite(s.total) && Number.isFinite(s.out_of) && s.out_of >= MIN_OUT_OF;
}

export function rankRows(source: LeaderboardSourceRow[], optedOut: ReadonlySet<string> = new Set()): GrowthLeaderboardRow[] {
  const newest = new Map<string, LeaderboardSourceRow>();
  for (const r of source) {
    if (optedOut.has(canonicalHost(r.domain))) continue;
    const cur = newest.get(r.domain);
    if (!cur || r.created_at > cur.created_at) newest.set(r.domain, r);
  }
  const listed = [...newest.values()].filter((r) => validScore(r.score));
  listed.sort((a, b) => b.score!.total - a.score!.total || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

  const out: GrowthLeaderboardRow[] = [];
  listed.forEach((r, i) => {
    const prev = out[i - 1];
    const tied = !!prev && prev.score.total === r.score!.total;
    const profile = r.profile?.state === "done" ? r.profile.evidence : null;
    const diagnosis = r.diagnosis?.state === "done" ? r.diagnosis.evidence : null;
    out.push({
      rank: tied ? prev.rank : i + 1,
      public_id: r.public_id,
      domain: r.domain,
      score: { total: r.score!.total, out_of: FULL_OUT_OF },
      category: categoryOf(profile),
      country: countryOf(r),
      constraint: diagnosis?.constraint?.title?.trim() || null,
      is_new: true,
    });
  });
  return out;
}

export type LeaderboardQuery = {
  category?: GrowthLeaderboardCategory;
  country?: StartCardLocale;
  q?: string;
  offset: number;
  limit: number;
};

export function filterRows(rows: GrowthLeaderboardRow[], query: LeaderboardQuery): { total: number; rows: GrowthLeaderboardRow[] } {
  const q = query.q?.trim().toLowerCase();
  const hits = rows.filter(
    (r) =>
      (!query.category || r.category === query.category) &&
      (!query.country || r.country === query.country) &&
      (!q || r.domain.includes(q)),
  );
  return { total: hits.length, rows: hits.slice(query.offset, query.offset + query.limit) };
}

const canonicalHost = (d: string) => d.toLowerCase().replace(/^www\./, "");

export const LISTABLE_FILTER = "funding_kind.neq.seed,notice_sent_at.not.is.null";

export async function fetchEligibleRows(now: Date = new Date()): Promise<LeaderboardSourceRow[]> {
  const out: LeaderboardSourceRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await globalClient()
      .from("start_cards")
      .select("public_id, domain, locale, score, created_at, profile:parts->profile, diagnosis:parts->diagnosis")
      .eq("status", "done")
      .is("revoked_at", null)
      .gt("expires_at", now.toISOString())
      .not("score", "is", null)
      .or(LISTABLE_FILTER)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`leaderboard read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as LeaderboardSourceRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function fetchOptedOutDomains(domains: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const wanted = [...new Set(domains.map(canonicalHost))];
  for (let i = 0; i < wanted.length; i += OPT_OUT_CHUNK) {
    const chunk = wanted.slice(i, i + OPT_OUT_CHUNK);
    const spellings = chunk.flatMap((d) => [d, `www.${d}`]);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await globalClient()
        .from("start_cards")
        .select("domain")
        .not("revoked_at", "is", null)
        .in("domain", spellings)
        .order("domain")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`leaderboard opt-out read failed: ${error.message}`);
      const rows = (data ?? []) as Array<{ domain: string }>;
      for (const r of rows) out.add(canonicalHost(r.domain));
      if (rows.length < PAGE) break;
    }
    const suppressed = await globalClient().from("seed_suppressions").select("domain").in("domain", chunk);
    if (suppressed.error) throw new Error(`leaderboard suppression read failed: ${suppressed.error.message}`);
    for (const r of (suppressed.data ?? []) as Array<{ domain: string }>) out.add(canonicalHost(r.domain));
  }
  return out;
}

const OPT_OUT_CHUNK = 150;

export async function fetchExcludedDomains(): Promise<Set<string>> {
  const out = new Set<string>();
  const raw = await getSetting("growth_leaderboard_excluded_domains");
  if (Array.isArray(raw)) {
    for (const d of raw) if (typeof d === "string" && d.trim()) out.add(canonicalHost(d.trim()));
  }
  return out;
}

type Cached = { at: number; rows: GrowthLeaderboardRow[]; generated_at: string };
let cache: Cached | null = null;
let inflight: Promise<Cached> | null = null;
let generation = 0;

export async function rankedLeaderboard(
  maxAgeMs: number = CACHE_MS,
): Promise<{ rows: GrowthLeaderboardRow[]; generated_at: string }> {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache;
  if (!inflight) {
    const gen = generation;
    const flight: Promise<Cached> = (async () => {
      const now = Date.now();
      const source = await fetchEligibleRows(new Date(now));
      const optedOut = await fetchOptedOutDomains(source.map((r) => r.domain));
      for (const d of await fetchExcludedDomains()) optedOut.add(d);
      const built = { at: now, rows: rankRows(source, optedOut), generated_at: new Date(now).toISOString() };
      if (gen === generation) cache = built;
      return built;
    })().finally(() => {
      if (inflight === flight) inflight = null;
    });
    inflight = flight;
  }
  return inflight;
}

export function resetLeaderboardCache(): void {
  generation++;
  cache = null;
  inflight = null;
}

export async function getLeaderboard(query: LeaderboardQuery): Promise<GrowthLeaderboardResponse> {
  const { rows, generated_at } = await rankedLeaderboard();
  return { ...filterRows(rows, query), generated_at };
}

export async function getLeaderboardRank(publicId: string): Promise<GrowthLeaderboardRankResponse> {
  let { rows } = await rankedLeaderboard();
  let hit = rows.find((r) => r.public_id === publicId);
  if (!hit) {
    ({ rows } = await rankedLeaderboard(MISS_REFRESH_MS));
    hit = rows.find((r) => r.public_id === publicId);
  }
  return hit ? { listed: true, rank: hit.rank, total: rows.length } : { listed: false };
}
