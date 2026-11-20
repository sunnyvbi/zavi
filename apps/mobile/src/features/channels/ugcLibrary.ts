
import {
  CREATOR_AD_METRICS_ABSTAIN_BODY,
  CREATOR_AD_METRICS_ABSTAIN_TITLE,
  CREATOR_AD_METRICS_MIN_CONVERSIONS,
  CREATOR_AD_METRICS_SCOPE_NOTE,
} from "@zavi/shared";
import { longDay, type LibraryAsset } from "./ugc";

export type Tone = "info" | "warn" | "bad" | "ok" | "neutral";
export type ToneLabel = { label: string; tone: Tone };

export function libraryDay(iso: string | null | undefined): string {
  return longDay(iso) || "unknown";
}

export function fmtBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function libraryHeading(a: Pick<LibraryAsset, "creator_display_name" | "video">): string {
  const size = fmtBytes(a.video?.bytes ?? null);
  return `Approved video${a.creator_display_name ? ` from ${a.creator_display_name}` : ""}${size ? ` · ${size}` : ""}`;
}

export function rightsChip(a: Pick<LibraryAsset, "rights_expired">): ToneLabel {
  return a.rights_expired ? { label: "Rights ended", tone: "bad" } : { label: "Rights active", tone: "ok" };
}

export function metaChip(a: Pick<LibraryAsset, "meta">): ToneLabel | null {
  if (!a.meta?.ad_id) return null;
  return a.meta.auto_paused_at ? { label: "Meta ad paused by Zavi", tone: "warn" } : { label: "In Meta as a paused ad", tone: "info" };
}

export function rightsLine(a: Pick<LibraryAsset, "rights_start_at" | "rights_end_at">): string {
  return `Ad rights run ${libraryDay(a.rights_start_at)} to ${libraryDay(a.rights_end_at)}.`;
}

export function trackingLine(a: Pick<LibraryAsset, "tracking_tag">): string | null {
  return a.tracking_tag ? `Tracking tag ${a.tracking_tag}` : null;
}

const grouped = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "Not read";
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}${grouped(Math.abs(r))}`;
}

export function fmtWholeUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "Not read";
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}$${grouped(Math.abs(r))}`;
}

type Perf = NonNullable<LibraryAsset["ad_performance"]>;

export type AdNumbersView =
  | { kind: "abstain"; title: string; body: string }
  | { kind: "numbers"; title: string; cells: Array<{ label: string; value: string }>; foot: string };

export function adNumbersView(perf: Perf | null | undefined): AdNumbersView | null {
  if (!perf) return null;
  const n = perf.numbers;
  const bar = perf.needed_conversions || CREATOR_AD_METRICS_MIN_CONVERSIONS;
  const conversions = typeof perf.conversions === "number" ? perf.conversions : 0;
  if (!perf.enough_evidence || !n || conversions < bar) {
    const progress = perf.progress_label?.trim();
    return {
      kind: "abstain",
      title: CREATOR_AD_METRICS_ABSTAIN_TITLE,
      body: progress ? `${progress}. ${CREATOR_AD_METRICS_ABSTAIN_BODY}` : CREATOR_AD_METRICS_ABSTAIN_BODY,
    };
  }
  const read = perf.read_at ? longDay(perf.read_at) : "";
  return {
    kind: "numbers",
    title: "What this ad recorded",
    cells: [
      { label: "Spend", value: fmtWholeUsd(n.spend_usd) },
      { label: "Impressions", value: fmtCount(n.impressions) },
      { label: "Clicks", value: fmtCount(n.clicks) },
      { label: "Reach", value: fmtCount(n.reach) },
      { label: "Conversions", value: fmtCount(n.conversions) },
      { label: "Purchases", value: fmtCount(n.purchases) },
      { label: "Purchase value", value: fmtWholeUsd(n.purchase_value_usd) },
    ],
    foot: `${perf.scope_note || CREATOR_AD_METRICS_SCOPE_NOTE}${read ? ` Read ${read}.` : ""}`,
  };
}

const enc = encodeURIComponent;

