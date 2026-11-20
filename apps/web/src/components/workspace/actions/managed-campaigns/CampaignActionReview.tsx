"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AdsFormSkeleton } from "./AdsLoading";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import { countryOptions, type CampaignDraft, type CampaignReviewResponse } from "@zavi/shared";
import type { ActionHandlers, ActionItem } from "../types";
import type { CampaignWorkspaceSpec } from "./types";
import { campaignFetch } from "./api";
import { money } from "./format";
import { AdImageSlot } from "./AdImageSlot";
import { ActionEditDialog } from "../ActionEditDialog";
import { Button } from "@/components/ui/Button";
import { SheetNote, SheetSelect, sheetFooterButton, sheetHint, sheetInput, sheetLabel } from "./AdsSheet";

type Review = CampaignReviewResponse<CampaignDraft>;
const SOURCE_TAG: Record<string, string> = {
  starter: "Zavi starter test · change anytime",
  company_profile: "From your company profile",
  website: "From your website address",
  default: "Default · change if needed",
};
const APPROVAL_UNCONFIRMED = "Campaign creation could not be confirmed. Your reviewed draft is saved. Return to its card to check the status before trying again.";
const tag = "ml-2 rounded-full bg-bone px-2 py-0.5 text-[12px] font-medium text-inkMuted";
export const siteOf = (url: string | undefined) => { try { return url ? new URL(url).hostname.replace(/^www\./, "") : "your site"; } catch { return "your site"; } };
const codesOf = (value: string) => [...new Set(value.split(/[\s,]+/).map(c => c.trim().toUpperCase()).filter(Boolean))];

