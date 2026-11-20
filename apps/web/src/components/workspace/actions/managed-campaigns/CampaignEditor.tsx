"use client";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { CampaignDraft, CampaignResourceOptions, ManagedCampaign, CampaignTargeting } from "@zavi/shared";
import { campaignFetch, requestKey } from "./api";
import type { CampaignWorkspaceSpec } from "./types";
import { CampaignLocations } from "./CampaignLocations";
import { CampaignReport } from "./CampaignReport";
import { CampaignAssets } from "./CampaignAssets";
import { CampaignPreview, type PreviewRow } from "./CampaignPreview";
import { EditorSection, PresetChips, Segmented, TogglePills, daysAfter, morningIn, nextMonday } from "./CampaignEditorParts";
import { AdsSheet, SheetNote, SheetSelect, sheetFooterButton as footerButton, sheetHint as hint, sheetInput as input, sheetLabel as label } from "./AdsSheet";
type Props = { spec: CampaignWorkspaceSpec; draft?: CampaignDraft; campaign: ManagedCampaign | "new"; prefix: string; currency: string | null; onBack: () => void; onSaved: (campaign: ManagedCampaign) => void; focusSetup?: boolean };
const NAME_MAX = 60;
const sameMinute = (a: string, b: string) => !!a && a.slice(0, 16) === b.slice(0, 16);
const emptyOptions: CampaignResourceOptions = { conversion_events: [], inclusion_audiences: [], exclusion_audiences: [], product_feeds: [], warnings: [] };
const localDate = (seconds?: number | null) => { if (!seconds) return ""; const d = new Date(seconds * 1000); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
const timestamp = (value: string, original?: number | null) => value === localDate(original) ? original ?? null : value ? Math.floor(new Date(value).getTime() / 1000) : null;
const codes = (value: string) => [...new Set(value.split(/[\s,]+/).map(v => v.trim().toUpperCase()).filter(Boolean))];

export function CampaignEditor(props: Props) {
  const [detail, setDetail] = useState<ManagedCampaign | "new" | null>(props.campaign === "new" ? "new" : null);
  const [options, setOptions] = useState(emptyOptions);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const campaignId = props.campaign === "new" ? null : props.campaign.id;
  useEffect(() => {
    let stale = false;
    if (campaignId) void campaignFetch<{ campaign: ManagedCampaign }>(`${props.spec.apiBase}/campaigns/${campaignId}`).then(r => { if (!stale) setDetail(r.campaign); }).catch(e => { if (!stale) setError(e.message); });
    if (props.spec.controls?.resources) void campaignFetch<CampaignResourceOptions>(campaignId ? `${props.spec.apiBase}/campaigns/${encodeURIComponent(campaignId)}/resources` : `${props.spec.apiBase}/resources`).then(r => { if (!stale) setOptions(r); }).catch(() => { if (!stale) setOptions({ ...emptyOptions, warnings: ["Zavi could not verify tracking, audiences or product feeds. Standard click and view campaigns remain available."] }); });
    return () => { stale = true; };
  }, [campaignId, props.spec.apiBase, props.spec.controls?.resources]);
  const titleId = useId();
  const formId = useId();
  const reasonId = useId();
  const [created, setCreated] = useState(false);
  const successRef = useRef<HTMLDivElement>(null);
  const setupRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (props.focusSetup && detail && detail !== "new") setupRef.current?.scrollIntoView?.({ block: "start" }); }, [props.focusSetup, detail]);
  useEffect(() => { if (created) { successRef.current?.scrollIntoView?.({ block: "start" }); successRef.current?.focus(); } }, [created]);
  const [saving, setSaving] = useState(false);
  const [submit, setSubmit] = useState<{ label: string; disabled: boolean; reason: string } | null>(null);
  return <AdsSheet titleId={titleId} slug={props.spec.channel} size="wide" title={`${props.campaign === "new" ? "New" : "Edit"} ${props.spec.title} campaign`} busy={saving} onClose={props.onBack}
    footer={detail && submit ? <><p id={reasonId} role="status" className="order-first basis-full min-w-0 sm:order-none sm:basis-auto sm:flex-1 text-[13px] leading-5 text-inkSoft">{submit.reason}</p><button type="submit" form={formId} className={`${footerButton} shrink-0 bg-ink text-cream`} aria-describedby={submit.reason ? reasonId : undefined} disabled={submit.disabled}>{submit.label}</button></> : null}>
    <div className="space-y-6">{created && <div ref={successRef} tabIndex={-1} role="status" className="rounded-xl border border-rule bg-successBg p-4 text-ink">
      <p className="font-semibold">Campaign created and paused.</p>
      <p className="mt-2 text-sm">Next: add an ad group, then add an ad. Close this editor and choose Launch to review the campaign before it runs.</p>
      <button type="button" className="mt-3 rounded-cta border border-rule px-3 py-2 text-sm font-medium" onClick={() => { setupRef.current?.scrollIntoView?.({ block: "start" }); setupRef.current?.focus(); }}>Continue to ad setup</button>
    </div>}{error && <p role="alert">{error}</p>}{detail ? <EditorForm key={`${detail === "new" ? "new" : detail.id}:${revision}`} {...props} campaign={detail} options={options} formId={formId} setupRef={setupRef} onSubmitState={setSubmit} onBusy={setSaving} onSaved={c => { if (detail === "new" && c.status === "paused") setCreated(true); setDetail(c); setRevision(v => v + 1); props.onSaved(c); }} /> : <p role="status">Reading current campaign settings…</p>}</div>
  </AdsSheet>;
}
type FormProps = Props & { options: CampaignResourceOptions; formId: string; onBusy: (busy: boolean) => void; setupRef: RefObject<HTMLDivElement | null>; onSubmitState: (state: { label: string; disabled: boolean; reason: string }) => void };
function EditorForm({ spec, draft, campaign, prefix, currency, onSaved, onBusy, onSubmitState, formId, options, setupRef }: FormProps) {
  const existing = campaign === "new" ? null : campaign;
  const [name, setName] = useState(existing ? existing.name.replace(prefix, "") : (draft?.name ?? "").replace(prefix, ""));
  const [budgetType, setBudgetType] = useState(existing?.budget?.daily_spend_limit_micros != null ? "daily" : "lifetime");
  const [budget, setBudget] = useState(existing?.budget ? String((existing.budget.daily_spend_limit_micros ?? existing.budget.lifetime_spend_limit_micros ?? 0) / 1e6) : "");
  const [objective, setObjective] = useState(existing?.bidding_type ?? draft?.bidding_type ?? spec.objectives[0]?.value ?? "");
  const [event, setEvent] = useState(existing?.conversion_event_setting_ids?.[0] ?? draft?.conversion_event_setting_ids?.[0] ?? "");
  const [start, setStart] = useState(localDate(existing?.start_time));
  const [end, setEnd] = useState(localDate(existing?.end_time));
  const [countries, setCountries] = useState(existing?.targeting?.locations?.countries?.join(", ") ?? "");
  const [excludedCountries, setExcludedCountries] = useState(existing?.targeting?.excluded_locations?.countries?.join(", ") ?? "");
  const [locations, setLocations] = useState(existing?.targeting?.locations?.include ?? []);
  const [excludedLocations, setExcludedLocations] = useState(existing?.targeting?.excluded_locations?.include ?? []);
  const [platforms, setPlatforms] = useState(existing?.targeting?.platforms?.included ?? spec.controls?.platforms.map(p => p.value) ?? []);
  const [included, setIncluded] = useState(existing?.targeting?.custom_audiences?.ids ?? []);
  const [excluded, setExcluded] = useState(existing?.targeting?.excluded_custom_audiences?.ids ?? []);
  const [feed, setFeed] = useState(existing?.product_feed_id ?? "");
  const [template, setTemplate] = useState(existing?.landing_page_configuration?.query_string_template ?? "");
  const nameId = useId();
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView?.({ block: "center" }); }, [error]);
  const latch = useRef(false); const request = useRef<{ signature: string; id: string } | null>(null);
  const objectiveSpec = spec.objectives.find(o => o.value === objective);
  const conversion = objectiveSpec?.requiresEvent;
  const daily = budgetType === "daily";
  const minimum = daily ? spec.controls?.dailyMinimum ?? 25 : 1;
  const amount = Math.round(Number(budget) * 1e6);
  const oldAmount = existing?.budget?.daily_spend_limit_micros ?? existing?.budget?.lifetime_spend_limit_micros;
  const startTime = timestamp(start, existing?.start_time), endTime = timestamp(end, existing?.end_time);
  const financialEdit = amount !== oldAmount || startTime !== (existing?.start_time ?? null) || endTime !== (existing?.end_time ?? null);
  const issues: string[] = [];
  if (existing?.status === "archived") issues.push("Archived campaigns cannot be edited.");
  if (name.trim().length < 3) issues.push("Enter a campaign name with at least 3 characters.");
  if (!currency) issues.push("The account currency is unavailable. Close this form and refresh the account.");
  if (!budget || !Number.isFinite(Number(budget)) || Number(budget) < minimum) issues.push(`Enter a ${daily ? "daily" : "total"} budget of at least ${minimum} ${currency ?? "in the account currency"}.`);
  else if (Number(budget) > 1000000) issues.push("Enter a budget no greater than 1,000,000.");
  else if (Math.abs(Number(budget) * 100 - Math.round(Number(budget) * 100)) > 0.000001) issues.push("Enter a budget with at most two decimal places.");
  if (conversion && !event) issues.push(options.conversion_events.length ? "Select a conversion event." : "Connect and verify a conversion event, or choose another objective.");
  if (spec.controls) {
    if (!platforms.length) issues.push("Select at least one platform.");
    if (daily && !start) issues.push("Enter a start time.");
    if (daily && !end) issues.push("Enter an end time.");
    if (!existing || financialEdit || existing.status === "active") {
      if (endTime != null && (endTime <= (startTime ?? Date.now() / 1000) || endTime <= Date.now() / 1000)) issues.push("Choose an end time after the start and in the future.");
      if (daily && startTime != null && endTime != null && endTime - startTime > 90 * 86400) issues.push("Choose a daily campaign schedule no longer than 90 days.");
    }
  }
  const reason = issues.join(" ");
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const submitLabel = busy ? "Saving…" : existing ? "Save changes" : "Create paused campaign";
  const submitDisabled = busy || issues.length > 0;
  useEffect(() => { onSubmitState({ label: submitLabel, disabled: submitDisabled, reason }); }, [submitLabel, submitDisabled, reason, onSubmitState]);
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (submitDisabled || latch.current) return;
    latch.current = true; setBusy(true); onBusy(true); setError("");
    try {
      const targeting: CampaignTargeting = { ...existing?.targeting, locations: { countries: codes(countries), include: locations.map(({ id }) => ({ id })) }, excluded_locations: { countries: codes(excludedCountries), include: excludedLocations.map(({ id }) => ({ id })) }, ...(platforms.length ? { platforms: { included: platforms } } : {}), custom_audiences: { ids: included }, excluded_custom_audiences: { ids: excluded } };
      const body: Record<string, unknown> = { name: name.trim() };
      if (amount !== oldAmount) body[daily ? "daily_budget_micros" : "lifetime_budget_micros"] = amount;
      if (spec.controls) {
        if (changed(targeting, existing?.targeting)) body.targeting = targeting;
        if (startTime !== (existing?.start_time ?? null)) body.start_time = startTime;
        if (endTime !== (existing?.end_time ?? null)) body.end_time = endTime;
        if (template !== (existing?.landing_page_configuration?.query_string_template ?? "")) body.landing_page_configuration = { query_string_template: template };
      }
      if (existing) body.expected_updated_at = existing.updated_at;
      else { body.bidding_type = objective; if (conversion) body.conversion_event_setting_ids = [event]; if (feed) { body.mode = "product_feed"; body.product_feed_id = feed; } }
      const path = `${spec.apiBase}/campaigns${existing ? `/${existing.id}` : ""}`;
      request.current = requestKey(request.current, path, body);
      const r = await campaignFetch<{ campaign: ManagedCampaign }>(path, { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": request.current.id } });
      onSaved(r.campaign);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save campaign."); }
    finally { latch.current = false; setBusy(false); onBusy(false); }
  }
  const multi = (legend: string, rows: Array<{ id: string; name: string }>, selected: string[], update: (v: string[]) => void) => <fieldset className="space-y-2"><legend className={label}>{legend}</legend>{[...rows, ...selected.filter(id => !rows.some(r => r.id === id)).map(id => ({ id, name: "Previously assigned audience (unavailable)" }))].map(r => <label key={r.id} className="flex items-center gap-2 text-[14px] font-medium leading-[22px] text-ink"><input type="checkbox" checked={selected.includes(r.id)} disabled={busy} onChange={e => update(e.target.checked ? [...selected, r.id] : selected.filter(id => id !== r.id))} />{r.name}</label>)}</fieldset>;
  const [nameMax] = useState(() => Math.max(NAME_MAX, name.length));
  const goal = spec.objectives.find(o => o.value === objective);
  const money = (n: string) => Number.isFinite(Number(n)) && Number(n) > 0 ? `${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency ?? ""}`.trim() : null;
  const places = [...codes(countries), ...locations.map(l => l.name ?? l.id)];
  const day = (v: string) => new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const rows: PreviewRow[] = [
    { label: "Goal", value: goal?.short ?? goal?.label ?? "-" },
    { label: "Who sees it", value: places.length ? places.join(", ") : "All available locations" },
    ...(spec.controls ? [{ label: "Shown on", value: spec.controls.platforms.filter(p => platforms.includes(p.value)).map(p => p.label).join(", ") || "-" }] : []),
    { label: "Budget", value: money(budget) ? `${daily ? "About" : "Up to"} ${money(budget)}${daily ? " a day" : " in total"}` : "Not set yet" },
    { label: "Runs", value: `${start ? `From ${day(start)}` : "When you launch it"} · ${end ? `until ${day(end)}` : "no end date"}` },
  ];
  const startChips = [
    { label: "When launched", active: !start, disabled: daily, onPick: () => setStart("") },
    { label: "Tomorrow", active: sameMinute(start, morningIn(1)), onPick: () => setStart(morningIn(1)) },
    { label: "Next Monday", active: sameMinute(start, nextMonday()), onPick: () => setStart(nextMonday()) },
  ];
  const endChips = [
    { label: "No end date", active: !end, disabled: daily, onPick: () => setEnd("") },
    { label: "After 7 days", active: !!end && sameMinute(end, daysAfter(start, 7)), onPick: () => setEnd(daysAfter(start, 7)) },
    { label: "After 30 days", active: !!end && sameMinute(end, daysAfter(start, 30)), onPick: () => setEnd(daysAfter(start, 30)) },
  ];
  return <><div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_336px]"><form id={formId} onSubmit={save} className="ads-sheet-form min-w-0">
    <fieldset disabled={busy || existing?.status === "archived"} className="min-w-0 space-y-8">
    <EditorSection title="Campaign">
      <div><div className="flex items-baseline justify-between gap-3"><label htmlFor={nameId} className={label}>Campaign name</label><span aria-hidden className="text-[13px] font-medium tabular-nums text-inkMuted">{name.length}/{nameMax}</span></div><input id={nameId} className={input} value={name} onChange={e => setName(e.target.value)} required minLength={3} maxLength={nameMax} /></div>
      <Segmented legend="Goal" value={objective} onChange={setObjective} disabled={!!existing} options={spec.objectives.map(o => ({ value: o.value, label: o.short ?? o.label }))} />
      {goal?.plainGoal && <p className={`${hint} !mt-2`}>{goal.plainGoal.replace("{site}", "your site")}.</p>}
      {conversion && <label className={label}>Conversion event<SheetSelect value={event} onChange={e => setEvent(e.target.value)} disabled={!!existing} required><option value="">Select a verified event</option>{options.conversion_events.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</SheetSelect><span className={hint}>Optimizes for this action; billed per valid click. {options.conversion_events.length === 0 && "Zavi must connect and verify this workspace’s conversion tracking before creation."}</span></label>}
    </EditorSection>
    {spec.controls && <EditorSection title="Target audience">
      <div className="grid gap-5 md:grid-cols-2"><label className={label}>Target countries<input className={input} value={countries} onChange={e => setCountries(e.target.value)} placeholder="US, CA" /><span className={hint}>Two-letter country codes. Blank means all available locations. Provider account restrictions apply.</span></label><label className={label}>Exclude countries<input className={input} value={excludedCountries} onChange={e => setExcludedCountries(e.target.value)} placeholder="GB" /></label></div>
      {!feed && <div className="grid gap-5 md:grid-cols-2"><CampaignLocations apiBase={spec.apiBase} label="Include locations" selected={locations} onChange={setLocations} /><CampaignLocations apiBase={spec.apiBase} label="Exclude locations" selected={excludedLocations} onChange={setExcludedLocations} /></div>}
      <TogglePills legend="Platforms" selected={platforms} onChange={setPlatforms} options={spec.controls.platforms.map(p => ({ value: p.value, label: p.label }))} hint={<p className={hint}>Select at least one platform.</p>} />
      {(options.inclusion_audiences.length > 0 || included.length > 0) && multi("Include audiences", options.inclusion_audiences, included, setIncluded)}
      {(options.exclusion_audiences.length > 0 || excluded.length > 0) && multi("Exclude audiences", options.exclusion_audiences, excluded, setExcluded)}
    </EditorSection>}
    <EditorSection title="Budget and dates">
      {spec.controls && <Segmented legend="Budget type" value={budgetType} onChange={setBudgetType} disabled={!!existing} options={[{ value: "lifetime", label: "Campaign total" }, { value: "daily", label: "Daily average" }]} />}
      <label className={label}>{daily ? "Daily average budget" : "Lifetime campaign budget"} ({currency ?? "currency unavailable"})<input className={input} type="number" min={daily ? spec.controls?.dailyMinimum ?? 25 : 1} max={1000000} step="0.01" value={budget} onChange={e => setBudget(e.target.value)} required />{daily && <span className={hint}>{spec.title} needs at least {spec.controls?.dailyMinimum ?? 25} {currency ?? ""} a day.</span>}</label>
      {spec.controls && <><div className="grid gap-5 md:grid-cols-2"><div><label className={label}>Start time<input className={input} type="datetime-local" step="1" value={start} onChange={e => setStart(e.target.value)} required={daily} /></label>{!existing && <PresetChips label="Start presets" chips={startChips} />}</div><div><label className={label}>End time<input className={input} type="datetime-local" step="1" value={end} onChange={e => setEnd(e.target.value)} required={daily} /></label>{!existing && <PresetChips label="End presets" chips={endChips} />}</div></div><p className={`${hint} !mt-3`}>Times use your browser’s timezone. {daily ? "Daily campaigns require an end date within 90 days. Daily spend can reach twice the average. Zavi reserves twice the daily budget for the scheduled days plus a two-day buffer; previous coverage is retained when budgets change." : "The total budget includes spend to date."}</p></>}
    </EditorSection>
    {spec.controls && <EditorSection title="Where it goes">
      {spec.controls.productFeeds && <label className={label}>Creative source<SheetSelect value={feed} onChange={e => { setFeed(e.target.value); if (e.target.value) { setLocations([]); setExcludedLocations([]); } }} disabled={!!existing}><option value="">Standard ads</option>{options.product_feeds.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</SheetSelect><span className={hint}>Product feeds appear after Zavi connects a catalog to this workspace.</span></label>}
      <label className={label}>Campaign tracking template<input className={input} value={template} onChange={e => setTemplate(e.target.value)} placeholder="utm_source=chatgpt&utm_campaign={campaign_id}&click_id={oppref}" /><span className={hint}>The landing page is set on each ad. This adds tracking to every click.</span></label>
      {options.warnings.map(w => <p key={w} role="status" className={hint}>{w}</p>)}
    </EditorSection>}
    <SheetNote>{existing?.status === "active" ? "Saving changes to an active campaign affects live delivery. Budget increases require available wallet balance." : "Saving creates the campaign paused. Next, add an ad group and an ad, then review and launch the campaign."} Spend reporting can be delayed; pausing does not instantly stop all billable activity.</SheetNote>
    {error && <p ref={errorRef} role="alert" className="text-sm text-danger">{error}</p>}
    </fieldset></form>
    <CampaignPreview slug={spec.channel} ad={draft?.ads[0]} rows={rows} note={existing ? "Changes apply when you save." : "Saved paused. Nothing spends until you review and launch it."} /></div>
    {existing && spec.controls && <CampaignReport base={`${spec.apiBase}/campaigns/${existing.id}`} currency={currency} />}
    {existing && <div ref={setupRef} tabIndex={-1}><CampaignAssets spec={spec} draft={draft} campaignId={existing.id} campaign={existing} currency={currency} /></div>}
  </>;
}
