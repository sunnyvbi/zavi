"use client";
import { useEffect, useId, useRef, useState } from "react";
import { AdsFormSkeleton } from "../AdsLoading";
import { requestKey } from "../api";
import { SheetSelect, sheetFooterButton as footerButton, sheetHint as hint, sheetInput as input, sheetLabel as label } from "../AdsSheet";
import { CampaignLocations } from "../CampaignLocations";
import { CampaignEditModal, EditField, EditSection, MoreSettings, ReadOnlyField, editInput } from "../CampaignEditModal";
import { CreateSheet } from "../CreateSheet";
import { landedChanges, newCampaignState } from "../editorSave";
import { GoogleAdForm, GoogleAdGroupForm, GoogleCampaignForm, MatchSelect, YoutubeCampaignForm, lines } from "./GoogleCreateForms";
import {
  editorApi,
  MATCH_TYPES,
  createGoogleCampaign,
  createGoogleChild,
  googleChildPath,
  readGoogleCampaign,
  saveGoogleEdits,
  setGoogleCampaignOn,
  setGoogleDailyBudget,
  waitForGoogleChange,
  type GoogleChange,
  type GoogleChangeOutcome,
  type GoogleEditorChannel,
  type GoogleEditorTarget,
  type GoogleEditorView,
  type MatchType,
} from "./googleEditorApi";

type Place = { id: string; name?: string };
type Row = { change: GoogleChange; outcome: GoogleChangeOutcome | null };
type Run = (w: Array<() => Promise<GoogleChange[] | GoogleChange>>) => Promise<void>;
type SubmitState = (s: { label: string; disabled: boolean; reason: string }) => void;

