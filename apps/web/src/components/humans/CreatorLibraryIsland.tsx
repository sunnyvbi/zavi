"use client";

import { useCallback, useState } from "react";
import {
  CREATOR_AD_METRICS_ABSTAIN_BODY,
  CREATOR_AD_METRICS_ABSTAIN_TITLE,
} from "@zavi/shared";
import { HumanSectionShell } from "./HumanSectionShell";
import { HumanSectionTabs } from "./HumanSectionTabs";
import {
  HumanCard,
  HumanChip,
  HumanEmpty,
  HumanError,
  HumanNotBuilt,
  HumanSessionExpired,
  HumanSkeleton,
} from "./HumanStates";
import { useHumanResource } from "./useHumanResource";
import { apiFetch } from "@/lib/api";

export type LibraryAsset = {
  id: string;
  order_id: string;
  submission_id: string;
  human_member_id: string;
  rights_start_at: string;
  rights_end_at: string;
  rights_expired: boolean;
  tracking_tag: string;
  two_clocks_warning: string | null;
  video: { kind: string; storage_path: string; mime_type: string | null; bytes: number | null } | null;
  meta: {
    ad_account_id: string | null;
    video_id: string | null;
    ad_id: string | null;
    ad_set_id: string | null;
    auto_paused_at: string | null;
  } | null;
  ad_performance: AdPerformance | null;
  youtube: { video_id: string } | null;
  creator_display_name?: string | null;
  source_channel?: string | null;
};

type AdPerformance = {
  enough_evidence: boolean;
  conversions: number;
  needed_conversions: number;
  progress_label: string | null;
  read_at: string;
  scope_note: string;
  numbers: {
    spend_usd: number;
    impressions: number;
    clicks: number;
    reach: number;
    conversions: number;
    purchases: number;
    purchase_value_usd: number;
  } | null;
};

type LibraryResponse = { assets: LibraryAsset[] };

