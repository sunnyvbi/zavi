"use client";
import { useEffect, useId, useRef, useState } from "react";
import { AdsFormSkeleton } from "../managed-campaigns/AdsLoading";
import { AdsSheet, SheetNote, SheetSelect, sheetInput as input, sheetLabel as label, sheetHint as hint, sheetFooterButton as button } from "../managed-campaigns/AdsSheet";
import { campaignFetch, requestKey } from "../managed-campaigns/api";
import { VideoField } from "../topActions/fields";
import { VideoUrlField, validVideoSource } from "./VideoUrlField";
import { VideoLibraryField } from "./VideoLibraryField";
import { AdvancedSettingsFields } from "./AdvancedSettingsFields";
import { CurrentSettings } from "./CurrentSettings";
import { AudienceFields, CreativeFields } from "./CampaignFields";
import { formatCurrency } from "../../metrics/currency";
import { DYNAMIC_BUDGET_EXPLANATION, TIKTOK_CAMPAIGN_API as base, dailyMode, settingsDiff, utcInput, utcIso, videoSource, words, type TiktokCampaignTarget, type TiktokCampaignDetail, type TiktokCampaignObject, type TiktokCampaignOptions, type TiktokSettings } from "./types";

export function TiktokCampaignEditor({ target, onClose, onChanged }: { target: TiktokCampaignTarget; onClose: () => void; onChanged: () => void }) {
  const titleId = useId();
  const [detail, setDetail] = useState<TiktokCampaignDetail | null>(null);
  const [options, setOptions] = useState<TiktokCampaignOptions | null>(null);
  const [error, setError] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const [optionsReload, setOptionsReload] = useState(0);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState(`campaign:${target.campaign_id}`);
  useEffect(() => {
    let stale = false;
    setDetail(null); setError(""); setDirty(false);
    const query = `?advertiser_id=${encodeURIComponent(target.advertiser_id)}`;
    void campaignFetch<TiktokCampaignDetail>(`${base}/campaigns/${encodeURIComponent(target.campaign_id)}${query}`).then(d => { if (!stale) setDetail(d); }).catch(e => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [target.advertiser_id, target.campaign_id, reload]);
  useEffect(() => {
    let stale = false;
    setOptionsError("");
    void campaignFetch<TiktokCampaignOptions>(`${base}/campaign-options?advertiser_id=${encodeURIComponent(target.advertiser_id)}`).then(d => { if (!stale) setOptions(d); }).catch(() => { if (!stale) setOptionsError("Video and targeting choices could not be loaded. Your current selections are preserved."); });
    return () => { stale = true; };
  }, [target.advertiser_id, optionsReload, reload]);
  const objects = detail ? [detail.campaign, ...detail.ad_groups, ...detail.ads] : [];
  const current = objects.find(o => `${o.level}:${o.id}` === selected) ?? objects[0];
  return <AdsSheet titleId={titleId} slug="tiktok_ads" title="Edit TikTok campaign" busy={busy} onClose={onClose} footer={<button type="button" className={`${button} bg-ink text-cream`} disabled={busy} onClick={onClose}>Done</button>}>
    <div className="space-y-6">
      {error ? <div role="alert"><p>{error}</p><button type="button" className="mt-3 underline" onClick={() => setReload(v => v + 1)}>Try again</button></div> : !detail ? <AdsFormSkeleton label="Reading current campaign settings…" /> : <>
        <p className="text-sm text-inkSoft">{detail.advertiser.name} · {detail.advertiser.currency ?? "Currency unavailable"} · Account time zone: {detail.advertiser.timezone ?? "Unavailable"}</p>
        <SheetNote>Changes are saved as proposals for review. Nothing changes in TikTok until you approve the proposal on this channel.</SheetNote>
        <label className={label}>Campaign, ad group or ad<SheetSelect value={current ? `${current.level}:${current.id}` : ""} disabled={busy || dirty} onChange={e => { if (!dirty) setSelected(e.target.value); }}>{objects.map(o => <option key={`${o.level}:${o.id}`} value={`${o.level}:${o.id}`}>{words(o.level)} · {o.name} · ID {o.id}{o.level === "ad" ? ` · Ad group: ${detail.ad_groups.find(g => g.id === o.ad_group_id)?.name ?? "Unknown"} (${o.ad_group_id})` : ""}</option>)}</SheetSelect></label>
        {dirty && <p role="status" className={hint}>Save or discard your changes before switching to another campaign, ad group or ad.</p>}
        {(optionsError || options?.videos_error || options?.languages_error || options?.audiences_error || options?.interests_error) && <div role="status" className={hint}><p>{optionsError || "Some choices could not be loaded. Your current selections are preserved."}</p><button type="button" className="mt-2 underline" disabled={busy} onClick={() => setOptionsReload(v => v + 1)}>Retry loading choices</button></div>}
        {current && <ObjectEditor key={`${current.level}:${current.id}:${reload}`} object={current} target={target} options={options} currency={detail.advertiser.currency} timezone={detail.advertiser.timezone} onBusy={setBusy} onDirty={setDirty} onChanged={onChanged} onReload={() => setReload(v => v + 1)} />}
      </>}
    </div>
  </AdsSheet>;
}

function ObjectEditor({ object, target, options, currency, timezone, onBusy, onDirty, onChanged, onReload }: { object: TiktokCampaignObject; target: TiktokCampaignTarget; options: TiktokCampaignOptions | null; currency: string | null; timezone: string | null; onBusy: (v: boolean) => void; onDirty: (v: boolean) => void; onChanged: () => void; onReload: () => void }) {
  const [settings, setSettings] = useState<TiktokSettings>({ ...object.settings });
  const [budget, setBudget] = useState(object.budget == null ? "" : String(object.budget));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [video, setVideo] = useState("");
  const [replacementDisclosure, setReplacementDisclosure] = useState<"" | "SELF_DISCLOSURE" | "NOT_DECLARED">("");
  const [generatedVideo, setGeneratedVideo] = useState<boolean | null>(null);
  const generatedVideoIds = useRef(new Set<string>());
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const latch = useRef(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const mediaRequest = useRef<{ signature: string; id: string } | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const videoId = useId();
  useEffect(() => { onBusy(busy || uploading); }, [busy, uploading, onBusy]);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView?.({ block: "center" }); }, [error]);
  const patch = (v: Partial<TiktokSettings>) => { setSettings(s => ({ ...s, ...v })); setError(""); };
  const baseChanges = settingsDiff(object.settings, settings);
  const needsDisclosure = object.level === "ad" && "video_id" in baseChanges && !!settings.video_id && object.editable_fields?.includes("aigc_disclosure_type");
  const changes = { ...baseChanges, ...(needsDisclosure && replacementDisclosure ? { aigc_disclosure_type: replacementDisclosure } : {}) };
  const selectVideo = (videoId: string, aiGenerated: boolean | null = null) => {
    if (aiGenerated === true) generatedVideoIds.current.add(videoId);
    setReplacementDisclosure(""); setGeneratedVideo(generatedVideoIds.current.has(videoId) ? true : null); patch({ video_id: videoId });
  };
  const settingsDirty = Object.keys(changes).length > 0;
  const budgetDirty = budget !== (object.budget == null ? "" : String(object.budget));
  const draftDirty = settingsDirty || budgetDirty || !!video;
  useEffect(() => { onDirty(!submitted && draftDirty); }, [draftDirty, submitted, onDirty]);
  const nameKey = object.level === "campaign" ? "campaign_name" : object.level === "ad_group" ? "adgroup_name" : "ad_name";
  const canEdit = object.status !== "DELETED";
  const disabled = busy || uploading || submitted || !canEdit;
  const editable = (field: string) => !object.editable_fields || object.editable_fields.includes(field);
  const dynamicDaily = object.budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET";
  const budgetLabel = dynamicDaily ? "Average daily budget" : "Daily budget";
  const daily = object.level !== "ad" && dailyMode(object.budget_mode) && object.budget != null;
  const floor = object.level === "campaign" ? 50 : 20;
  const budgetNumber = Number(budget);
  const budgetValid = !!budget.trim() && Number.isFinite(budgetNumber) && budgetNumber > floor && budgetNumber <= 100000 && Math.abs(budgetNumber * 100 - Math.round(budgetNumber * 100)) < 0.000001;
  const nextStatus = object.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
  const canStatus = object.status === "ACTIVE" || (object.status === "PAUSED" && currency === "USD");
  const languageConflict = settings.smart_audience_enabled === true && "languages" in changes;
  const settingsInvalid = (needsDisclosure && (!replacementDisclosure || (generatedVideo === true && replacementDisclosure !== "SELF_DISCLOSURE"))) || languageConflict || (nameKey in changes && !(settings[nameKey] ?? "").trim())
    || ("location_ids" in changes && !settings.location_ids?.length)
    || ("ad_text" in changes && !(settings.ad_text ?? "").trim())
    || ("landing_page_url" in changes && !/^https:\/\/\S+$/i.test(settings.landing_page_url ?? ""))
    || ("call_to_action" in changes && !settings.call_to_action)
    || (("bid_type" in changes || "bid_price" in changes) && settings.bid_type === "BID_TYPE_CUSTOM" && !(Number(settings.bid_price) > 0));
  async function propose(change: Record<string, unknown>) {
    if (disabled || latch.current || !Object.keys(change).length) return;
    if ("status" in change ? draftDirty : "daily_budget_usd" in change ? settingsDirty || !!video : budgetDirty || !!video) return;
    latch.current = true; setBusy(true); setError("");
    const path = `${base}/campaign-edits`;
    const body = { ...target, level: object.level, object_id: object.id, revision: object.revision, changes: change };
    request.current = requestKey(request.current, path, body);
    try {
      await campaignFetch<{ action_id: string }>(path, { method: "POST", body: JSON.stringify({ ...body, request_id: request.current.id }), headers: { "Idempotency-Key": request.current.id } });
      setSubmitted(true); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the proposal. Refresh before retrying."); }
    finally { latch.current = false; setBusy(false); }
  }
  async function prepareVideo() {
    if (disabled || latch.current || !validVideoSource(video)) return;
    latch.current = true; setBusy(true); setError("");
    const path = `${base}/campaign-videos`;
    const body = { advertiser_id: target.advertiser_id, ...videoSource(video) };
    mediaRequest.current = requestKey(mediaRequest.current, path, body);
    try {
      const r = await campaignFetch<{ video_id: string; ai_generated?: true | null }>(path, { method: "POST", body: JSON.stringify({ ...body, request_id: mediaRequest.current.id }), headers: { "Idempotency-Key": mediaRequest.current.id } });
      selectVideo(r.video_id, r.ai_generated ?? null); setVideo("");
    } catch (e) { setError(e instanceof Error ? e.message : "The video could not be prepared."); }
    finally { latch.current = false; setBusy(false); }
  }
  return <div className="space-y-6">
    <div className="flex flex-wrap gap-2 text-sm"><span className="rounded-full bg-creamDeep px-3 py-1">{object.status === "ACTIVE" ? "Enabled" : words(object.status)}</span>{object.secondary_status && <span className={hint}>{words(object.secondary_status)}</span>}</div>
    <CurrentSettings object={object} currency={currency} />
    {object.limitations?.map((line, i) => <p key={i} role="note" className={hint}>{line}</p>)}
    {submitted ? <div role="status" className="rounded-xl border border-rule bg-successBg p-4"><p className="font-semibold">Proposal ready for review.</p><p className="mt-2 text-sm">Close this editor to review and approve it on the channel. TikTok has not changed yet.</p><button type="button" className="mt-3 underline" onClick={onReload}>Read latest settings</button></div> : <>
      <form onSubmit={e => { e.preventDefault(); if (!settingsInvalid) void propose(changes); }} className="space-y-5">
        <fieldset disabled={disabled || budgetDirty} className="space-y-5">
          <label className={label}>Name<input className={input} value={settings[nameKey] ?? object.name} maxLength={512} required disabled={!editable(nameKey)} onChange={e => patch({ [nameKey]: e.target.value })} /></label>
          {object.level === "campaign" && <p className={hint}>Objective: {words(settings.objective_type ?? "Set in TikTok")}. An existing campaign’s objective cannot be changed.</p>}
          {object.level === "ad_group" && <>
            <AudienceFields value={settings} onChange={patch} options={options} advertiserId={target.advertiser_id} disabled={disabled} editableFields={object.editable_fields} existingAgeTargeting={!("age_groups" in changes)} />
            <div className="grid gap-5 sm:grid-cols-2"><label className={label}>Start time (UTC)<input className={input} type="datetime-local" step="1" value={utcInput(settings.schedule_start_time)} disabled={!editable("schedule_start_time")} onChange={e => { if (e.target.value) patch({ schedule_start_time: utcIso(e.target.value) }); }} /></label><label className={label}>End time (UTC)<input className={input} type="datetime-local" step="1" value={utcInput(settings.schedule_end_time)} disabled={!editable("schedule_end_time")} onChange={e => { if (e.target.value) patch({ schedule_end_time: utcIso(e.target.value) }); }} /></label></div>
            <AdvancedSettingsFields value={settings} onChange={patch} options={options} editableFields={object.editable_fields} disabled={disabled} currency={currency} timezone={timezone} />
            <p className={hint}>Times are entered in UTC. Account time zone: {timezone ?? "Unavailable"}. Changes must fit the campaign’s approved spending period.</p>
          </>}
          {object.level === "ad" && <>
            <CreativeFields value={settings} onChange={patch} disabled={disabled} editableFields={object.editable_fields} />
            <VideoLibraryField advertiserId={target.advertiser_id} value={settings.video_id ?? ""} onChange={id => { setVideo(""); selectVideo(id); }} options={options} disabled={disabled || !editable("video_id")} />
            {needsDisclosure && <div className="space-y-2 rounded-xl border border-rule p-3">
              <label className={label}>AI-generated content disclosure<SheetSelect required value={replacementDisclosure} disabled={disabled} onChange={e => { const value = e.target.value; setReplacementDisclosure(value === "SELF_DISCLOSURE" || value === "NOT_DECLARED" ? value : ""); }}><option value="">Choose for this replacement video</option><option value="SELF_DISCLOSURE">Add the AI-generated content label</option>{generatedVideo !== true && <option value="NOT_DECLARED">Do not add the AI-generated content label</option>}</SheetSelect></label>
              <p className={hint}>{generatedVideo === true ? "This video was generated in Zavi. Confirm the AI-generated content label before proposing the replacement." : "Choose explicitly for this replacement. The current ad’s disclosure is not carried over."}</p>
            </div>}
            {editable("video_id") && <details><summary className="cursor-pointer text-sm font-medium">Upload or choose a new video</summary><div className="mt-3 space-y-3"><label htmlFor={videoId} className={label}>Replacement video</label><VideoField id={videoId} value={video.startsWith("url:") ? "" : video} onChange={setVideo} onBusyChange={setUploading} options={(options?.zavi_videos ?? []).map(v => ({ id: `zavi:${v.artifact_id}`, label: v.filename }))} disabled={busy} /><VideoUrlField value={video} onChange={setVideo} disabled={disabled} /><button type="button" className={`${button} border border-rule`} disabled={disabled || !validVideoSource(video)} onClick={() => void prepareVideo()}>Prepare selected video</button><p className={hint}>Preparing uploads the video to your ad library. Save a proposal below to replace the ad’s video after approval.</p></div></details>}
          </>}
        </fieldset>
        {languageConflict && <p role="alert" className={hint}>Zavi cannot change languages while Smart audience expansion is enabled. Turn it off or discard the language change.</p>}
        <button type="submit" className={`${button} bg-ink text-cream`} disabled={disabled || budgetDirty || !!video || settingsInvalid || !settingsDirty}>{busy ? "Saving…" : "Review settings changes"}</button>
      </form>
      {draftDirty && <div className="rounded-xl border border-rule p-3 text-sm"><p>{video ? "Prepare your selected video and save a proposal, or discard your changes before switching items." : settingsDirty ? "Save or discard your settings changes before editing budget or delivery." : "Save or discard your budget change before switching items."}</p><button type="button" className="mt-2 underline" disabled={disabled} onClick={() => { setSettings({ ...object.settings }); setBudget(object.budget == null ? "" : String(object.budget)); setVideo(""); setReplacementDisclosure(""); setGeneratedVideo(null); }}>Discard changes</button></div>}
      {object.level !== "ad" && <section className="space-y-3 border-t border-rule pt-5"><h3 className="font-semibold">{budgetLabel}</h3>{daily ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (budgetValid) void propose({ daily_budget_usd: budgetNumber }); }}><label className={label}>{budgetLabel} ({currency ?? "currency unavailable"})<input className={input} type="number" min={floor + 0.01} max={100000} step="0.01" value={budget} disabled={disabled || settingsDirty || currency !== "USD"} onChange={e => setBudget(e.target.value)} /></label><p className={hint}>Current: {formatCurrency(object.budget, currency, true)}{dynamicDaily ? " a day on average." : " a day."}{currency === "USD" ? ` TikTok requires more than $${floor}.` : " Budget changes in Zavi are available only for USD accounts. Edit this budget in TikTok Ads Manager."}</p>{dynamicDaily && <p className={hint}>{DYNAMIC_BUDGET_EXPLANATION}</p>}<button className={`${button} border border-rule`} disabled={disabled || settingsDirty || currency !== "USD" || !budgetValid || Math.round(budgetNumber * 100) === Math.round((object.budget ?? 0) * 100)}>Review budget change</button></form> : <p className={hint}>This {words(object.level).toLowerCase()} has no daily budget of its own. For a Zavi traffic campaign, select an ad group above to edit its daily budget.</p>}</section>}
      <section className="space-y-3 border-t border-rule pt-5"><h3 className="font-semibold">Delivery</h3>{canStatus ? <><p className={hint}>{nextStatus === "PAUSED" ? "Pause this item after review and approval." : "Resume this item after review and approval. Its parent and child items keep their existing delivery settings."}</p><button type="button" className={`${button} border border-rule`} disabled={disabled || draftDirty} onClick={() => void propose({ status: nextStatus })}>{nextStatus === "PAUSED" ? "Review pause" : "Review resume"}</button></> : <p className={hint}>This item cannot be resumed here. Resuming in Zavi requires a USD account and a readable daily budget for the delivery being enabled.</p>}</section>
    </>}
    {error && <div role="alert" className="rounded-xl border border-rule p-3 text-sm"><p ref={errorRef}>{error}</p><button type="button" className="mt-3 underline" disabled={busy || uploading} onClick={onReload}>{draftDirty ? "Discard changes and reload current settings" : "Reload current settings"}</button></div>}
  </div>;
}