const usd = (n: number | null | undefined) => (n == null ? "none" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const TYPES: Record<string, string> = { SEARCH: "Search", PERFORMANCE_MAX: "Performance Max", DISPLAY: "Display", VIDEO: "Video", DEMAND_GEN: "Demand Gen", SHOPPING: "Shopping", MULTI_CHANNEL: "App" };
const typeLabel = (t: string) => TYPES[t] ?? t.replace(/_/g, " ").toLowerCase().replace(/^./, (x) => x.toUpperCase());
const matchLabel = (m: string) => MATCH_TYPES.find((t) => t.value === m)?.label ?? m.toLowerCase();

export function GoogleCampaignEditor({ target, onClose, onChanged, channel = "google_ads" }: { target: GoogleEditorTarget; onClose: () => void; onChanged: () => void; channel?: GoogleEditorChannel }) {
  const isNew = target === "new";
  const youtube = channel === "youtube_ads";
  const [view, setView] = useState<GoogleEditorView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [submit, setSubmit] = useState<{ label: string; disabled: boolean; reason: string }>({ label: isNew ? "Create paused campaign" : "Save changes", disabled: true, reason: "" });
  const formId = useId();
  const request = useRef<{ signature: string; id: string } | null>(null);
  const campaignId = isNew ? null : target.campaign_id;

  const load = () => {
    if (!campaignId) return;
    setLoadError("");
    readGoogleCampaign(campaignId, channel).then(setView, (e: Error) => setLoadError(e.message));
  };
  useEffect(load, [campaignId]);

  const run: Run = async (writes) => {
    setBusy(true);
    setRows([]);
    const done: Row[] = [];
    try {
      for (const w of writes) {
        const r = await w();
        for (const change of Array.isArray(r) ? r : [r]) done.push({ change, outcome: null });
        setRows([...done]);
      }
      if (done.length === 0) return;
      await Promise.all(
        done.map(async (row, i) => {
          const outcome = await waitForGoogleChange(row.change);
          done[i] = { ...row, outcome };
          setRows([...done]);
        }),
      );
      onChanged();
      if (campaignId) load();
    } catch (e) {
      for (const change of landedChanges<GoogleChange>(e)) done.push({ change, outcome: null });
      done.push({ change: { label: "Save", decision_id: "", approved: false, code: null }, outcome: { state: "refused", message: e instanceof Error ? e.message : "Nothing was saved." } });
      setRows([...done]);
      if (done.some((r) => r.change.decision_id && !r.outcome)) {
        await Promise.all(
          done.map(async (row, i) => {
            if (!row.change.decision_id || row.outcome) return;
            const outcome = await waitForGoogleChange(row.change);
            done[i] = { ...row, outcome };
            setRows([...done]);
          }),
        );
        onChanged();
        if (campaignId) load();
      }
    } finally {
      setBusy(false);
    }
  };

  if (target === "new") {
    const Form = youtube ? YoutubeCampaignForm : GoogleCampaignForm;
    return (
      <CreateSheet slug={channel} title={youtube ? "New YouTube Ads campaign" : "New Google Ads campaign"} busy={busy} closed={rows.some((r) => r.outcome)} submit={submit} formId={formId} onClose={onClose}>
        <Outcomes rows={rows} />
        <Form formId={formId} busy={busy} onSubmitState={setSubmit} onSave={(body) => run([() => createGoogleCampaign(body, channel)])} state={newCampaignState(rows)} />
      </CreateSheet>
    );
  }
  const create = target.create;
  if (!create) {
    return (
      <CampaignEditModal
        slug={channel}
        title="Edit campaign"
        subtitle="Settings for the whole campaign. Keywords and places are under More settings."
        busy={busy}
        formId={view && !view.read_only ? formId : null}
        submit={submit}
        cancelLabel={rows.some((r) => r.outcome) ? "Close" : "Cancel"}
        onClose={onClose}
      >
        {loadError && <p role="alert" className="text-ca-action text-ca-danger">{loadError}</p>}
        {!view && !loadError && <AdsFormSkeleton label="Reading the campaign from Google Ads…" />}
        <Outcomes rows={rows} />
        {view?.read_only === "video" ? (
          <p className="text-ca-action text-ca-secondary">This is a Video campaign. Google's Ads API can't change Video campaigns, so Zavi can only show it. Change its budget, places or status in Google Ads.</p>
        ) : view ? (
          <>
            <OnOff view={view} busy={busy} run={run} />
            <EditForm key={JSON.stringify(view)} view={view} channel={channel} formId={formId} busy={busy} onSubmitState={setSubmit} run={run} />
          </>
        ) : null}
      </CampaignEditModal>
    );
  }
  const save = (kind: "ad-groups" | "ads") => (body: Record<string, unknown>) => {
    const path = googleChildPath(target.campaign_id, kind);
    request.current = requestKey(request.current, path, body);
    const key = request.current.id;
    return run([() => createGoogleChild(path, body, key)]);
  };
  return (
    <CreateSheet slug={channel} title={`New Google Ads ${create === "group" ? "ad group" : create}`} busy={busy} closed={rows.some((r) => r.outcome)} submit={submit} formId={formId} onClose={onClose}>
      <Outcomes rows={rows} />
      {loadError && <p role="alert" className="text-ca-action text-ca-danger">{loadError}</p>}
      {!view && !loadError && <AdsFormSkeleton label="Reading the campaign from Google Ads…" />}
      {view && create === "group" && <GoogleAdGroupForm view={view} formId={formId} busy={busy} onSubmitState={setSubmit} onSave={save("ad-groups")} state={newCampaignState(rows)} />}
      {view && create === "ad" && <GoogleAdForm view={view} formId={formId} busy={busy} onSubmitState={setSubmit} onSave={save("ads")} state={newCampaignState(rows)} />}
    </CreateSheet>
  );
}

function Outcomes({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return null;
  const text = (r: Row) =>
    !r.outcome
      ? r.change.approved ? "Sending to Google Ads…" : "Waiting in Approvals."
      : r.outcome.state === "done" ? "Done in Google Ads."
      : r.outcome.state === "running" ? "Still applying. Refresh in a minute to see it."
      : r.outcome.message;
  const tone = (r: Row) => (r.outcome?.state === "refused" ? "text-danger" : r.outcome?.state === "waiting" ? "text-inkSoft" : "text-ink");
  return (
    <ul role="status" className="space-y-1.5 rounded-xl border border-rule bg-creamDeep p-4 text-[14px] leading-5" data-testid="google-editor-outcomes">
      {rows.map((r, i) => (
        <li key={`${r.change.decision_id}:${i}`}>
          <span className="font-semibold text-ink">{r.change.label}</span>: <span className={tone(r)}>{text(r)}</span>
          {r.outcome?.state === "waiting" && r.change.code !== "dispatch_unsent" && (
            <a className="ml-1 underline" href="/approvals">
              Open Approvals
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

type GroupEdit = { name: string; cpc: string; remove: string[]; add: string; match: MatchType };

function EditForm({ view, channel, formId, busy, onSubmitState, run }: { view: GoogleEditorView; channel: GoogleEditorChannel; formId: string; busy: boolean; onSubmitState: SubmitState; run: Run }) {
  const c = view.campaign;
  const ro = !view.writes_enabled;
  const manualCpc = c.bidding_strategy_type === "MANUAL_CPC";
  const takesCpa = c.bidding_strategy_type === "MAXIMIZE_CONVERSIONS" || c.bidding_strategy_type === "TARGET_CPA";
  const takesRoas = c.bidding_strategy_type === "MAXIMIZE_CONVERSION_VALUE" || c.bidding_strategy_type === "TARGET_ROAS";
  const [name, setName] = useState(c.name);
  const live = c.status === "ENABLED";
  const [budget, setBudget] = useState(c.daily_budget != null ? String(c.daily_budget) : "");
  const [target, setTarget] = useState(takesCpa && c.target_cpa != null ? String(c.target_cpa) : takesRoas && c.target_roas != null ? String(c.target_roas) : "");
  const [partners, setPartners] = useState(c.network?.search_network ?? false);
  const [display, setDisplay] = useState(c.network?.content_network ?? false);
  const [places, setPlaces] = useState<Place[]>(view.places);
  const [groupId, setGroupId] = useState(view.ad_groups[0]?.id ?? "");
  const [groups, setGroups] = useState<Record<string, GroupEdit>>(() =>
    Object.fromEntries(view.ad_groups.map((g) => [g.id, { name: g.name, cpc: g.cpc_bid != null ? String(g.cpc_bid) : "", remove: [], add: "", match: "PHRASE" as MatchType }])),
  );
  const [negRemove, setNegRemove] = useState<string[]>([]);
  const [negAdd, setNegAdd] = useState("");
  const [negMatch, setNegMatch] = useState<MatchType>("PHRASE");
  const group = view.ad_groups.find((g) => g.id === groupId) ?? null;
  const ge = group ? groups[group.id] : null;
  const patchGroup = (p: Partial<GroupEdit>) => group && setGroups((all) => ({ ...all, [group.id]: { ...all[group.id]!, ...p } }));

  const issues: string[] = [];
  const amount = Number(budget);
  const budgetChanged = !c.budget_shared && budget !== "" && amount !== c.daily_budget;
  if (budgetChanged && (!Number.isFinite(amount) || amount < 1)) issues.push("Enter a daily budget of at least $1.");
  if (budgetChanged && amount > 10_000) issues.push("A daily budget above $10,000 looks like a typo.");
  const nameChanged = name.trim() !== c.name;
  if (nameChanged && !name.trim()) issues.push("The campaign needs a name.");
  const targetNum = target.trim() === "" ? null : Number(target);
  const was = takesCpa ? c.target_cpa : takesRoas ? c.target_roas : null;
  const targetChanged = (takesCpa || takesRoas) && targetNum !== null && targetNum !== was;
  if (targetNum !== null && (!Number.isFinite(targetNum) || targetNum <= 0)) issues.push("Enter a bid target above 0.");
  const networkChanged = !!c.network && (partners !== c.network.search_network || display !== c.network.content_network);
  const placesChanged = view.places_editable && !!view.places_fingerprint && !sameSet(places.map((p) => p.id), view.places.map((p) => p.id));
  if (placesChanged && places.length === 0) issues.push("Keep at least one place to show in.");

  const groupChanges = view.ad_groups.flatMap((g) => {
    const e = groups[g.id];
    if (!e) return [];
    const p: Record<string, unknown> = { id: g.id };
    if (e.name.trim() && e.name.trim() !== g.name) p.name = e.name.trim();
    if (manualCpc && e.cpc.trim() !== "" && Number(e.cpc) !== g.cpc_bid) p.cpc_bid_usd = Number(e.cpc);
    return Object.keys(p).length > 1 ? [p] : [];
  });
  if (view.ad_groups.some((g) => manualCpc && groups[g.id] && groups[g.id]!.cpc.trim() !== "" && !(Number(groups[g.id]!.cpc) > 0))) issues.push("Enter a max cost per click above 0.");
  const adds = view.ad_groups.flatMap((g) => {
    const e = groups[g.id];
    const kws = e ? lines(e.add) : [];
    return kws.length ? [{ ad_group_id: g.id, keywords: kws.map((text) => ({ text, match_type: e!.match })) }] : [];
  });
  if (adds.some((a) => a.keywords.some((k) => k.text.length > 80))) issues.push("Keep each keyword to 80 characters.");
  const removes = view.ad_groups.flatMap((g) => (groups[g.id]?.remove ?? []).map((criterion_id) => ({ ad_group_id: g.id, criterion_id })));
  const negAdds = lines(negAdd).map((text) => ({ text, match_type: negMatch }));
  if (negAdds.some((k) => k.text.length > 80)) issues.push("Keep each negative keyword to 80 characters.");

  const anyChange = nameChanged || budgetChanged || targetChanged || networkChanged || placesChanged || groupChanges.length > 0 || adds.length > 0 || removes.length > 0 || negAdds.length > 0 || negRemove.length > 0;
  const reason = ro ? "Zavi can't change Google Ads campaigns right now." : issues[0] ?? (anyChange && live ? "Saving changes the live campaign in Google Ads now." : "");
  const disabled = ro || busy || issues.length > 0 || !anyChange;
  useEffect(() => onSubmitState({ label: "Save changes", disabled, reason }), [disabled, reason, onSubmitState]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    const edits: Record<string, unknown> = {};
    if (nameChanged) edits.name = name.trim();
    if (targetChanged) edits[takesCpa ? "target_cpa_usd" : "target_roas"] = targetNum;
    if (networkChanged) edits.network = { search_network: partners, content_network: display };
    if (placesChanged) edits.places = { ids: places.map((p) => p.id), fingerprint: view.places_fingerprint };
    if (groupChanges.length) edits.ad_groups = groupChanges;
    if (adds.length) edits.add_keywords = adds;
    if (removes.length) edits.remove_keywords = removes;
    if (negAdds.length) edits.add_negatives = negAdds;
    if (negRemove.length) edits.remove_negatives = negRemove;
    const writes: Array<() => Promise<GoogleChange[] | GoogleChange>> = [];
    if (budgetChanged) writes.push(() => setGoogleDailyBudget(c.id, c.name, amount));
    if (Object.keys(edits).length > 0) writes.push(() => saveGoogleEdits(c.id, edits, channel));
    void run(writes);
  }

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const groupAds = group ? view.ads.filter((a) => a.ad_group_id === group.id) : [];

  return (
    <form id={formId} onSubmit={save} className="flex flex-col gap-5">
      <fieldset disabled={busy || ro} className="flex min-w-0 flex-col gap-5">
        <EditSection title="Campaign">
          <EditField label="Campaign name">
            {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} className={editInput} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />}
          </EditField>
          <ReadOnlyField label="Campaign type" value={typeLabel(c.channel_type)} />
        </EditSection>
        <EditSection title="Budget">
          <EditField label="Campaign daily budget in dollars" hint={c.budget_shared ? "Shared with other campaigns. Change it in Google Ads." : "Google can spend up to twice this on a busy day, and evens it out over the month."}>
            {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} className={editInput} type="number" inputMode="decimal" min={1} max={10000} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={c.budget_shared} />}
          </EditField>
        </EditSection>
        <MoreSettings>
          {(takesCpa || takesRoas) && (
            <label className={label}>{takesCpa ? "Target cost per conversion (USD)" : "Target return on ad spend (e.g. 4 = 400%)"}<input className={input} type="number" min={0.01} step="any" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="None" /><span className={hint}>Google bids to hit this on average.</span></label>
          )}
          {c.network && (
            <fieldset>
              <legend className={label}>Where ads show</legend>
              <p className={hint}>Google Search is always on.</p>
              <div className="mt-2 flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-[14px] font-medium leading-[22px] text-ink"><input type="checkbox" checked={partners} onChange={(e) => setPartners(e.target.checked)} />Search partners</label>
                <label className="flex items-center gap-2 text-[14px] font-medium leading-[22px] text-ink"><input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} />Display Network</label>
              </div>
            </fieldset>
          )}
          {view.places_editable && view.places_fingerprint ? (
            <CampaignLocations apiBase={editorApi(channel)} label="Places to show in" selected={places} onChange={setPlaces} />
          ) : (
            <p className={hint}>{view.places.length ? `Shows in: ${view.places.map((p) => p.name).join(", ")}. ` : ""}Zavi can't change this campaign's places. Change them in Google Ads.</p>
          )}

          {group && ge && (
            <section className="space-y-4">
              <h3 className="text-[18px] font-semibold text-ink">Ad groups</h3>
              {view.ad_groups.length > 1 && (
                <label className={label}>Ad group<SheetSelect value={groupId} onChange={(e) => setGroupId(e.target.value)}>{view.ad_groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</SheetSelect></label>
              )}
              <div className="grid gap-6 md:grid-cols-2">
                <label className={label}>Ad group name<input className={input} value={ge.name} onChange={(e) => patchGroup({ name: e.target.value })} maxLength={255} /></label>
                {manualCpc && <label className={label}>Max cost per click (USD)<input className={input} type="number" min={0.01} step="any" value={ge.cpc} onChange={(e) => patchGroup({ cpc: e.target.value })} /></label>}
              </div>
              {view.keywords_editable && (
                <>
                  <fieldset>
                    <legend className={label}>Keywords</legend>
                    {group.keywords.length === 0 ? (
                      <p className={hint}>No keywords yet.</p>
                    ) : (
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {group.keywords.map((k) => {
                          const gone = ge.remove.includes(k.criterion_id);
                          return (
                            <li key={k.criterion_id}>
                              <button type="button" aria-pressed={gone} onClick={() => patchGroup({ remove: toggle(ge.remove, k.criterion_id) })} className={`rounded-full border px-3 py-1 text-[13px] ${gone ? "border-danger text-danger line-through" : "border-rule text-ink"}`} title={gone ? "Will be removed. Click to keep." : "Click to remove"}>
                                {k.text} <span className="text-inkMuted">· {matchLabel(k.match_type)}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </fieldset>
                  <div className="grid gap-6 md:grid-cols-[1fr_200px]">
                    <label className={label}>Add keywords<textarea className={`${input} min-h-20 py-2`} value={ge.add} onChange={(e) => patchGroup({ add: e.target.value })} placeholder="one per line" /></label>
                    <label className={label}>Match<MatchSelect value={ge.match} onChange={(m) => patchGroup({ match: m })} /></label>
                  </div>
                </>
              )}
              {groupAds.length > 0 && (
                <div>
                  <h4 className={label}>Ads</h4>
                  <ul className="mt-2 space-y-2">
                    {groupAds.map((a) => (
                      <li key={a.id} className="rounded-xl border border-rule p-3 text-[14px] leading-5">
                        <span className="block font-semibold text-ink">{a.headlines.slice(0, 3).join(" | ") || a.type.toLowerCase().replace(/_/g, " ")}</span>
                        {a.descriptions[0] && <span className="block truncate text-inkSoft">{a.descriptions[0]}</span>}
                        <span className="block text-inkMuted">{a.status === "ENABLED" ? "On" : "Off"}{a.final_url ? ` · ${a.final_url}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                  <p className={hint}>To change an ad's words, ask Zavi in chat or edit it in Google Ads.</p>
                </div>
              )}
            </section>
          )}

          {view.keywords_editable && (
            <section className="space-y-4">
              <h3 className="text-[18px] font-semibold text-ink">Negative keywords</h3>
              <p className={hint}>Searches this campaign never shows for.</p>
              {view.negative_keywords.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {view.negative_keywords.map((k) => {
                    const gone = negRemove.includes(k.criterion_id);
                    return (
                      <li key={k.criterion_id}>
                        <button type="button" aria-pressed={gone} onClick={() => setNegRemove(toggle(negRemove, k.criterion_id))} className={`rounded-full border px-3 py-1 text-[13px] ${gone ? "border-danger text-danger line-through" : "border-rule text-ink"}`} title={gone ? "Will be removed. Click to keep." : "Click to remove"}>
                          {k.text} <span className="text-inkMuted">· {matchLabel(k.match_type)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="grid gap-6 md:grid-cols-[1fr_200px]">
                <label className={label}>Add negative keywords<textarea className={`${input} min-h-20 py-2`} value={negAdd} onChange={(e) => setNegAdd(e.target.value)} placeholder="one per line" /></label>
                <label className={label}>Match<MatchSelect value={negMatch} onChange={setNegMatch} /></label>
              </div>
            </section>
          )}
        </MoreSettings>
        <p className="rounded-xl border border-ca-border bg-ca-surface p-3 text-ca-action text-ca-secondary">
          {live ? "This campaign is live. Saved changes go to Google Ads right away." : "This campaign is paused. Saved changes go to Google Ads right away; it stays paused."} Owners and admins only. Budget raises still count against your Zavi ad budget.
        </p>
      </fieldset>
    </form>
  );
}

function OnOff({ view, busy, run }: { view: GoogleEditorView; busy: boolean; run: Run }) {
  const c = view.campaign;
  const [confirm, setConfirm] = useState(false);
  const live = c.status === "ENABLED";
  const spend = c.daily_budget != null ? usd(c.daily_budget) : null;
  if (!view.writes_enabled) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ca-border p-4" data-testid="google-editor-onoff">
      <p className="text-ca-facts text-ca-dark">
        <span className="font-semibold text-ca-xdark">{live ? "On" : "Paused"}</span>
        {live ? (spend ? `, spending up to ${spend} a day.` : ".") : ", nothing is spending."}
      </p>
      {confirm ? (
        <span className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-ca-action text-ca-secondary">{spend ? `Starts spending up to ${spend} a day.` : "Starts spending."}</span>
          <button type="button" className={`${footerButton} !h-10 bg-ink text-cream`} disabled={busy} onClick={() => { setConfirm(false); void run([() => setGoogleCampaignOn(c.id, c.name, true)]); }}>Launch now</button>
          <button type="button" className={`${footerButton} !h-10 border border-ca-border`} disabled={busy} onClick={() => setConfirm(false)}>Not yet</button>
        </span>
      ) : live ? (
        <button type="button" className={`${footerButton} !h-10 border border-ca-border`} disabled={busy} onClick={() => void run([() => setGoogleCampaignOn(c.id, c.name, false)])}>Pause</button>
      ) : (
        <button type="button" className={`${footerButton} !h-10 bg-ink text-cream`} disabled={busy} onClick={() => setConfirm(true)}>Launch</button>
      )}
    </div>
  );
}