type Eligibility =
  | {
      eligible: true;
      download_available: boolean;
      ad_account_id: string;
      page_id: string;
      page_name: string | null;
      ad_sets: Array<{ id: string; name: string; status: string | null }>;
    }
  | {
      eligible: false;
      reason_code: string;
      reason: string;
      download_available: boolean;
    };

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtUsd(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtBytes(bytes: number | null): string | null {
  if (bytes == null || !Number.isFinite(bytes)) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function CreatorLibraryIsland() {
  const { data, loading, error, sessionExpired, notBuilt, reload } =
    useHumanResource<LibraryResponse>("/api/creators/library");

  return (
    <HumanSectionShell
      title="Library"
      lede="Every approved creator video, the dates its ad rights run between, the tracking tag to use, and a download. When Meta Ads is connected you can also drop one into your ad account as a paused draft ad."
    >
      <HumanSectionTabs active="/humans/library" />
      {sessionExpired ? (
        <HumanSessionExpired next="/humans/library" />
      ) : notBuilt ? (
        <HumanNotBuilt what="The Creators Library" />
      ) : loading && !data ? (
        <HumanSkeleton />
      ) : error ? (
        <HumanError message={error} onRetry={reload} />
      ) : !data || data.assets.length === 0 ? (
        <HumanEmpty
          title="No approved videos yet"
          body="When you approve a creator's video, it lands here with its rights dates and a download."
        />
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          {data.assets.map((asset) => (
            <LibraryRow key={asset.id} asset={asset} onChanged={reload} />
          ))}
        </div>
      )}
    </HumanSectionShell>
  );
}

export async function downloadLibraryVideo(assetId: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/creators/library/${assetId}/download`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      return body?.error?.message ?? `Download failed (HTTP ${res.status})`;
    }
    const { url } = (await res.json()) as { url: string };
    window.open(url, "_blank", "noopener,noreferrer");
    return null;
  } catch (e) {
    return (e as Error).message || "Download failed";
  }
}

function LibraryRow({ asset, onChanged }: { asset: LibraryAsset; onChanged: () => void }) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [youtubeOpen, setYoutubeOpen] = useState(false);

  const download = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    setDownloadError(await downloadLibraryVideo(asset.id));
    setDownloading(false);
  }, [asset.id]);

  const size = fmtBytes(asset.video?.bytes ?? null);

  return (
    <HumanCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[16px] font-semibold leading-5 text-ink">
            Approved video{asset.creator_display_name ? ` from ${asset.creator_display_name}` : ""}
            {size ? ` · ${size}` : ""}
          </p>
          <p className="mt-1 text-[13px] leading-5 text-inkMuted">
            Ad rights run {fmtDate(asset.rights_start_at)} to {fmtDate(asset.rights_end_at)}.
          </p>
          <p className="mt-1 text-[12px] leading-5 text-inkMuted">
            Tracking tag <span className="font-mono">{asset.tracking_tag}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {asset.rights_expired ? (
            <HumanChip tone="bad">Rights ended</HumanChip>
          ) : (
            <HumanChip tone="ok">Rights active</HumanChip>
          )}
          {asset.meta?.ad_id ? (
            <HumanChip tone={asset.meta.auto_paused_at ? "warn" : "info"}>
              {asset.meta.auto_paused_at ? "Meta ad paused by Zavi" : "In Meta as a paused ad"}
            </HumanChip>
          ) : null}
        </div>
      </div>

      <AdNumbers perf={asset.ad_performance} />

      {asset.two_clocks_warning ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-800 ring-1 ring-inset ring-amber-200">
          {asset.two_clocks_warning}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void download()}
          disabled={downloading}
          className="rounded-cta border border-ink/[0.12] bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.03] disabled:opacity-50"
        >
          {downloading ? "Preparing…" : "Download"}
        </button>
        <button
          type="button"
          onClick={() => setMetaOpen((v) => !v)}
          className="rounded-cta border border-ink/[0.12] bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.03]"
        >
          {metaOpen ? "Hide Meta options" : "Use in Meta Ads"}
        </button>
        <button
          type="button"
          onClick={() => setYoutubeOpen((v) => !v)}
          className="rounded-cta border border-ink/[0.12] bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.03]"
        >
          {youtubeOpen ? "Hide YouTube options" : "Use in YouTube Ads"}
        </button>
      </div>

      {downloadError ? (
        <p className="mt-2 text-[12px] leading-5 text-rose-700">{downloadError}</p>
      ) : null}

      {metaOpen ? <MetaPanel asset={asset} onCreated={onChanged} /> : null}
      {youtubeOpen ? <YoutubePanel asset={asset} onChanged={onChanged} /> : null}
    </HumanCard>
  );
}

function AdNumbers({ perf }: { perf: AdPerformance | null }) {
  if (!perf) return null;

  if (!perf.enough_evidence || !perf.numbers) {
    return (
      <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-inset ring-slate-200">
        <p className="text-[13px] font-medium leading-5 text-ink">
          {CREATOR_AD_METRICS_ABSTAIN_TITLE}
        </p>
        <p className="mt-0.5 text-[12px] leading-5 text-inkMuted">
          {perf.progress_label}. {CREATOR_AD_METRICS_ABSTAIN_BODY}
        </p>
      </div>
    );
  }

  const n = perf.numbers;
  const cells: Array<[string, string]> = [
    ["Spend", fmtUsd(n.spend_usd)],
    ["Impressions", fmtCount(n.impressions)],
    ["Clicks", fmtCount(n.clicks)],
    ["Reach", fmtCount(n.reach)],
    ["Conversions", fmtCount(n.conversions)],
    ["Purchases", fmtCount(n.purchases)],
    ["Purchase value", fmtUsd(n.purchase_value_usd)],
  ];

  return (
    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2.5 ring-1 ring-inset ring-slate-200">
      <p className="text-[13px] font-medium leading-5 text-ink">What this ad recorded</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        {cells.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[11px] uppercase tracking-wide text-inkMuted">{label}</dt>
            <dd className="text-[13px] font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[12px] leading-4 text-inkMuted">
        {perf.scope_note} Read {fmtDate(perf.read_at)}.
      </p>
    </div>
  );
}

export function MetaPanel({ asset, onCreated }: { asset: LibraryAsset; onCreated: () => void }) {
  const { data, loading, error, reload } = useHumanResource<Eligibility>(
    `/api/creators/library/${asset.id}/meta-eligibility`,
  );
  const [adSetId, setAdSetId] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ ad_id: string; status: string } | null>(null);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await apiFetch(`/api/creators/library/${asset.id}/meta-ad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ad_set_id: adSetId, ...(message ? { message } : {}) }),
        idempotent: true,
      });
      const body = (await res.json().catch(() => null)) as
        | { ad_id?: string; status?: string; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setSubmitError(body?.error?.message ?? `Could not create the ad (HTTP ${res.status})`);
        return;
      }
      if (body?.ad_id) setCreated({ ad_id: body.ad_id, status: body.status ?? "PAUSED" });
      onCreated();
    } catch (e) {
      setSubmitError((e as Error).message ?? "Could not create the ad");
    } finally {
      setSubmitting(false);
    }
  }, [adSetId, asset.id, message, onCreated]);

  if (loading && !data) {
    return <p className="mt-3 text-[13px] leading-5 text-inkMuted">Checking your Meta connection…</p>;
  }
  if (error) {
    return (
      <div className="mt-3">
        <HumanError message={error} onRetry={reload} />
      </div>
    );
  }
  if (!data) return null;

  if (!data.eligible) {
    return (
      <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-inset ring-slate-200">
        <p className="text-[13px] leading-5 text-ink">{data.reason}</p>
        <p className="mt-1 text-[12px] leading-5 text-inkMuted">
          Download above still works.
        </p>
      </div>
    );
  }

  if (created) {
    return (
      <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 ring-1 ring-inset ring-emerald-200">
        <p className="text-[13px] leading-5 text-emerald-900">
          Created ad {created.ad_id}, status {created.status}. Nothing spends until you turn it on in
          Meta Ads Manager. Zavi pauses it again on {fmtDate(asset.rights_end_at)}.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-3 ring-1 ring-inset ring-slate-200">
      <p className="text-[12px] leading-5 text-inkMuted">
        Posting as {data.page_name ?? data.page_id} on {data.ad_account_id}. The ad is created paused
        in the ad set you pick. Zavi never creates a campaign, an ad set or a budget here.
      </p>
      <label className="mt-3 block text-[14px] font-medium text-ink" htmlFor={`adset-${asset.id}`}>
        Ad set
      </label>
      <select
        id={`adset-${asset.id}`}
        value={adSetId}
        onChange={(e) => setAdSetId(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
      >
        <option value="">Pick an ad set</option>
        {data.ad_sets.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.status ? ` (${s.status.toLowerCase()})` : ""}
          </option>
        ))}
      </select>
      {data.ad_sets.length === 0 ? (
        <p className="mt-2 text-[12px] leading-5 text-inkMuted">
          This ad account has no ad set yet. Make one in Meta Ads Manager, then come back.
        </p>
      ) : null}

      <label className="mt-3 block text-[14px] font-medium text-ink" htmlFor={`msg-${asset.id}`}>
        Primary text (optional)
      </label>
      <textarea
        id={`msg-${asset.id}`}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
        maxLength={2000}
        className="mt-1 w-full rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
      />

      <button
        type="button"
        onClick={() => void submit()}
        disabled={submitting || !adSetId}
        className="mt-3 rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
      >
        {submitting ? "Uploading to Meta…" : "Create paused ad"}
      </button>
      {submitError ? (
        <p className="mt-2 text-[12px] leading-5 text-rose-700">{submitError}</p>
      ) : null}
    </div>
  );
}

