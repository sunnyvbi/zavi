"use client";
import { useEffect, useId, useRef, useState } from "react";
import { AdsFormSkeleton } from "../AdsLoading";
import { requestKey } from "../api";
import { SheetSelect, sheetFooterButton as footerButton, sheetHint as hint, sheetInput as input, sheetLabel as label } from "../AdsSheet";
import { CampaignLocations } from "../CampaignLocations";
import { CampaignEditModal, EditField, EditSection, MoreSettings, ReadOnlyField, editInput } from "../CampaignEditModal";
import { CreateSheet } from "../CreateSheet";
import { landedChanges, newCampaignState } from "../editorSave";
import { MetaAdForm, MetaAdSetForm, MetaCampaignForm, Placements } from "./MetaCreateForms";
import {
  META_API,
  createMetaCampaign,
  createMetaChild,
  metaChildPath,
  readMetaCampaign,
  saveMetaEdits,
  setMetaCampaignOn,
  setMetaDailyBudget,
  waitForMetaChange,
  type MetaChange,
  type MetaChangeOutcome,
  type MetaEditorTarget,
  type MetaEditorView,
  type MetaPlacement,
} from "./metaEditorApi";

type Place = { id: string; name?: string };
type Row = { change: MetaChange; outcome: MetaChangeOutcome | null };

