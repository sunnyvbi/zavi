
"use client";

import { useEffect, useRef, useState } from "react";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { apiFetch } from "@/lib/api";
import { adCurrencySymbol } from "@/lib/adCurrency";

type TargetingSentence = { content: string; children: string[] };

type AdCreative = {
  body: string | null;
  title: string | null;
  call_to_action: string | null;
  destination_url: string | null;
  thumbnail_url: string | null;
  image_url: string | null;
  is_dynamic_creative: boolean;
  variant_count: number;
};

type AdView = {
  ad_id: string;
  ad_name: string;
  spend_usd: number;
  ctr_percent: number | null;
  frequency: number | null;
  roas: number | null;
  effective_status: string | null;
  creative?: AdCreative | null;
};

type AdSetDetailView = {
  ad_set_id: string;
  ad_set_name: string;
  optimization_event: string | null;
  bid_strategy: string | null;
  bid_amount_usd: number | null;
  attribution_window: string | null;
  daily_budget_usd: number | null;
  effective_status: string | null;
  advantage_audience: boolean;
  automatic_placements: boolean;
  age_min: number | null;
  age_max: number | null;
  genders: string | null;
  custom_audiences: string[];
  excluded_custom_audiences: string[];
  targeting_sentences: TargetingSentence[];
  spend_usd: number;
  ads: AdView[];
};

type DetailResponse = {
  campaign_id: string;
  ad_sets: AdSetDetailView[];
  truncated?: boolean;
  total_ad_sets?: number;
  currency?: string | null;
  error?: { code: string; message: string };
};

