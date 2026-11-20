"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AdsFormSkeleton } from "./AdsLoading";
import { countryOptions, type LaunchItem, type LaunchResult, type LaunchSummary } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import type { CampaignWorkspaceSpec } from "./types";
import { campaignFetch } from "./api";
import { campaignLocationsLine, money } from "./format";
import { ChannelBalance } from "./ChannelBalance";
import { AdsSheet, SheetNote, sheetFooterButton } from "./AdsSheet";

const STATUS_WORDS: Record<LaunchItem["status"], string> = {
  activated: "Turned on", already_active: "Already on", skipped: "Left off", failed: "Not turned on",
};
const KIND_WORDS: Record<LaunchItem["kind"], string> = { campaign: "Campaign", ad_group: "Ad group", ad: "Ad" };

export function LaunchSheet({ campaignId, spec, onClose, onLaunched }: { campaignId: string; spec: CampaignWorkspaceSpec; onClose: () => void; onLaunched?: () => void }) {
  const titleId = useId();
  const path = `${spec.apiBase}/campaigns/${encodeURIComponent(campaignId)}/launch`;
  const [summary, setSummary] = useState<LaunchSummary | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const latch = useRef(false);

  const read = useCallback(async () => {
    try { setSummary(await campaignFetch<LaunchSummary>(path)); setReadError(null); }
    catch (e) { setReadError(e instanceof Error ? e.message : "The campaign could not be read. Try again."); }
  }, [path]);
  useEffect(() => { void read(); }, [read]);

  async function launch() {
    if (!summary || latch.current) return;
    latch.current = true; setBusy(true);
    try {
      const res = await apiFetch(path, { method: "POST", retryOnNetworkError: false, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_updated_at: summary.campaign.updated_at, snapshot: summary.snapshot }) });
      const body = await res.json().catch(() => null) as (LaunchResult & { error?: { message?: string } }) | null;
      if (body && Array.isArray(body.items)) setResult(body);
      else setResult({ ok: false, items: [], message: body?.error?.message ?? "The launch could not be confirmed. Open the campaign list to check before trying again." });
      if (body?.ok) onLaunched?.();
    } catch {
      setResult({ ok: false, items: [], message: "The launch did not answer. Nothing runs twice, so it is safe to check and finish: read the campaign again below." });
    } finally {
      latch.current = false; setBusy(false);
      void read();
    }
  }

  const c = summary?.campaign;
  const objective = spec.objectives.find(o => o.value === c?.bidding_type);
  const currency = summary?.currency ?? summary?.wallet?.currency ?? spec.balance.currency;
  const names = new Map(countryOptions().map(x => [x.code, x.name]));
  const bids = [...new Set((summary?.groups ?? []).map(g => g.max_bid_micros))];
  const bidLine = bids.length === 0 ? "Not set" : bids.map(b => b == null ? "Set by the platform within the budget" : money(b / (objective?.bidMicros ?? 1e6), currency)).join(", ");
  const cap = c?.lifetime_budget_micros != null ? `${money(c.lifetime_budget_micros / 1e6, currency)} in total`
    : c?.daily_budget_micros != null ? `${money(c.daily_budget_micros / 1e6, currency)} a day on average, up to ${money((2 * c.daily_budget_micros) / 1e6, currency)} on any one day`
    : "Could not be read";
  const ended = summary?.state === "ended";
  const live = !ended && (summary?.state === "launched" || !!result?.ok);
  const short = (summary?.shortfall_cents ?? 0) > 0;
  const fundingUnknown = summary?.shortfall_cents === null;
  const servable = (summary?.ads ?? []).filter(a => !/reject|disapprov|denied/i.test(a.review_status ?? ""));
  const partial = !!result && !result.ok && result.items.some(i => i.status === "activated");
  const missingAds = !!summary && servable.length === 0;
  const setupGuidance = !summary?.groups.length ? "No ad groups are listed yet. Add an ad group and an ad in campaign settings."
    : !summary.ads.length ? "No ads are listed yet. Add an ad in campaign settings."
    : "None of these ads can launch because the platform rejected them. Edit or replace an ad in campaign settings.";

  const footer = !summary || summary.state === "archived" || ended ? null
    : live ? <button type="button" className={`${sheetFooterButton} bg-ink text-cream`} onClick={onClose}>Done</button>
    : <button type="button" className={`${sheetFooterButton} bg-ink text-cream`} disabled={busy || short || fundingUnknown || !!readError || servable.length === 0} onClick={() => void launch()}>
        {busy ? "Launching…" : partial ? "Finish launch" : c?.lifetime_budget_micros != null ? `Launch · up to ${money(c.lifetime_budget_micros / 1e6, currency)}` : "Launch"}
      </button>;

  return <AdsSheet titleId={titleId} title={ended ? "This campaign ended" : live ? "Your campaign is on" : missingAds && summary?.state !== "archived" ? "Finish campaign setup" : "Review campaign"} busy={busy} onClose={onClose} footer={footer} cancelLabel={live || ended ? "Close" : "Cancel"}>
    {readError && <p role="alert" className="mb-4 text-[14px] font-medium text-danger">{readError} <button type="button" className="underline" onClick={() => void read()}>Try again</button></p>}
    {!summary && !readError && <AdsFormSkeleton label="Reading your campaign…" />}
    {summary && <div className="space-y-6">
      {summary.state === "archived" && <p className="text-[14px] font-medium">This campaign was archived. Create a new one to launch.</p>}
      {ended && <p className="text-[14px] font-medium">Its schedule {summary.campaign.end_time ? `ended ${new Date(summary.campaign.end_time * 1000).toLocaleDateString()}` : "already ended"}, so it is no longer delivering. Extend the end date in campaign settings, or create a new campaign.</p>}
      {live && <p className="text-[14px] font-medium text-ink">Your ads are on. The platform reviews new ads before they show, which can take a while; Zavi shows each ad&apos;s review status in the campaign list.</p>}
      {!live && !ended && summary.state !== "archived" && missingAds && <div role="status" className="space-y-2 rounded-xl border border-rule p-4 text-sm text-inkSoft"><p>{setupGuidance}</p><p>If you just saved an ad group or ad, ChatGPT may take a few minutes to list it. Refresh before creating it again.</p><button type="button" className="underline" disabled={busy} onClick={() => void read()}>Refresh campaign</button></div>}

      <dl className="grid gap-4 rounded-2xl border border-rule p-4 text-[14px] md:grid-cols-2">
        <div><dt className="text-[13px] font-medium text-inkMuted">Spend up to</dt><dd data-testid="launch-cap" className="font-semibold">{cap}</dd></div>
        <div><dt className="text-[13px] font-medium text-inkMuted">{objective?.plainBid ?? objective?.bidLabel ?? "Maximum bid"}</dt><dd data-testid="launch-bid" className="font-semibold">{bidLine}</dd></div>
        <div><dt className="text-[13px] font-medium text-inkMuted">Shows in</dt><dd data-testid="launch-countries" className="font-semibold">{campaignLocationsLine(c?.targeting ?? { locations: { countries: c?.countries ?? [] } }, code => names.get(code) ?? code)}</dd></div>
        <div><dt className="text-[13px] font-medium text-inkMuted">Ads</dt><dd className="font-semibold">{servable.length} of {summary.ads.length} can show</dd></div>
      </dl>
      {objective?.bidHint && <p className="text-sm text-inkMuted">{objective.bidHint}</p>}

      <ul className="space-y-2">{summary.ads.map(a => <li key={a.id} data-testid="launch-ad" className="rounded-xl bg-bone p-3">
        <p className="text-[14px] font-semibold">{a.title ?? a.name}</p>
        {a.body && <p className="text-[14px] text-inkSoft">{a.body}</p>}
        {a.review_status && /reject|disapprov|denied/i.test(a.review_status) && <p className="mt-1 text-[13px] font-medium text-danger">Not approved by the platform; it stays off.</p>}
      </li>)}</ul>

      {summary.funding_source === "provider" && <p className="text-sm text-inkMuted">Your advertiser account {summary.provider_account_id ?? ""} is billed directly by ChatGPT Ads. This launch does not use your Zavi wallet.</p>}
      {!live && !ended && summary.wallet && <section className="space-y-2">
        {summary.fx && summary.fx.currency !== "USD" && <p className="text-sm text-inkMuted">Amounts shown in {summary.fx.currency}; converted to USD for your monthly ad budget at 1 USD = {summary.fx.units_per_usd} {summary.fx.currency}. <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">Rates By Exchange Rate API</a> ({summary.fx.as_of?.slice(0,10)}). Your provider billing conversion may differ.</p>}
      {short && <p role="status" className="text-[14px] font-medium text-ink">Add about {money(Math.ceil((summary.shortfall_cents ?? 0) / 100), currency)} to cover the spend cap. Ads balance is separate from your Zavi credits.</p>}
        <ChannelBalance spec={spec} variant="card" suggestedAmount={short ? Math.max(Math.ceil((summary.shortfall_cents ?? 0) / 100), spec.balance.minTopup / 100) : undefined} onChanged={() => void read()} />
      </section>}
      {!live && !ended && fundingUnknown && <p role="alert" className="text-[14px] text-danger">Campaign funding could not be verified. Refresh before launching. <button type="button" className="underline" onClick={() => void read()}>Refresh funding</button></p>}

      {result && !result.ok && <div role="alert" className="space-y-2 rounded-2xl border border-danger/40 p-4">
        <p className="text-[14px] font-semibold text-danger">{result.message}</p>
        {result.items.length > 0 && <ul className="space-y-1 text-[13px]">{result.items.map(i => <li key={`${i.kind}:${i.id}`}>{KIND_WORDS[i.kind]} “{i.name}”: {STATUS_WORDS[i.status]}{i.reason ? `. ${i.reason}` : ""}</li>)}</ul>}
      </div>}

      {!live && !ended && summary.state !== "archived" && !missingAds && <SheetNote>Launching turns on {servable.length === 1 ? "your ad" : `your ${servable.length} ads`}. Zavi may spend up to {cap}{!objective?.bidIsTarget && bids.length && bids[0] != null ? `, at most ${bidLine} per ${c?.bidding_type === "impressions" ? "1,000 views" : "result"}` : ""}. You can pause any time; spend reporting can lag.</SheetNote>}
      {live && <p className="text-[13px] text-inkMuted"><a href="#campaigns" className="underline" onClick={onClose}>Open the campaign list</a> to watch results or pause.</p>}
    </div>}
  </AdsSheet>;
}
