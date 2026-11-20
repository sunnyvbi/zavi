"use client";
import { useEffect, useId, useRef, useState } from "react";
import { AdsSheet, SheetNote, SheetSelect, sheetInput as input, sheetLabel as label, sheetHint as hint, sheetFooterButton as button } from "../managed-campaigns/AdsSheet";
import { campaignFetch, requestKey } from "../managed-campaigns/api";
import { AdCard, CreateColumns } from "../managed-campaigns/CreateSheet";
import { VideoField } from "../topActions/fields";
import { AdvancedSettingsFields } from "./AdvancedSettingsFields";
import { VideoUrlField, validVideoSource } from "./VideoUrlField";
import { VideoLibraryField } from "./VideoLibraryField";
import { AudienceFields, CreativeFields } from "./CampaignFields";
import { DYNAMIC_BUDGET_EXPLANATION, ADVANCED_GROUP_FIELDS, TIKTOK_CAMPAIGN_API as base, utcIso, videoSource, words, type TiktokCampaignOptions, type TiktokSettings } from "./types";

export function NewTiktokCampaign({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const titleId = useId(), formId = useId(), videoId = useId();
  const [options, setOptions] = useState<TiktokCampaignOptions | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("30");
  const [identity, setIdentity] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [video, setVideo] = useState("");
  const [settings, setSettings] = useState<TiktokSettings>({ age_groups: [], gender: "GENDER_UNLIMITED", languages: [], call_to_action: "LEARN_MORE" });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const latch = useRef(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    let stale = false; setLoadError("");
    void campaignFetch<TiktokCampaignOptions>(`${base}/campaign-options`).then(r => {
      if (stale) return; setOptions(r);
      if (r.identities.length === 1) setIdentity(r.identities[0].identity_id);
      setSettings(s => ({ ...s, location_ids: s.location_ids ?? r.locations.map(l => l.location_id) }));
    }).catch(e => { if (!stale) setLoadError(e.message); });
    return () => { stale = true; };
  }, [reload]);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView?.({ block: "center" }); }, [error]);
  const patch = (v: Partial<TiktokSettings>) => setSettings(s => ({ ...s, ...v }));
  const amount = Number(budget);
  const validBudget = !!budget.trim() && Number.isFinite(amount) && amount > 20 && amount <= 100000 && Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001;
  const blockers = options?.blockers ?? [];
  const validBid = settings.bid_type !== "BID_TYPE_CUSTOM" || Number(settings.bid_price) > 0;
  const languageConflict = settings.smart_audience_enabled === true && !!settings.languages?.length;
  const valid = !languageConflict && validBid && !!options?.advertiser && options.advertiser.currency === "USD" && !blockers.length && !!name.trim() && validBudget && !!identity && validVideoSource(video) && !!settings.location_ids?.length && !!settings.ad_text?.trim() && /^https:\/\/\S+$/i.test(settings.landing_page_url ?? "") && !!settings.call_to_action;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy || uploading || done || latch.current) return;
    latch.current = true; setBusy(true); setError("");
    const body = {
      advertiser_id: options!.advertiser!.id, campaign_type: "TRAFFIC", name: name.trim(),
      location_ids: settings.location_ids, age_groups: settings.age_groups, gender: settings.gender, languages: settings.languages,
      ...Object.fromEntries(ADVANCED_GROUP_FIELDS.filter(field => settings[field] !== undefined).map(field => [field, settings[field]])),
      daily_budget_usd: amount, ...(start ? { start_time: utcIso(start) } : {}), ...(end ? { end_date: end } : {}),
      ...videoSource(video), identity_id: identity, ad_text: settings.ad_text!.trim(), call_to_action: settings.call_to_action, landing_url: settings.landing_page_url!.trim(),
    };
    const path = `${base}/campaigns`;
    request.current = requestKey(request.current, path, body);
    try {
      await campaignFetch<{ action_id: string }>(path, { method: "POST", body: JSON.stringify({ ...body, request_id: request.current.id }), headers: { "Idempotency-Key": request.current.id } });
      setDone(true); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not prepare this campaign. Refresh before retrying."); }
    finally { latch.current = false; setBusy(false); }
  }
  const rows = [
    { label: "Who sees it", value: settings.location_ids?.length ? `${settings.location_ids.length} ${settings.location_ids.length === 1 ? "place" : "places"}` : "No places picked yet" },
    { label: "Budget", value: validBudget ? `About $${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} a day` : "Not set yet" },
    { label: "Runs", value: `${start ? `From ${start.slice(0, 10)}` : "After approval"} · ${end ? `until ${end}` : "no end date"}` },
    { label: "Button", value: settings.call_to_action ? words(settings.call_to_action) : "-" },
  ];
  return <AdsSheet size="wide" titleId={titleId} slug="tiktok_ads" title="New TikTok Ads campaign" busy={busy || uploading} onClose={onClose} cancelLabel={done ? "Close" : "Cancel"} footer={done ? <button type="button" className={`${button} bg-ink text-cream`} onClick={onClose}>Review on channel</button> : <button type="submit" form={formId} className={`${button} bg-ink text-cream`} disabled={!valid || busy || uploading}>{busy ? "Preparing…" : "Create campaign proposal"}</button>}>
    <div className="space-y-6">
      {loadError ? <div role="alert"><p>{loadError}</p><button type="button" className="mt-3 underline" onClick={() => setReload(v => v + 1)}>Try again</button></div> : !options ? <p role="status">Checking your TikTok ad account…</p> : done ? <div role="status" className="rounded-xl border border-rule bg-successBg p-4"><p className="font-semibold">Your campaign proposal is ready.</p><p className="mt-2 text-sm">Review it on this channel. Approval creates the campaign, ad group and video ad, then enables them after verification. Nothing is running yet.</p></div> : <>
        <p className="text-sm text-inkSoft">{options.advertiser?.name ?? "Choose an ad account on the channel first"} · {options.advertiser?.currency ?? "Currency unavailable"} · Account time zone: {options.advertiser?.timezone ?? "Unavailable"}</p>
        {(options.videos_error || options.languages_error || options.audiences_error || options.interests_error) && <p role="status" className={hint}>Some choices could not be loaded. <button type="button" className="underline" disabled={busy || uploading} onClick={() => setReload(v => v + 1)}>Retry unavailable choices</button></p>}
        <SheetNote>Create a traffic campaign with one ad group and one video ad. It measures clicks and site visits. An owner or admin reviews the proposal before it launches.</SheetNote>
        {blockers.length > 0 && <div role="alert" className="rounded-xl border border-rule p-4"><p className="font-semibold">Before you can create a campaign</p><ul className="mt-2 list-disc space-y-2 pl-5 text-sm">{blockers.map((b, i) => <li key={i}>{typeof b === "string" ? b : [b.message ?? b.what ?? b.code, b.fix].filter(Boolean).join(" ")}</li>)}</ul></div>}
        <CreateColumns slug="tiktok_ads" card={<AdCard text={settings.ad_text ?? ""} headline={name} link={settings.landing_page_url ?? ""} button={settings.call_to_action ? words(settings.call_to_action) : undefined} />} rows={rows} note="A proposal only. Nothing runs until an owner or admin approves it on this channel."><form id={formId} onSubmit={submit} className="space-y-6"><fieldset disabled={busy || uploading} className="space-y-6">
          <label className={label}>Campaign name<input className={input} maxLength={80} required value={name} onChange={e => setName(e.target.value)} /></label>
          <label className={label}>Objective<input className={input} value="Traffic — clicks to your website" disabled /></label>
          <div><label className={label}>Average daily budget (USD)<input className={input} type="number" min="20.01" max="100000" step="0.01" required value={budget} onChange={e => setBudget(e.target.value)} /></label><p className={hint}>More than $20 a day on average, on the ad group. Counts against your shared ad budget.</p><p className={hint}>{DYNAMIC_BUDGET_EXPLANATION}</p></div>
          <AudienceFields value={settings} onChange={patch} options={options} advertiserId={options.advertiser?.id ?? ""} disabled={busy || uploading} />
          <div className="grid gap-5 sm:grid-cols-2"><label className={label}>Start time (UTC)<input className={input} type="datetime-local" step="1" value={start} onChange={e => setStart(e.target.value)} /><span className={hint}>Leave blank to start after approval.</span></label>{options.end_date_enabled && <label className={label}>End date (UTC)<input className={input} type="date" value={end} onChange={e => setEnd(e.target.value)} /><span className={hint}>Stops at 00:00 UTC on this date. Leave blank to run until paused.</span></label>}</div>
          <AdvancedSettingsFields value={{ audience_ids: [], excluded_audience_ids: [], interest_category_ids: [], operating_systems: [], network_types: [], dayparting: "1".repeat(336), comment_disabled: false, share_disabled: false, smart_audience_enabled: false, smart_interest_behavior_enabled: false, bid_type: "BID_TYPE_NO_BID", ...settings }} onChange={patch} options={options} editableFields={[...ADVANCED_GROUP_FIELDS]} disabled={busy || uploading} currency={options.advertiser?.currency ?? null} timezone={options.advertiser?.timezone ?? null} />
          {languageConflict && <p role="alert" className={hint}>Zavi currently supports Smart audience expansion with all languages. Clear selected languages or turn off Smart audience expansion.</p>}
          <label className={label}>TikTok account shown on the ad<SheetSelect value={identity} required onChange={e => setIdentity(e.target.value)}><option value="">Choose a linked account</option>{options.identities.map(i => <option key={i.identity_id} value={i.identity_id}>{i.display_name ?? i.identity_id}</option>)}</SheetSelect></label>
          <CreativeFields value={settings} onChange={patch} disabled={busy || uploading} />
          <VideoLibraryField advertiserId={options.advertiser?.id ?? ""} value={video.startsWith("library:") ? video.slice(8) : ""} onChange={id => setVideo(id ? `library:${id}` : "")} options={options} disabled={busy || uploading} />
          <div><label htmlFor={videoId} className={label}>Upload or choose a Zavi video instead</label><VideoField id={videoId} options={options.zavi_videos.map(v => ({ id: `zavi:${v.artifact_id}`, label: v.filename }))} value={video.startsWith("library:") || video.startsWith("url:") ? "" : video} onChange={setVideo} disabled={busy} onBusyChange={setUploading} /></div>
          <VideoUrlField value={video} onChange={setVideo} disabled={busy || uploading} />
        </fieldset></form></CreateColumns>
        <p className={hint}>The next step is a reviewable proposal with your exact selections. No AI-generated campaign settings are added.</p>
      </>}
      {error && <p ref={errorRef} role="alert" className="rounded-xl border border-rule p-3 text-sm">{error}</p>}
    </div>
  </AdsSheet>;
}