const money = (n: number | null | undefined, currency: string) =>
  n == null ? "none" : `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;

const localValue = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const toIso = (local: string) => (local ? new Date(local).toISOString().replace(/\.\d{3}Z$/, "+00:00") : undefined);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export function MetaCampaignEditor({ target, onClose, onChanged }: { target: MetaEditorTarget; onClose: () => void; onChanged: () => void }) {
  const isNew = target === "new";
  const [view, setView] = useState<MetaEditorView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [submit, setSubmit] = useState<{ label: string; disabled: boolean; reason: string }>({ label: isNew ? "Build paused campaign" : "Save changes", disabled: true, reason: "" });
  const formId = useId();
  const request = useRef<{ signature: string; id: string } | null>(null);
  const campaignId = isNew ? null : target.campaign_id;

  const load = () => {
    if (!campaignId) return;
    setLoadError("");
    readMetaCampaign(campaignId).then(setView, (e: Error) => setLoadError(e.message));
  };
  useEffect(load, [campaignId]);

  async function run(writes: Array<() => Promise<MetaChange[] | MetaChange>>) {
    setBusy(true);
    setRows([]);
    const done: Row[] = [];
    try {
      for (const w of writes) {
        const r = await w();
        for (const change of Array.isArray(r) ? r : [r]) done.push({ change, outcome: null });
        setRows([...done]);
      }
      if (done.length === 0) {
        setRows([]);
        return;
      }
      await Promise.all(
        done.map(async (row, i) => {
          const outcome = await waitForMetaChange(row.change);
          done[i] = { ...row, outcome };
          setRows([...done]);
        }),
      );
      onChanged();
      if (campaignId) load();
    } catch (e) {
      for (const change of landedChanges<MetaChange>(e)) done.push({ change, outcome: null });
      done.push({ change: { label: "Save", decision_id: "", approved: false, code: null }, outcome: { state: "refused", message: e instanceof Error ? e.message : "Nothing was saved." } });
      setRows([...done]);
      if (done.some((r) => r.change.decision_id && !r.outcome)) {
        await Promise.all(
          done.map(async (row, i) => {
            if (!row.change.decision_id || row.outcome) return;
            const outcome = await waitForMetaChange(row.change);
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
  }

  if (target === "new") {
    return (
      <CreateSheet slug="meta_ads" title="New Meta Ads campaign" busy={busy} closed={rows.some((r) => r.outcome)} submit={submit} formId={formId} onClose={onClose}>
        <Outcomes rows={rows} />
        <MetaCampaignForm formId={formId} busy={busy} onSubmitState={setSubmit} onSave={(body) => run([() => createMetaCampaign(body)])} state={newCampaignState(rows)} />
      </CreateSheet>
    );
  }
  const create = target.create;
  if (!create) {
    return (
      <CampaignEditModal
        slug="meta_ads"
        title="Edit campaign"
        subtitle="Settings for the whole campaign. Places and placements are under More settings. To change what an ad says, ask Zavi in chat or edit it in Meta."
        busy={busy}
        formId={view ? formId : null}
        submit={submit}
        cancelLabel={rows.some((r) => r.outcome) ? "Close" : "Cancel"}
        onClose={onClose}
      >
        {loadError && <p role="alert" className="text-ca-action text-ca-danger">{loadError}</p>}
        {!view && !loadError && <AdsFormSkeleton label="Reading the campaign from Meta…" />}
        <Outcomes rows={rows} />
        {view && (
          <>
            <OnOff view={view} busy={busy} run={run} />
            <EditForm key={JSON.stringify(view)} view={view} formId={formId} busy={busy} onSubmitState={setSubmit} run={run} />
          </>
        )}
      </CampaignEditModal>
    );
  }
  const save = (kind: "ad-sets" | "ads") => (body: Record<string, unknown>) => {
    const path = metaChildPath(target.campaign_id, kind);
    request.current = requestKey(request.current, path, body);
    const key = request.current.id;
    return run([() => createMetaChild(path, body, key)]);
  };
  return (
    <CreateSheet slug="meta_ads" title={`New Meta Ads ${create === "group" ? "ad set" : create}`} busy={busy} closed={rows.some((r) => r.outcome)} submit={submit} formId={formId} onClose={onClose}>
      <Outcomes rows={rows} />
      {loadError && <p role="alert" className="text-ca-action text-ca-danger">{loadError}</p>}
      {!view && !loadError && <AdsFormSkeleton label="Reading the campaign from Meta…" />}
      {view && create === "group" && <MetaAdSetForm view={view} formId={formId} busy={busy} onSubmitState={setSubmit} onSave={save("ad-sets")} state={newCampaignState(rows)} />}
      {view && create === "ad" && <MetaAdForm view={view} formId={formId} busy={busy} onSubmitState={setSubmit} onSave={save("ads")} state={newCampaignState(rows)} />}
    </CreateSheet>
  );
}

function Outcomes({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return null;
  const text = (r: Row) =>
    !r.outcome
      ? r.change.approved ? "Sending to Meta…" : "Waiting in Approvals."
      : r.outcome.state === "done" ? "Done in Meta."
      : r.outcome.state === "running" ? "Still applying. Refresh in a minute to see it."
      : r.outcome.message;
  const tone = (r: Row) => (r.outcome?.state === "refused" ? "text-danger" : r.outcome?.state === "waiting" ? "text-inkSoft" : "text-ink");
  return (
    <ul role="status" className="space-y-1.5 rounded-xl border border-rule bg-creamDeep p-4 text-[14px] leading-5" data-testid="meta-editor-outcomes">
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

type SubmitState = (s: { label: string; disabled: boolean; reason: string }) => void;

const GOALS: Record<string, string> = {
  OUTCOME_SALES: "Sales", CONVERSIONS: "Sales", OUTCOME_TRAFFIC: "Website visits", LINK_CLICKS: "Website visits",
  OUTCOME_AWARENESS: "Awareness", REACH: "Awareness", BRAND_AWARENESS: "Awareness", OUTCOME_LEADS: "Leads", LEAD_GENERATION: "Leads",
  OUTCOME_ENGAGEMENT: "Engagement", OUTCOME_APP_PROMOTION: "App promotion",
};
const goalLabel = (objective: string | null) => (objective ? GOALS[objective] ?? objective.replace(/^OUTCOME_/, "").replace(/_/g, " ").toLowerCase().replace(/^./, (x) => x.toUpperCase()) : "Not set");
const NAME_MAX = 200;

function EditForm({ view, formId, busy, onSubmitState, run }: { view: MetaEditorView; formId: string; busy: boolean; onSubmitState: SubmitState; run: (w: Array<() => Promise<MetaChange[] | MetaChange>>) => Promise<void> }) {
  const c = view.campaign;
  const cur = view.currency;
  const unit = cur === "USD" ? "dollars" : cur;
  const plainName = c.name;
  const live = c.status === "ACTIVE";
  const [name, setName] = useState(plainName);
  const budgetEditable = c.budget_level === "campaign" || c.budget_level === "ad_set";
  const [budget, setBudget] = useState(c.daily_budget != null ? String(c.daily_budget) : "");
  const [cap, setCap] = useState(c.spend_cap != null ? String(c.spend_cap) : "");
  const [setId, setSetId] = useState(view.ad_sets[0]?.id ?? "");
  const set = view.ad_sets.find((s) => s.id === setId) ?? null;
  const [end, setEnd] = useState(localValue(set?.end_time ?? null));
  const [places, setPlaces] = useState<Place[]>(set?.places ?? []);
  const [placements, setPlacements] = useState<MetaPlacement[] | null>(set?.placements ?? null);
  useEffect(() => {
    setEnd(localValue(set?.end_time ?? null));
    setPlaces(set?.places ?? []);
    setPlacements(set?.placements ?? null);
  }, [setId]); // eslint-disable-line react-hooks/exhaustive-deps

  const ro = !view.writes_enabled;
  const issues: string[] = [];
  const amount = Number(budget);
  const budgetChanged = budgetEditable && budget !== "" && amount !== c.daily_budget;
  if (budgetChanged && (!Number.isFinite(amount) || amount < 1)) issues.push("Enter a daily budget of at least 1.");
  if (budgetChanged && amount > 10_000) issues.push("A daily budget above 10,000 looks like a typo.");
  const capValue = cap.trim() === "" ? null : Number(cap);
  const capChanged = Math.round((capValue ?? 0) * 100) !== Math.round((c.spend_cap ?? 0) * 100);
  if (capValue !== null && (!Number.isFinite(capValue) || capValue <= 0)) issues.push("Enter a spend limit above 0, or leave it blank for none.");
  const nameChanged = name.trim() !== plainName;
  if (nameChanged && name.trim().length < 1) issues.push("The campaign needs a name.");
  if (nameChanged && name.trim().length > NAME_MAX) issues.push(`Keep the name to ${NAME_MAX} characters.`);
  const endIso = toIso(end);
  const endChanged = !!set && !!end && localValue(set.end_time) !== end;
  if (endChanged && new Date(end).getTime() <= Date.now()) issues.push("Pick an end date in the future.");
  const placesChanged = !!set && set.places_editable && !sameSet(places.map((p) => p.id), set.places.map((p) => p.id));
  if (placesChanged && places.length === 0) issues.push("Keep at least one place to show in.");
  const placementsChanged = !!set && placements !== null && !sameSet(placements, set.placements ?? []);
  if (placements !== null && placements.length === 0) issues.push("Pick at least one placement.");
  if (set && placements === null && set.placements !== null) issues.push("Zavi can't switch an ad set back to Advantage+ placements yet. Pick placements, or change it in Meta.");
  const anyChange = nameChanged || budgetChanged || capChanged || endChanged || placesChanged || placementsChanged;
  const reason = ro ? "Zavi can't change Meta campaigns right now." : issues[0] ?? (anyChange && live ? "Saving changes the live campaign in Meta now." : "");
  const disabled = ro || busy || issues.length > 0 || !anyChange;
  useEffect(() => onSubmitState({ label: "Save changes", disabled, reason }), [disabled, reason, onSubmitState]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    const edits: Record<string, unknown> = {};
    if (nameChanged) edits.name = name.trim();
    if (capChanged) edits.spend_cap = capValue;
    if (set && (endChanged || placesChanged || placementsChanged)) {
      edits.ad_set = {
        id: set.id,
        ...(endChanged ? { end_time: endIso } : {}),
        ...(placesChanged ? { places: places.map((p) => p.id) } : {}),
        ...(placementsChanged ? { placements } : {}),
      };
    }
    const writes: Array<() => Promise<MetaChange[] | MetaChange>> = [];
    if (budgetChanged) writes.push(() => setMetaDailyBudget(c.id, plainName, amount));
    if (Object.keys(edits).length > 0) writes.push(() => saveMetaEdits(c.id, edits));
    void run(writes);
  }

  const budgetHint =
    c.budget_level === "lifetime" ? "This campaign has a lifetime budget. Change it in Meta."
    : c.budget_level === "mixed" ? "More than one ad set holds a budget. Change those in Meta."
    : c.budget_level === "none" ? "No daily budget was found on this campaign."
    : c.budget_level === "campaign" ? "Shared across its ad sets." : "The budget of its ad set.";

  return (
    <form id={formId} onSubmit={save} className="flex flex-col gap-5">
      <fieldset disabled={busy || ro} className="flex min-w-0 flex-col gap-5">
        <EditSection title="Campaign">
          <EditField label="Campaign name" counter={`${name.length}/${NAME_MAX}`}>
            {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} className={editInput} value={name} maxLength={Math.max(NAME_MAX, plainName.length)} onChange={(e) => setName(e.target.value)} />}
          </EditField>
          <ReadOnlyField label="Goal" value={goalLabel(c.objective)} note="A launched campaign keeps its goal. For another goal, create a new campaign." />
        </EditSection>
        <EditSection title="Budget">
          <EditField label={`${c.budget_level === "ad_set" ? "Ad set" : "Campaign"} daily budget in ${unit}`} hint={budgetHint}>
            {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} className={editInput} type="number" inputMode="decimal" min={1} max={10000} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} disabled={!budgetEditable} />}
          </EditField>
          <EditField label={`Spend limit in ${unit} (optional)`} hint="The campaign stops once it has spent this much in all.">
            {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} className={editInput} type="number" inputMode="decimal" min={1} step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} />}
          </EditField>
        </EditSection>
        {set && (
          <MoreSettings>
            {view.ad_sets.length > 1 && (
              <label className={label}>Ad set<SheetSelect value={setId} onChange={(e) => setSetId(e.target.value)}>{view.ad_sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</SheetSelect><span className={hint}>End date, places and placements belong to one ad set.</span></label>
            )}
            <label className={label}>End date<input className={input} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /><span className={hint}>{set.end_time ? "Your browser's time zone." : "Runs until paused. Set a date to make it stop by itself."}</span></label>
            {set.places_editable ? (
              <CampaignLocations apiBase={META_API} label="Places to show in" selected={places} onChange={setPlaces} />
            ) : (
              <p className={hint}>This ad set targets places in a way Zavi can't show (a radius or postcodes). Change its places in Meta.</p>
            )}
            <Placements value={placements} onChange={setPlacements} disabled={busy || ro} />
          </MoreSettings>
        )}
        <p className="rounded-xl border border-ca-border bg-ca-surface p-3 text-ca-action text-ca-secondary">
          {live ? "This campaign is live. Saved changes go to Meta right away." : "This campaign is paused. Saved changes go to Meta right away; it stays paused."} Owners and admins only. Budget raises still count against your Zavi ad budget.
        </p>
      </fieldset>
    </form>
  );
}

function OnOff({ view, busy, run }: { view: MetaEditorView; busy: boolean; run: (w: Array<() => Promise<MetaChange[] | MetaChange>>) => Promise<void> }) {
  const c = view.campaign;
  const [confirm, setConfirm] = useState(false);
  const live = c.status === "ACTIVE";
  const spend = c.daily_budget != null ? money(c.daily_budget, view.currency) : null;
  if (!view.writes_enabled) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ca-border p-4" data-testid="meta-editor-onoff">
      <p className="text-ca-facts text-ca-dark">
        <span className="font-semibold text-ca-xdark">{live ? "On" : "Paused"}</span>
        {live ? (spend ? `, spending up to ${spend} a day.` : ".") : ", nothing is spending."}
      </p>
      {confirm ? (
        <span className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-ca-action text-ca-secondary">{spend ? `Starts spending up to ${spend} a day.` : "Starts spending."}</span>
          <button type="button" className={`${footerButton} !h-10 bg-ink text-cream`} disabled={busy} onClick={() => { setConfirm(false); void run([() => setMetaCampaignOn(c.id, c.name, true)]); }}>Launch now</button>
          <button type="button" className={`${footerButton} !h-10 border border-ca-border`} disabled={busy} onClick={() => setConfirm(false)}>Not yet</button>
        </span>
      ) : live ? (
        <button type="button" className={`${footerButton} !h-10 border border-ca-border`} disabled={busy} onClick={() => void run([() => setMetaCampaignOn(c.id, c.name, false)])}>Pause</button>
      ) : (
        <button type="button" className={`${footerButton} !h-10 bg-ink text-cream`} disabled={busy} onClick={() => setConfirm(true)}>Launch</button>
      )}
    </div>
  );
}