export function CampaignActionReview({ action, spec, handlers, onPrepared, onClose }: {
  action: ActionItem; spec: CampaignWorkspaceSpec; handlers: ActionHandlers; onPrepared: (a: ActionItem) => void; onClose: () => void;
}) {
  const formId = useId();
  const [review, setReview] = useState<Review | null>(null);
  const [budget, setBudget] = useState("");
  const [bid, setBid] = useState("");
  const [country, setCountry] = useState("");
  const [moreCountries, setMoreCountries] = useState("");
  const [perAd, setPerAd] = useState(false);
  const [shared, setShared] = useState<string | null>(null);
  const [images, setImages] = useState<Array<string | null>>([]);
  const [tab, setTab] = useState(0);
  const [imageBusy, setImageBusy] = useState(0);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const latch = useRef(false);
  const base = `${spec.actionReviewPath}/${encodeURIComponent(action.id)}`;

  useEffect(() => {
    let stopped = false;
    void campaignFetch<Review>(`${base}/review`).then(r => {
      if (stopped) return;
      setReview(r);
      const objective = spec.objectives.find(o => o.value === r.draft.bidding_type);
      if (r.suggested?.lifetime_budget_micros != null) setBudget(String(r.suggested.lifetime_budget_micros / 1e6));
      if (r.suggested?.max_bid_micros != null) setBid(String(r.suggested.max_bid_micros / (objective?.bidMicros ?? 1e6)));
      setCountry(r.suggested?.countries?.[0] ?? "");
      const given = r.draft.ads.map(a => a.image_url ?? null);
      setImages(given);
      const distinct = new Set(given.filter(Boolean));
      if (distinct.size > 1) setPerAd(true); else setShared(given.find(Boolean) ?? null);
    }).catch(e => { if (!stopped) setError(e instanceof Error ? e.message : "Zavi could not read this draft. Refresh and try again."); });
    return () => { stopped = true; };
  }, [base, spec.objectives, attempt]);

  const countries = useMemo(() => countryOptions(), []);
  const ads = review?.draft.ads ?? [];
  const objective = spec.objectives.find(o => o.value === review?.draft.bidding_type);
  const bidMicros = Math.round(Number(bid) * (objective?.bidMicros ?? 1e6));
  const codes = [...new Set([country, ...codesOf(moreCountries)].filter(Boolean))];
  const chosen = ads.map((_, i) => perAd ? images[i] ?? null : shared);
  const bidNeedsYou = review?.suggested?.max_bid_micros == null;
  const budgetSource = review && review.suggested?.lifetime_budget_micros != null && Math.round(Number(budget) * 1e6) === review.suggested.lifetime_budget_micros ? "starter" : null;
  const countrySource = review && country === review.suggested?.countries?.[0] ? review.suggested.countries_source : null;
  const valid = !draftSaved && !!review && !!handlers.onApprove && imageBusy === 0
    && Number(budget) >= 1 && Number(budget) <= 1_000_000
    && bidMicros >= 1 && bidMicros <= 1_000_000_000
    && codes.length > 0 && codes.every(c => /^[A-Z]{2}$/.test(c))
    && chosen.length === ads.length && chosen.every(Boolean);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!valid || !review || latch.current) return;
    latch.current = true; setBusy(true); setError("");
    let saved = false;
    try {
      const result = await campaignFetch<{ exact_change: NonNullable<ActionItem["body"]["exact_change"]> }>(`${base}/prepare`, { method: "POST", body: JSON.stringify({
        currency: review.currency, lifetime_budget_micros: Math.round(Number(budget) * 1e6), max_bid_micros: bidMicros,
        countries: codes, image_urls: chosen,
      }) });
      const prepared: ActionItem = { ...action, executable: true, card_kind: "executes", primary_label: "Create paused campaign", body: { ...action.body, exact_change: result.exact_change } };
      saved = true; setDraftSaved(true);
      onPrepared(prepared);
      const approved = await handlers.onApprove?.(prepared);
      if (approved === false) { setError(APPROVAL_UNCONFIRMED); return; }
      onClose();
    } catch (e) { setError(saved ? APPROVAL_UNCONFIRMED : e instanceof Error ? e.message : "Could not prepare this campaign."); }
    finally { latch.current = saved; setBusy(false); }
  }

  const imageSlot = (i: number | null) => <AdImageSlot
    key={i ?? "shared"}
    label={i == null ? (ads.length > 1 ? "Image for both ads" : "Ad image") : `Image for ad ${i + 1}`}
    value={i == null ? shared : images[i] ?? null}
    onChange={v => i == null ? setShared(v) : setImages(list => ads.map((_, j) => j === i ? v : list[j] ?? null))}
    defaultPrompt={ads[i ?? 0]?.image_spec || ads[i ?? 0]?.title || review?.draft.name || ""}
    ai={review?.ai_image ?? null}
    generatePath={`${base}/ad-image`}
    disabled={busy || draftSaved}
    onBusy={b => setImageBusy(n => Math.max(0, n + (b ? 1 : -1)))}
  />;

  const bidName = `${objective?.plainBid ?? objective?.bidLabel ?? "Maximum bid"} (${review?.currency})`;
  const bidField = <label className={sheetLabel}>{bidName}
    <input aria-label={bidName} className={sheetInput} type="number" min="0.01" step="0.01" required value={bid} onChange={e => setBid(e.target.value)} />
    <span className={sheetHint}>{objective?.bidHint ? `${bidNeedsYou ? "Choose a bid for this test. No starter value is available. " : ""}${objective.bidHint}` : bidNeedsYou ? "Zavi has no starter value for this goal. Choose the most you are willing to pay." : "A starting value. This is a ceiling per result, not your total spend."}</span>
  </label>;

  const holding = busy || imageBusy > 0;
  return <ActionEditDialog title={`Review your ${spec.title} campaign`} subtitle={action.title} busy={holding} onClose={onClose} preview={ads[tab] ? <AdPreview ad={ads[tab]} image={chosen[tab]} rows={[{ label: "Budget", value: Number(budget) >= 1 ? `Up to ${money(Number(budget), review?.currency ?? null)} in total` : "Not set yet" }, { label: "Shown in", value: codes.length ? codes.join(", ") : "Not set yet" }]} /> : <p className="text-sm text-inkMuted">{!review && error ? "The preview shows once the draft is read." : "Reading the saved creative…"}</p>}
    footer={<><Button type="button" disabled={holding} onClick={onClose} className="h-12 px-4">{draftSaved ? "Back to campaign card" : "Cancel"}</Button>{review ? <button type="submit" form={formId} className={`${sheetFooterButton} bg-ink text-cream`} disabled={!valid || busy}>{busy ? "Creating…" : "Create paused campaign"}</button> : null}</>}>
    {error && <div role="alert" className="mb-4 space-y-3"><p className="text-[14px] font-medium text-danger">{!review ? `Zavi could not open this draft. ${error}` : error}</p>{!review && <Button type="button" onClick={() => { setError(""); setAttempt(n => n + 1); }} className="h-10 px-4">Try again</Button>}</div>}
    {!review && !error && <AdsFormSkeleton label="Reading Zavi's draft…" />}
    {review && <form id={formId} onSubmit={submit} className="ads-sheet-form space-y-6"><fieldset disabled={holding || draftSaved} className="space-y-6">
      <section className="space-y-2">
        <p className="text-[16px] font-semibold text-ink">{(objective?.plainGoal ?? objective?.label ?? "").replace("{site}", siteOf(ads[0]?.target_url))}</p>
        {review.draft.group.context_hints.length > 0 && <div>
          <p className="text-[14px] font-medium text-inkSoft">{spec.creative.contextPlain ?? spec.creative.contextLabel}:</p>
          <ul className="mt-1 flex flex-wrap gap-2">{review.draft.group.context_hints.map(h => <li key={h} className="rounded-full bg-bone px-2.5 py-1 text-[13px] font-medium text-inkSoft">{h}</li>)}</ul>
        </div>}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <label className={sheetLabel}><span>Spend up to, in total{budgetSource && <span className={tag}>{SOURCE_TAG.starter}</span>}</span>
          <span className="relative mt-1.5 block"><span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] font-medium text-inkMuted">{review.currency}</span>
            <input aria-label={`Spend up to, in total (${review.currency})`} className={`${sheetInput} !mt-0 pl-12`} type="number" min="1" max="1000000" step="0.01" required value={budget} onChange={e => setBudget(e.target.value)} />
          </span>
          <span className={sheetHint}>Your total budget across all ads in this campaign, not a daily amount. Creating it paused does not spend this money.</span>
        </label>
        <label className={sheetLabel}><span>Show in{countrySource && <span className={tag}>{SOURCE_TAG[countrySource]}</span>}</span>
          <SheetSelect value={country} onChange={e => setCountry(e.target.value)} required>
            <option value="" disabled>Choose a country</option>
            {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </SheetSelect>
        </label>
      </div>
      {bidNeedsYou && bidField}

      <section className="space-y-4 rounded-2xl border border-rule p-4">
        <p className="text-[16px] font-semibold text-ink">Your {ads.length > 1 ? "ads" : "ad"}</p>
        {!perAd && imageSlot(null)}
        {ads.length > 1 && <AdTabs count={ads.length} tab={tab} onTab={setTab} />}
        {}
        {perAd && ads.map((_, i) => <div key={i} hidden={i !== tab}>{imageSlot(i)}</div>)}
        {ads[tab] && <div role={ads.length > 1 ? "tabpanel" : undefined} className="space-y-3">
        </div>}
      </section>

      <details className="group rounded-2xl border border-rule p-4">
        <summary className="cursor-pointer list-none text-[14px] font-semibold text-ink">More settings</summary>
        <div className="mt-4 space-y-5">
          {!bidNeedsYou && bidField}
          <label className={sheetLabel}>More countries (optional)
            <input className={sheetInput} value={moreCountries} onChange={e => setMoreCountries(e.target.value)} placeholder="Two-letter codes, for example CA, GB" />
          </label>
          {ads.length > 1 && <label className="flex items-center gap-2 text-[14px] font-medium text-ink">
            <input type="checkbox" checked={perAd} onChange={e => { setPerAd(e.target.checked); if (e.target.checked) setImages(ads.map((_, i) => images[i] ?? shared)); else setShared(images.find(Boolean) ?? shared); }} />
            Use a different image for each ad
          </label>}
          <div className="text-[13px] font-medium text-inkMuted">
            <p>Link labels, so Zavi can tell which ad brought a visit:</p>
            <ul className="mt-1 space-y-0.5">{ads.map((a, i) => <li key={i} className="break-all">Ad {i + 1}: {a.tracking || "none"}</li>)}</ul>
          </div>
          <p className="text-[13px] font-medium text-inkMuted">Start date, platforms and budget type can be changed in the campaign editor after it is created.</p>
        </div>
      </details>

      <SheetNote>Created paused. Nothing spends until you launch it from your campaign list{Number(budget) >= 1 ? `, and then at most ${money(Number(budget), review.currency)} in total` : ""}. This does not add ads balance.</SheetNote>
    </fieldset></form>}
  </ActionEditDialog>;
}

