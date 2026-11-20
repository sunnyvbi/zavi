
import {
  START_CARD_CHECK_KEYS,
  START_CARD_POINTS_PER_CHECK,
  type StartCard,
  type StartCardCheckKey,
  type GrowthLeaderboardRankResponse,
  type GrowthLeaderboardResponse,
  type StartCardConfigResponse,
  type StartCardCreateResponse,
  type StartCardPart,
  type StartCardProfileEvidence,
  type StartCardQueueResponse,
} from "@zavi/shared";

import { readCountry } from "@/lib/region";

const BACKEND_URL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_BACKEND_URL) || "http://localhost:3001";

export function startCardApiUrl(path: string): string {
  return `${BACKEND_URL}/api/public/start-card${path}`;
}

export const START_CARD_PUBLIC_ID_RE = /^[A-Za-z0-9]{16,32}$/;

export type ApiError = { code: string; message: string };

export class StartCardApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const GENERIC = "Something went wrong. Please try again.";

async function readError(res: Response): Promise<StartCardApiError> {
  const body = (await res.json().catch(() => null)) as { error?: Partial<ApiError> } | null;
  return new StartCardApiError(body?.error?.code ?? "server_error", body?.error?.message ?? GENERIC, res.status);
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(startCardApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export async function fetchStartCardConfig(): Promise<StartCardConfigResponse> {
  const res = await fetch(startCardApiUrl("/config"), { method: "GET" });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as StartCardConfigResponse;
}

export function createStartCard(input: {
  url: string;
  turnstile_token: string | null;
  ref: string | null;
}): Promise<StartCardCreateResponse> {
  return post<StartCardCreateResponse>("", { ...input, visitor_country: readCountry() });
}

export function queueStartCard(input: {
  url: string;
  email: string;
  turnstile_token: string | null;
}): Promise<StartCardQueueResponse> {
  return post<StartCardQueueResponse>("/queue", input);
}

export type StartCardReportResponse = { state: "verify_sent" | "received" };

export function reportStartCard(input: {
  public_id: string;
  email: string;
  reason: string;
  turnstile_token: string | null;
}): Promise<StartCardReportResponse> {
  return post<StartCardReportResponse>("/report", input);
}

export async function getStartCard(publicId: string, init?: RequestInit): Promise<StartCard | null> {
  if (!START_CARD_PUBLIC_ID_RE.test(publicId)) return null;
  const res = await fetch(startCardApiUrl(`/${publicId}`), { method: "GET", ...init });
  if (res.status === 404) return null;
  if (!res.ok) throw await readError(res);
  return (await res.json()) as StartCard;
}

export type LeaderboardParams = {
  category?: string;
  country?: string;
  q?: string;
  offset?: number;
  limit?: number;
};

export async function getLeaderboard(params: LeaderboardParams, init?: RequestInit): Promise<GrowthLeaderboardResponse | null> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const query = qs.toString();
  const res = await fetch(`${BACKEND_URL}/api/public/leaderboard${query ? `?${query}` : ""}`, { method: "GET", ...init });
  if (res.status === 404) return null;
  if (!res.ok) throw await readError(res);
  return (await res.json()) as GrowthLeaderboardResponse;
}

export async function getLeaderboardRank(publicId: string, retryMs = 5500): Promise<GrowthLeaderboardRankResponse> {
  if (!START_CARD_PUBLIC_ID_RE.test(publicId)) return { listed: false };
  const ask = async (): Promise<GrowthLeaderboardRankResponse> => {
    const res = await fetch(`${BACKEND_URL}/api/public/leaderboard/rank/${publicId}`, { method: "GET", cache: "no-store" });
    if (res.status === 404) return { listed: false };
    if (!res.ok) throw await readError(res);
    return (await res.json()) as GrowthLeaderboardRankResponse;
  };
  const first = await ask();
  if (first.listed || retryMs <= 0) return first;
  await new Promise((r) => setTimeout(r, retryMs));
  return ask();
}

export const MY_CARD_KEY = "zavi_my_growth_card";

export function rememberMyCard(publicId: string): void {
  if (!START_CARD_PUBLIC_ID_RE.test(publicId)) return;
  try {
    window.localStorage.setItem(MY_CARD_KEY, publicId);
  } catch {
  }
}

export function readMyCard(): string | null {
  try {
    const v = window.localStorage.getItem(MY_CARD_KEY);
    return v && START_CARD_PUBLIC_ID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export const CHECK_LABELS: Record<StartCardCheckKey, string> = {
  google: "Found on Google",
  ai: "Shows up in AI answers",
  seo: "SEO & site basics",
  design: "Design & UX",
  compare: "Vs your competitors",
};

export type CheckRow = {
  key: StartCardCheckKey;
  label: string;
  state: "pending" | "done" | "unavailable";
  points: number | null;
  max: number;
  note: string | null;
};

export function checkRows(card: StartCard | null): CheckRow[] {
  return START_CARD_CHECK_KEYS.map((key) => {
    const part = card?.parts?.[key] as StartCardPart<{ note?: string }> | undefined;
    const state = part?.state ?? "pending";
    return {
      key,
      label: CHECK_LABELS[key],
      state,
      points: state === "done" && typeof part?.points === "number" ? part.points : null,
      max: part?.max_points ?? START_CARD_POINTS_PER_CHECK,
      note: state === "done" ? (part?.evidence?.note ?? null) : null,
    };
  });
}

export function checksSettled(card: StartCard | null): boolean {
  if (!card) return false;
  return checkRows(card).every((r) => r.state !== "pending") && card.score != null;
}

export function finalReady(card: StartCard | null): boolean {
  if (!card || card.score == null) return false;
  if (card.status === "done" || card.status === "failed") return true;
  const d = card.parts?.diagnosis?.state;
  return d === "done" || d === "unavailable";
}

export function profileOf(card: StartCard | null): StartCardProfileEvidence | null {
  const p = card?.parts?.profile;
  return p?.state === "done" && p.evidence ? p.evidence : null;
}

export function countryPhrase(profile: StartCardProfileEvidence | null): string | null {
  if (!profile) return null;
  const label = profile.country_label || COUNTRY_NAMES[profile.country] || profile.country;
  return /^(United |Netherlands|Philippines)/.test(label) ? `the ${label}` : label;
}

export function countryName(code: string): string {
  return COUNTRY_NAMES[code] ?? code;
}

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  IN: "India",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  SG: "Singapore",
  AE: "United Arab Emirates",
  IE: "Ireland",
  NZ: "New Zealand",
  DE: "Germany",
  FR: "France",
};

export type RivalRow = {
  name: string;
  score: string | null;
  source: string | null;
  sourceUrl: string | null;
};

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function rivalRows(card: StartCard | null): {
  rows: RivalRow[];
  you: string | null;
  outOf: number | null;
  usedLabel: string;
} {
  const profile = profileOf(card);
  const compare = card?.parts?.compare;
  const compareSettled = compare?.state === "done" || compare?.state === "unavailable";
  const ranking = compare?.state === "done" ? compare.evidence?.ranking ?? [] : [];
  const used = compare?.state === "done" ? compare.evidence?.checks_used : undefined;
  const outOf = ranking.length ? START_CARD_POINTS_PER_CHECK * (used?.length ?? 4) : null;
  const rows = (profile?.rivals ?? []).slice(0, 3).map((r) => {
    let score: string | null = null;
    if (r.no_site || !r.domain) score = "no site found";
    else if (compareSettled) {
      const hit = ranking.find((x) => !x.is_business && x.domain === r.domain);
      score = hit && outOf ? `${hit.checks_total}/${outOf}` : "not measured";
    }
    return { name: r.name, score, source: hostOf(r.source_url), sourceUrl: r.source_url };
  });
  const me = ranking.find((x) => x.is_business);
  return {
    rows,
    you: me && outOf ? `${me.checks_total}/${outOf}` : null,
    outOf,
    usedLabel: joinAnd((used ?? []).map((k) => COMPARE_WORDS[k] ?? k)),
  };
}

const COMPARE_WORDS: Partial<Record<StartCardCheckKey, string>> = {
  google: "Google",
  ai: "AI answers",
  seo: "SEO",
  design: "design",
};

function joinAnd(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function resultPath(publicId: string): string {
  return `/r/${publicId}`;
}

export function challengePath(publicId: string): string {
  return `/start?ref=${encodeURIComponent(publicId)}`;
}