const BID_STRATEGY_LABEL: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: "Lowest cost (auto)",
  LOWEST_COST_WITH_BID_CAP: "Bid cap",
  COST_CAP: "Cost cap",
  LOWEST_COST_WITH_MIN_ROAS: "Min ROAS",
};
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}
function bidLabel(s: string | null): string {
  if (!s) return "-";
  return BID_STRATEGY_LABEL[s] ?? titleCase(s);
}
function usd(n: number | null | undefined, currency?: string | null): string {
  if (n == null) return "-";
  const sym = adCurrencySymbol(currency);
  return `${sym}${Math.round(n).toLocaleString(sym === "₹" ? "en-IN" : undefined)}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-[12px] leading-[18px]">
      <span className="w-[104px] shrink-0 text-[#8a8a8a]">{label}</span>
      <span className="min-w-0 flex-1 text-[#0e0f11]">{children}</span>
    </div>
  );
}

const SENTENCE_DROP = /^advantage\+ audience/i;

function Placements({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const items = value
    .replace(/^on pages:\s*/i, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-left text-[#0e0f11] underline decoration-[#c9c9c9] decoration-dotted underline-offset-[3px] hover:decoration-[#0e0f11]"
      >
        {items.length} placements <span className="text-[#8a8a8a]">{open ? "▴ hide" : "▾ show"}</span>
      </button>
      {open && (
        <ul className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] leading-[16px] text-[#595959]">
          {items.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AdsCampaignDetailDrawer({
  campaignId,
  campaignName,
  agentSlug,
  window: windowKey,
  windowLabel,
  since,
  until,
  onClose,
}: {
  campaignId: string;
  campaignName: string;
  agentSlug: string;
  window: string;
  windowLabel?: string;
  since?: string;
  until?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; label?: string | null } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    const qs = new URLSearchParams({ campaign_id: campaignId, window: windowKey });
    if (since && until) {
      qs.set("since", since);
      qs.set("until", until);
    }
    apiFetch(`/api/agents/${agentSlug}/campaign-detail?${qs.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: DetailResponse) => {
        if (!cancelled) setData(j);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, agentSlug, windowKey, since, until]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <AdsDialog
      size="xl"
      label={`Details for ${campaignName}`}
      onClose={onClose}
      onEscape={() => { if (!lightbox) return false; setLightbox(null); return true; }}
      closeOnBackdrop
      chrome="rounded-lg border border-[#e6e6e6] bg-white shadow-2xl"
    >
      {}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[#f0f0f0] bg-white px-6 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-[#8a8a8a]">Campaign</div>
            <h2 className="truncate text-[16px] font-semibold text-[#0e0f11]">{campaignName || "(unnamed)"}</h2>
            {}
            {data && !data.error && (
              <div className="mt-0.5 text-[11px] text-[#8a8a8a]">
                Live from Meta · just now
                {windowLabel ? <span> · {windowLabel}</span> : null}
              </div>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded px-2 py-1 text-[12px] text-[#595959] hover:bg-[#f5f5f5]"
          >
            Close
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-4">
          {error && <p className="text-[12px] text-[#b42318]">Couldn&apos;t load details: {error}</p>}
          {!data && !error && (
            <p className="text-[12px] text-[#8a8a8a]">
              Loading from Meta…
            </p>
          )}
          {data?.error && (
            <p className="text-[12px] text-[#8a8a8a]">
              {data.error.code === "meta_ads_not_connected"
                ? "Meta Ads isn't connected for this workspace."
                : data.error.message}
            </p>
          )}
          {data && !data.error && data.ad_sets.length === 0 && (
            <p className="text-[12px] text-[#8a8a8a]">
              No ad sets delivered in this window, so Meta reports nothing to show.
            </p>
          )}

          {data?.truncated && (
            <p className="mb-3 rounded bg-[#fff8e6] px-3 py-2 text-[11px] text-[#7a5c00]">
              Showing the first {data.ad_sets.length} of {data.total_ad_sets} ad sets.
            </p>
          )}

          {data?.ad_sets.map((s) => (
            <section key={s.ad_set_id} className="mb-6 border-b border-[#f0f0f0] pb-6 last:border-0">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h3 className="truncate text-[13px] font-semibold text-[#0e0f11]">{s.ad_set_name || "(unnamed ad set)"}</h3>
                <span className="shrink-0 text-[11px] text-[#8a8a8a]">{usd(s.spend_usd, data?.currency)} spent</span>
              </div>

              {}
              <div className="grid gap-x-8 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div>
                  <Row label="Optimizing">{s.optimization_event ?? "-"}</Row>
                  {}
                  <Row label="Bid strategy">
                    {s.bid_strategy ? (
                      <>
                        {bidLabel(s.bid_strategy)}
                        {s.bid_amount_usd != null && (
                          <span className="text-[#595959]"> · {usd(s.bid_amount_usd, data?.currency)}</span>
                        )}
                      </>
                    ) : (
                      "-"
                    )}
                  </Row>
                  <Row label="Attribution">{s.attribution_window ?? "-"}</Row>
                  <Row label="Daily cap">{usd(s.daily_budget_usd, data?.currency)}</Row>

                  {}
                  {s.targeting_sentences.length > 0 ? (
                    s.targeting_sentences
                      .filter((t) => !SENTENCE_DROP.test(t.content))
                      .map((t) => {
                        const label = t.content.replace(/:$/, "");
                        const value = t.children.join(", ");
                        return (
                          <Row key={t.content} label={label}>
                            {/^placements/i.test(label) ? <Placements value={value} /> : value}
                          </Row>
                        );
                      })
                  ) : (
                    <Row label="Targeting">
                      {[
                        s.age_min && s.age_max ? `Age ${s.age_min}-${s.age_max}` : null,
                        s.genders,
                        s.automatic_placements ? "Automatic placements" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "-"}
                    </Row>
                  )}

                  {}
                  {s.genders && <Row label="Gender">{s.genders}</Row>}

                  {s.custom_audiences.length > 0 && <Row label="Audiences">{s.custom_audiences.join(", ")}</Row>}
                  {s.excluded_custom_audiences.length > 0 && (
                    <Row label="Excluding">{s.excluded_custom_audiences.join(", ")}</Row>
                  )}

                  {}
                  {s.advantage_audience && (
                    <Row label="Advantage+">
                      <span className="text-[#8a6d00]">
                        Audience ON: Meta may look beyond the targeting above
                      </span>
                    </Row>
                  )}
                </div>

                <div>
                  {s.ads.length > 0 && (
                    <>
                      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-[#8a8a8a]">
                        Ads ({s.ads.length})
                      </div>
                      <div className="space-y-3">
                        {s.ads.map((ad) => (
                          <div key={ad.ad_id} className="flex gap-3 rounded border border-[#f0f0f0] p-2.5">
                            {}
                            {ad.creative?.thumbnail_url ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setLightbox({
                                    url: ad.creative?.image_url ?? ad.creative?.thumbnail_url ?? "",
                                    label: ad.creative?.title ?? ad.ad_name,
                                  })
                                }
                                aria-label={`View full image for ${ad.ad_name || "this ad"}`}
                                className="group/img relative size-[72px] shrink-0 overflow-hidden rounded"
                              >
                                <img
                                  src={ad.creative.thumbnail_url}
                                  alt=""
                                  className="size-full object-cover transition-transform group-hover/img:scale-105"
                                  loading="lazy"
                                />
                                <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-[9px] font-medium text-white opacity-0 transition-opacity group-hover/img:opacity-100">
                                  View
                                </span>
                              </button>
                            ) : (
                              <div className="flex size-[72px] shrink-0 items-center justify-center rounded bg-[#f5f5f5] text-[9px] text-[#8a8a8a]">
                                no image
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                        {ad.creative?.body ? (
                          <p className="line-clamp-2 text-[12px] leading-[17px] text-[#0e0f11]">{ad.creative.body}</p>
                        ) : (
                          <p className="text-[12px] text-[#8a8a8a]">{ad.ad_name || "(unnamed ad)"}</p>
                        )}
                        {ad.creative?.title && (
                          <p className="mt-0.5 truncate text-[11px] font-semibold text-[#0e0f11]">{ad.creative.title}</p>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#8a8a8a]">
                          {ad.creative?.call_to_action && (
                            <span className="rounded bg-[#f5f5f5] px-1.5 py-0.5 text-[11px] font-medium text-[#595959]">
                              {titleCase(ad.creative.call_to_action)}
                            </span>
                          )}
                          {ad.creative?.destination_url && (
                            <a
                              href={ad.creative.destination_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="truncate text-[#2563eb] hover:underline"
                            >
                              {ad.creative.destination_url.replace(/^https?:\/\//, "")}
                            </a>
                          )}
                        </div>
                        {}
                        {ad.creative?.is_dynamic_creative && (
                          <p className="mt-0.5 text-[11px] text-[#8a8a8a]">
                            Dynamic creative: 1 of {ad.creative.variant_count} variants shown
                          </p>
                        )}
                        <div className="mt-1 text-[11px] text-[#595959]">
                          {usd(ad.spend_usd, data?.currency)}
                          {ad.ctr_percent != null && ` · ${ad.ctr_percent}% CTR`}
                          {ad.frequency != null && ` · ${ad.frequency} freq`}
                            </div>
                          </div>
                        </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>

      {}
      {lightbox && (
        <div className="fixed inset-0 z-10 flex items-center justify-center p-8">
          <button
            type="button"
            aria-label="Close image"
            onClick={() => setLightbox(null)}
            className="absolute inset-0 cursor-zoom-out bg-black/80"
          />
          <figure className="relative flex max-h-full flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightbox.url}
              alt={lightbox.label ?? ""}
              className="max-h-[75vh] max-w-full rounded object-contain shadow-2xl"
            />
            {lightbox.label && (
              <figcaption className="max-w-[600px] text-center text-[12px] text-white/80">
                {lightbox.label}
              </figcaption>
            )}
          </figure>
        </div>
      )}
    </AdsDialog>
  );
}