export const libraryPaths = {
  download: (id: string) => `/api/creators/library/${enc(id)}/download`,
  metaEligibility: (id: string) => `/api/creators/library/${enc(id)}/meta-eligibility`,
  metaAd: (id: string) => `/api/creators/library/${enc(id)}/meta-ad`,
  youtubeVideo: (id: string) => `/api/creators/library/${enc(id)}/youtube-video`,
  youtubeEligibility: (id: string) => `/api/creators/library/${enc(id)}/youtube-eligibility`,
};

export function metaAdBody(adSetId: string, message: string): { ad_set_id: string; message?: string } {
  const text = message.trim();
  return { ad_set_id: adSetId, ...(text ? { message: text } : {}) };
}

export function youtubeVideoBody(paste: string): { youtube_video: string } {
  return { youtube_video: paste.trim() };
}

export function writeError(e: unknown, fallback: string): string {
  const err = e as { message?: unknown; status?: unknown; code?: unknown } | null;
  const status = typeof err?.status === "number" ? err.status : null;
  const code = typeof err?.code === "string" ? err.code : "";
  if (status !== null && (code === "" || code === `http_${status}`)) return `${fallback} (HTTP ${status})`;
  return typeof err?.message === "string" && err.message ? err.message : fallback;
}

export function keepMetaAdKey(e: unknown): boolean {
  const err = e as { status?: unknown; code?: unknown } | null;
  if (typeof err?.status !== "number") return true;
  return err.code === "idempotency_in_progress" || err.code === "idempotency_key_reused";
}

export function metaCreateError(e: unknown): string {
  const err = e as { status?: unknown; code?: unknown } | null;
  if (err?.code === "idempotency_in_progress" || err?.code === "idempotency_key_reused") return "Zavi is still creating this ad. Wait a minute, then try again: it will not make a second one.";
  if (typeof err?.status !== "number") return "Could not reach Zavi. Try again: it will not make a second ad.";
  return writeError(e, "Could not create the ad");
}

export type AdSet = { id: string; name: string; status: string | null };

export type MetaEligibility =
  | { eligible: true; download_available?: boolean; ad_account_id: string; page_id: string; page_name: string | null; ad_sets: AdSet[] }
  | { eligible: false; reason_code: string; reason: string; download_available?: boolean };

export type MetaAdResult = { ad_id?: string; status?: string; rights_end_at?: string; ad_account_id?: string };

export const META_CHECKING = "Checking your Meta connection…";
export const META_STILL_DOWNLOAD = "Download above still works.";
export const META_NO_AD_SETS = "This ad account has no ad set yet. Make one in Meta Ads Manager, then come back.";

export function metaIntro(e: { page_name: string | null; page_id: string; ad_account_id: string }): string {
  return `Posting as ${e.page_name ?? e.page_id} on ${e.ad_account_id}. The ad is created paused in the ad set you pick. Zavi never creates a campaign, an ad set or a budget here.`;
}

export function adSetLabel(s: AdSet): string {
  return `${s.name}${s.status ? ` (${s.status.toLowerCase()})` : ""}`;
}

export function adSetOptions(sets: readonly AdSet[]): Array<{ value: string; label: string }> {
  return sets.map((s) => ({ value: s.id, label: adSetLabel(s) }));
}

export function metaCreatedLine(r: MetaAdResult | null | undefined, a: Pick<LibraryAsset, "rights_end_at">): string | null {
  if (!r?.ad_id) return null;
  return `Created ad ${r.ad_id}, status ${r.status ?? "PAUSED"}. Nothing spends until you turn it on in Meta Ads Manager. Zavi pauses it again on ${libraryDay(r.rights_end_at ?? a.rights_end_at)}.`;
}

export type YoutubeEligibility =
  | { eligible: false; reason_code: string; reason: string; download_available?: boolean; youtube_video_id: string | null }
  | { eligible: true; youtube_video_id: string | null; download_available?: boolean };

export const YOUTUBE_INTRO =
  "Zavi does not upload this video to YouTube. Upload it to your own YouTube channel, paste the link here, and Zavi will propose a YouTube ad against it. Nothing goes live until you approve the proposed change in Zavi and then turn the ad on in Google Ads.";
export const YOUTUBE_CHECKING = "Checking your Google Ads account…";

export function youtubeSavedLine(id: string | null | undefined): string | null {
  return id ? `Saved video id ${id}` : null;
}

export function youtubeSaveLabel(stored: string | null | undefined): string {
  return stored ? "Replace" : "Save";
}