type YoutubeAdGroup = {
  id: string;
  name: string;
  status: string | null;
  format: string;
  campaign_name: string | null;
};

type YoutubeEligibility =
  | {
      eligible: true;
      download_available: boolean;
      youtube_video_id: string | null;
      tracking_tag: string;
      ad_groups: YoutubeAdGroup[];
    }
  | {
      eligible: false;
      reason_code: string;
      reason: string;
      download_available: boolean;
      youtube_video_id: string | null;
    };

const FORMAT_HINT: Record<string, string> = {
  in_stream_skippable: "Skippable in-stream: needs a landing page URL. A headline and button label are optional.",
  in_stream_non_skippable: "Non-skippable in-stream: needs a landing page URL. A headline and button label are optional.",
  bumper: "Bumper (6s): no copy needed. A landing page URL is optional.",
  in_feed: "In-feed: needs a headline and both descriptions. No landing page URL.",
  responsive: "Responsive: needs a landing page URL, a headline, a long headline and description 1.",
};

export function YoutubePanel({ asset, onChanged }: { asset: LibraryAsset; onChanged: () => void }) {
  const { data, loading, error, reload } = useHumanResource<YoutubeEligibility>(
    `/api/creators/library/${asset.id}/youtube-eligibility`,
  );

  const [storedId, setStoredId] = useState<string | null>(asset.youtube?.video_id ?? null);
  const [paste, setPaste] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [adGroupId, setAdGroupId] = useState("");
  const [finalUrl, setFinalUrl] = useState("");
  const [headline, setHeadline] = useState("");
  const [longHeadline, setLongHeadline] = useState("");
  const [description1, setDescription1] = useState("");
  const [description2, setDescription2] = useState("");
  const [callToAction, setCallToAction] = useState("");
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [proposed, setProposed] = useState<{ decision_id: string; note: string } | null>(null);

  const saveVideoId = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch(`/api/creators/library/${asset.id}/youtube-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtube_video: paste }),
      });
      const body = (await res.json().catch(() => null)) as
        | { youtube_video_id?: string; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setSaveError(body?.error?.message ?? `Could not save the video id (HTTP ${res.status})`);
        return;
      }
      if (body?.youtube_video_id) {
        setStoredId(body.youtube_video_id);
        setPaste("");
      }
      onChanged();
    } catch (e) {
      setSaveError((e as Error).message ?? "Could not save the video id");
    } finally {
      setSaving(false);
    }
  }, [asset.id, onChanged, paste]);

  const propose = useCallback(async () => {
    setProposing(true);
    setProposeError(null);
    try {
      const res = await apiFetch(`/api/creators/library/${asset.id}/youtube-ad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ad_group_id: adGroupId,
          ...(finalUrl ? { final_url: finalUrl } : {}),
          ...(headline ? { headline } : {}),
          ...(longHeadline ? { long_headline: longHeadline } : {}),
          ...(description1 ? { description1 } : {}),
          ...(description2 ? { description2 } : {}),
          ...(callToAction ? { call_to_action: callToAction } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { decision_id?: string; note?: string; error?: { message?: string } }
        | null;
      if (!res.ok) {
        setProposeError(body?.error?.message ?? `Could not propose the ad (HTTP ${res.status})`);
        return;
      }
      if (body?.decision_id) {
        setProposed({ decision_id: body.decision_id, note: body.note ?? "" });
      }
      onChanged();
    } catch (e) {
      setProposeError((e as Error).message ?? "Could not propose the ad");
    } finally {
      setProposing(false);
    }
  }, [
    adGroupId,
    asset.id,
    callToAction,
    description1,
    description2,
    finalUrl,
    headline,
    longHeadline,
    onChanged,
  ]);

  const adGroups = data && data.eligible ? data.ad_groups : [];
  const pickedFormat = adGroups.find((g) => g.id === adGroupId)?.format ?? null;

  return (
    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-3 ring-1 ring-inset ring-slate-200">
      <p className="text-[12px] leading-5 text-inkMuted">
        Zavi does not upload this video to YouTube. Upload it to your own YouTube channel, paste the
        link here, and Zavi will propose a YouTube ad against it. Nothing goes live until you approve
        the proposed change in Zavi and then turn the ad on in Google Ads.
      </p>

      <label className="mt-3 block text-[14px] font-medium text-ink" htmlFor={`yt-${asset.id}`}>
        YouTube video link or id
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          id={`yt-${asset.id}`}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          maxLength={500}
          className="min-w-0 flex-1 rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
        />
        <button
          type="button"
          onClick={() => void saveVideoId()}
          disabled={saving || paste.trim().length === 0}
          className="rounded-cta border border-ink/[0.12] bg-white px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/[0.03] disabled:opacity-40"
        >
          {saving ? "Saving…" : storedId ? "Replace" : "Save"}
        </button>
      </div>
      {storedId ? (
        <p className="mt-2 text-[12px] leading-5 text-inkMuted">
          Saved video id <span className="font-mono">{storedId}</span>
        </p>
      ) : null}
      {saveError ? (
        <p className="mt-2 text-[12px] leading-5 text-rose-700">{saveError}</p>
      ) : null}

      {loading && !data ? (
        <p className="mt-3 text-[13px] leading-5 text-inkMuted">Checking your Google Ads account…</p>
      ) : error ? (
        <div className="mt-3">
          <HumanError message={error} onRetry={reload} />
        </div>
      ) : !data ? null : !data.eligible ? (
        <p className="mt-3 rounded-lg bg-white px-3 py-2 text-[13px] leading-5 text-ink ring-1 ring-inset ring-slate-200">
          {data.reason}
        </p>
      ) : proposed ? (
        <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 ring-1 ring-inset ring-emerald-200">
          <p className="text-[13px] leading-5 text-emerald-900">
            Proposed. {proposed.note}
          </p>
        </div>
      ) : (
        <div className="mt-3 border-t border-ink/[0.08] pt-3">
          <label
            className="block text-[14px] font-medium text-ink"
            htmlFor={`yt-group-${asset.id}`}
          >
            Video ad group
          </label>
          <select
            id={`yt-group-${asset.id}`}
            value={adGroupId}
            onChange={(e) => setAdGroupId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
          >
            <option value="">Pick a video ad group</option>
            {adGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.campaign_name ? `${g.campaign_name} · ` : ""}
                {g.name}
                {g.status ? ` (${g.status.toLowerCase()})` : ""}
              </option>
            ))}
          </select>
          {pickedFormat ? (
            <p className="mt-2 text-[12px] leading-5 text-inkMuted">
              {FORMAT_HINT[pickedFormat] ?? `Format: ${pickedFormat}`}
            </p>
          ) : null}

          <label className="mt-3 block text-[14px] font-medium text-ink" htmlFor={`yt-url-${asset.id}`}>
            Landing page URL
          </label>
          <input
            id={`yt-url-${asset.id}`}
            value={finalUrl}
            onChange={(e) => setFinalUrl(e.target.value)}
            placeholder="https://example.com/offer"
            className="mt-1 w-full rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
          />
          <p className="mt-1 text-[12px] leading-5 text-inkMuted">
            Zavi adds the tracking tag <span className="font-mono">{asset.tracking_tag}</span> to this
            URL as <span className="font-mono">utm_campaign</span>.
          </p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div>
              <label className="block text-[14px] font-medium text-ink" htmlFor={`yt-h-${asset.id}`}>
                Headline
              </label>
              <input
                id={`yt-h-${asset.id}`}
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                maxLength={100}
                className="mt-1 w-full rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
              />
            </div>
            <div>
              <label className="block text-[14px] font-medium text-ink" htmlFor={`yt-lh-${asset.id}`}>
                Long headline
              </label>
              <input
                id={`yt-lh-${asset.id}`}
                value={longHeadline}
                onChange={(e) => setLongHeadline(e.target.value)}
                maxLength={90}
                className="mt-1 w-full rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
              />
            </div>
            <div>
              <label className="block text-[14px] font-medium text-ink" htmlFor={`yt-d1-${asset.id}`}>
                Description 1
              </label>
              <input
                id={`yt-d1-${asset.id}`}
                value={description1}
                onChange={(e) => setDescription1(e.target.value)}
                maxLength={90}
                className="mt-1 w-full rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
              />
            </div>
            <div>
              <label className="block text-[14px] font-medium text-ink" htmlFor={`yt-d2-${asset.id}`}>
                Description 2
              </label>
              <input
                id={`yt-d2-${asset.id}`}
                value={description2}
                onChange={(e) => setDescription2(e.target.value)}
                maxLength={90}
                className="mt-1 w-full rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
              />
            </div>
            <div>
              <label className="block text-[14px] font-medium text-ink" htmlFor={`yt-cta-${asset.id}`}>
                Button label
              </label>
              <input
                id={`yt-cta-${asset.id}`}
                value={callToAction}
                onChange={(e) => setCallToAction(e.target.value)}
                maxLength={10}
                className="mt-1 w-full rounded-lg border border-ink/[0.12] bg-white px-2 py-1.5 text-[13px] text-ink"
              />
            </div>
          </div>

          {!storedId ? (
            <p className="mt-3 text-[12px] leading-5 text-inkMuted">
              Save the YouTube video id above first. Google Ads runs a video ad by its YouTube id.
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => void propose()}
            disabled={proposing || !adGroupId || !storedId}
            className="mt-3 rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {proposing ? "Proposing…" : "Propose paused YouTube ad"}
          </button>
          <p className="mt-2 text-[12px] leading-5 text-inkMuted">
            This only creates a proposal in Zavi. After you approve it, Google Ads adds the ad
            paused, so it spends nothing until you enable it in Google Ads yourself. Zavi does not
            pause this one for you when the ad rights end on {fmtDate(asset.rights_end_at)}.
          </p>
          {proposeError ? (
            <p className="mt-2 text-[12px] leading-5 text-rose-700">{proposeError}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