function AdTabs({ count, tab, onTab }: { count: number; tab: number; onTab: (i: number) => void }) {
  const { listRef, box } = useSlidingIndicator<HTMLDivElement>(tab);
  return <div ref={listRef} role="tablist" aria-label="Ads" className="relative flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-bone p-1">
    <SlidingIndicator box={box} className="rounded-lg bg-ink" />
    {Array.from({ length: count }, (_, i) => <button key={i} type="button" role="tab" aria-selected={tab === i} onClick={() => onTab(i)} className={`relative rounded-lg px-3 py-1.5 text-[14px] font-semibold transition-colors duration-300 ${tab === i ? "text-cream" : "text-inkSoft hover:text-ink"}`}>Ad {i + 1}</button>)}
  </div>;
}

function AdPreview({ ad, image, rows }: { ad: CampaignDraft["ads"][number]; image: string | null; rows: Array<{ label: string; value: string }> }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    if (!image) { setSrc(null); return; }
    if (/^https:\/\//i.test(image)) { setSrc(image); return; }
    void campaignFetch<{ signed_url: string }>(`/api/chat/image-url?path=${encodeURIComponent(image)}`).then(r => { if (!stale) setSrc(r.signed_url); }).catch(() => { if (!stale) setSrc(null); });
    return () => { stale = true; };
  }, [image]);
  return <div className="space-y-4">
    <div className="space-y-4 rounded-2xl border border-ca-border bg-ca-bg p-4 shadow-sm">
      <div aria-hidden className="space-y-2">
        <div className="h-2.5 w-full rounded-full bg-ca-subtle" />
        <div className="h-2.5 w-11/12 rounded-full bg-ca-subtle" />
        <div className="h-2.5 w-3/4 rounded-full bg-ca-subtle" />
      </div>
      <div data-testid="ad-preview" className="space-y-2 rounded-xl border border-ca-border p-3">
        <p className="text-[12px] leading-4 text-ca-secondary">Sponsored · {siteOf(ad.target_url)}</p>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="break-words text-[14px] font-semibold leading-5 text-ca-xdark">{ad.title}</p>
            <p className="break-words text-[13px] leading-5 text-ca-primary">{ad.body}</p>
          </div>
          {src ? <img src={src} alt="" className="size-14 shrink-0 rounded-lg object-cover" /> : <span aria-hidden className="size-14 shrink-0 rounded-lg border border-dashed border-ca-strong" />}
        </div>
        <p className="truncate text-[12px] leading-4 text-ca-secondary">{siteOf(ad.target_url)} ›</p>
      </div>
    </div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[14px] leading-5">
      {rows.map((r) => <div key={r.label} className="contents"><dt className="text-ca-secondary">{r.label}</dt><dd className="break-words font-medium text-ca-xdark">{r.value}</dd></div>)}
    </dl>
  </div>;
}
