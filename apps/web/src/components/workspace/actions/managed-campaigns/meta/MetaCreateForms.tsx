"use client";
import { useEffect, useState } from "react";
import { SheetNote, SheetSelect, sheetHint as hint, sheetInput as input, sheetLabel as label } from "../AdsSheet";
import { CampaignLocations } from "../CampaignLocations";
import { EditorSection, Segmented } from "../CampaignEditorParts";
import type { PreviewRow } from "../CampaignPreview";
import { AdCard, CreateColumns, createReason, httpsLink, type CreateFormProps } from "../CreateSheet";
import type { NewCampaignState } from "../editorSave";
import { META_API, META_CONVERSION_EVENTS, META_CTAS, META_GOALS, META_PLACEMENTS, type MetaEditorView, type MetaGoal, type MetaPlacement } from "./metaEditorApi";

type Place = { id: string; name?: string };
type Audience = { places: Place[]; placements: MetaPlacement[] | null; ageMin: string; ageMax: string };
type Creative = { headline: string; text: string; link: string; image: string; cta: string };

const AUDIENCE: Audience = { places: [], placements: null, ageMin: "18", ageMax: "65" };
const CREATIVE: Creative = { headline: "", text: "", link: "", image: "", cta: "LEARN_MORE" };
const OBJECTIVE_GOAL: Record<string, MetaGoal> = { OUTCOME_TRAFFIC: "traffic", OUTCOME_AWARENESS: "awareness", OUTCOME_SALES: "conversions" };
const BUILD_REASON: Record<Exclude<NewCampaignState, "open">, string> = {
  done: "Built. It stays paused until you launch it from the campaign list.",
  sending: "Building it in Meta. It shows in the campaign list once Meta has it.",
  waiting: "It is waiting in Approvals. Approve it there to build it.",
};

const toIso = (local: string) => (local ? new Date(local).toISOString().replace(/\.\d{3}Z$/, "+00:00") : undefined);
const ctaLabel = (value: string) => META_CTAS.find(([key]) => key === value)?.[1] ?? "";

function audienceIssues(a: Audience): string[] {
  const issues: string[] = [];
  if (a.places.length === 0) issues.push("Pick at least one place to show in.");
  if (a.placements !== null && a.placements.length === 0) issues.push("Pick at least one placement, or let Meta choose.");
  if (Number(a.ageMin) > Number(a.ageMax)) issues.push("The youngest age is above the oldest.");
  return issues;
}

const audienceBody = (a: Audience) => ({
  places: a.places.map((p) => p.id),
  ...(a.placements ? { placements: a.placements } : {}),
  age_min: Number(a.ageMin),
  age_max: Number(a.ageMax),
});

function budgetIssues(budget: string): string[] {
  const amount = Number(budget);
  if (!budget || !Number.isFinite(amount) || amount < 1) return ["Enter a daily budget of at least 1."];
  return amount > 10_000 ? ["A daily budget above 10,000 looks like a typo."] : [];
}

function creativeIssues(c: Creative): string[] {
  const issues: string[] = [];
  if (!c.headline.trim()) issues.push("Write a headline.");
  if (!c.text.trim()) issues.push("Write the ad text.");
  if (!httpsLink(c.link)) issues.push("Enter the link people go to (https://…).");
  if (!httpsLink(c.image)) issues.push("Enter a link to the ad image (https://…).");
  return issues;
}

const creativeBody = (c: Creative) => ({ headline: c.headline.trim(), primary_text: c.text.trim(), link_url: c.link.trim(), image_url: c.image.trim(), cta: c.cta });

const audienceRow = (a: Audience): PreviewRow => ({
  label: "Who sees it",
  value: `People aged ${a.ageMin} to ${a.ageMax}${a.ageMax === "65" ? "+" : ""}${a.places.length ? ` in ${a.places.map((p) => p.name ?? p.id).join(", ")}` : ""}`,
});

const budgetRow = (budget: string, unit: string): PreviewRow => ({
  label: "Budget",
  value: Number(budget) > 0 ? `Up to ${Number(budget).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${unit} a day`.replace("  ", " ") : "Not set yet",
});

export function Placements({ value, onChange, disabled }: { value: MetaPlacement[] | null; onChange: (v: MetaPlacement[] | null) => void; disabled: boolean }) {
  return (
    <fieldset disabled={disabled}>
      <legend className={label}>Where ads show</legend>
      <label className="mt-1.5 flex items-center gap-2 text-[14px] font-medium leading-[22px] text-ink">
        <input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : ["facebook", "instagram"])} />
        Let Meta choose (Advantage+ placements)
      </label>
      {value !== null && (
        <div className="mt-2 flex flex-wrap gap-4">
          {META_PLACEMENTS.map((p) => (
            <label key={p.value} className="flex items-center gap-2 text-[14px] font-medium leading-[22px] text-ink">
              <input type="checkbox" checked={value.includes(p.value)} onChange={(e) => onChange(e.target.checked ? [...value, p.value] : value.filter((v) => v !== p.value))} />
              {p.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function AudienceFields({ value, onChange, disabled }: { value: Audience; onChange: (v: Audience) => void; disabled: boolean }) {
  return (
    <EditorSection title="Target audience">
      <CampaignLocations apiBase={META_API} label="Places to show in" selected={value.places} onChange={(places) => onChange({ ...value, places })} />
      <div className="grid gap-5 md:grid-cols-2">
        <label className={label}>Youngest age<input className={input} type="number" min={18} max={65} value={value.ageMin} onChange={(e) => onChange({ ...value, ageMin: e.target.value })} /></label>
        <label className={label}>Oldest age<input className={input} type="number" min={18} max={65} value={value.ageMax} onChange={(e) => onChange({ ...value, ageMax: e.target.value })} /><span className={hint}>65 means 65 and over.</span></label>
      </div>
      <Placements value={value.placements} onChange={(placements) => onChange({ ...value, placements })} disabled={disabled} />
    </EditorSection>
  );
}

function CreativeFields({ value, onChange }: { value: Creative; onChange: (v: Creative) => void }) {
  return (
    <EditorSection title="The ad">
      <label className={label}>Headline<input className={input} value={value.headline} onChange={(e) => onChange({ ...value, headline: e.target.value })} maxLength={255} /></label>
      <label className={label}>Ad text<textarea className={`${input} min-h-24 py-2`} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} maxLength={2000} /></label>
      <div className="grid gap-5 md:grid-cols-2">
        <label className={label}>Link<input className={input} value={value.link} onChange={(e) => onChange({ ...value, link: e.target.value })} placeholder="https://" /></label>
        <label className={label}>Button<SheetSelect value={value.cta} onChange={(e) => onChange({ ...value, cta: e.target.value })}>{META_CTAS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SheetSelect></label>
      </div>
      <label className={label}>Image link<input className={input} value={value.image} onChange={(e) => onChange({ ...value, image: e.target.value })} placeholder="https://" /><span className={hint}>A public https link to a JPG or PNG. Meta copies it into your ad account.</span></label>
    </EditorSection>
  );
}

const card = (c: Creative) => <AdCard text={c.text} headline={c.headline} link={c.link} image={c.image} button={ctaLabel(c.cta)} />;

export function MetaCampaignForm({ formId, busy, onSubmitState, onSave, state }: CreateFormProps) {
  const built = state !== "open";
  const [name, setName] = useState("");
  const [goal, setGoal] = useState<MetaGoal>("traffic");
  const [event, setEvent] = useState("");
  const [budget, setBudget] = useState("");
  const [end, setEnd] = useState("");
  const [audience, setAudience] = useState(AUDIENCE);
  const [creative, setCreative] = useState(CREATIVE);

  const issues: string[] = [];
  if (name.trim().length < 3) issues.push("Name the campaign (3 characters or more).");
  if (goal === "conversions" && !event) issues.push("Pick the conversion to count.");
  issues.push(...budgetIssues(budget));
  if (end && new Date(end).getTime() <= Date.now()) issues.push("Pick an end date in the future.");
  issues.push(...audienceIssues(audience), ...creativeIssues(creative));
  const reason = state !== "open" ? BUILD_REASON[state] : issues[0] ?? "";
  const disabled = busy || built || issues.length > 0;
  useEffect(() => onSubmitState({ label: "Build paused campaign", disabled, reason }), [disabled, reason, onSubmitState]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    onSave({
      name: name.trim(),
      goal,
      ...(goal === "conversions" ? { conversion_event: event } : {}),
      daily_budget: Number(budget),
      ...(end ? { end_time: toIso(end) } : {}),
      ...audienceBody(audience),
      ...creativeBody(creative),
    });
  }

  const rows: PreviewRow[] = [
    { label: "Goal", value: META_GOALS.find((g) => g.value === goal)?.label ?? "-" },
    audienceRow(audience),
    budgetRow(budget, ""),
    { label: "Runs", value: `When you launch it · ${end ? `until ${new Date(end).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "no end date"}` },
    { label: "Button", value: ctaLabel(creative.cta) },
  ];
  return (
    <CreateColumns slug="meta_ads" card={card(creative)} rows={rows} note="Built paused. Nothing spends until you launch it from the campaign list.">
      <form id={formId} onSubmit={save} className="ads-sheet-form">
        <fieldset disabled={busy || built} className="min-w-0 space-y-8">
          <EditorSection title="Campaign">
            <div>
              <label className={label}>Campaign name<input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></label>
            </div>
            <Segmented legend="Goal" value={goal} onChange={(v) => setGoal(v as MetaGoal)} options={META_GOALS.map((g) => ({ value: g.value, label: g.label }))} />
            <p className={`${hint} !mt-2`}>{META_GOALS.find((g) => g.value === goal)?.hint}</p>
            {goal === "conversions" && (
              <label className={label}>Conversion to count<SheetSelect value={event} onChange={(e) => setEvent(e.target.value)}><option value="">Pick one</option>{META_CONVERSION_EVENTS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</SheetSelect><span className={hint}>Counted by your ad account's Meta pixel.</span></label>
            )}
          </EditorSection>
          <AudienceFields value={audience} onChange={setAudience} disabled={busy || built} />
          <EditorSection title="Budget and dates">
            <div className="grid gap-5 md:grid-cols-2">
              <label className={label}>Daily budget (ad account currency)<input className={input} type="number" min={1} max={10000} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
              <label className={label}>End date (optional)<input className={input} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /><span className={hint}>Your browser's time zone. Blank runs until you pause it.</span></label>
            </div>
          </EditorSection>
          <CreativeFields value={creative} onChange={setCreative} />
          <SheetNote>Saving builds the campaign, its ad set and ad in Meta, with the campaign paused, so nothing spends yet. Launch it from the campaign list when you are ready.</SheetNote>
        </fieldset>
      </form>
    </CreateColumns>
  );
}

export function MetaAdSetForm({ view, formId, busy, onSubmitState, onSave, state }: CreateFormProps & { view: MetaEditorView }) {
  const built = state !== "open";
  const goal = OBJECTIVE_GOAL[view.campaign.objective ?? ""];
  const [name, setName] = useState("");
  const [event, setEvent] = useState("");
  const [budget, setBudget] = useState("");
  const [audience, setAudience] = useState(AUDIENCE);

  const blocked = !view.writes_enabled ? "Zavi can't change Meta campaigns right now."
    : view.campaign.budget_level === "campaign" ? "This campaign holds the budget for all its ad sets, so Meta takes no budget on a new one. Add the ad set in Meta, or build a new campaign here."
    : !goal ? "Zavi adds ad sets to website-visit, reach and sales campaigns only. Add this one in Meta."
    : "";
  const issues: string[] = blocked ? [blocked] : [];
  if (name.trim().length < 3) issues.push("Name the ad set (3 characters or more).");
  if (goal === "conversions" && !event) issues.push("Pick the conversion to count.");
  issues.push(...budgetIssues(budget), ...audienceIssues(audience));
  const reason = createReason(state, "ad set", "Meta", issues);
  const disabled = busy || built || issues.length > 0;
  useEffect(() => onSubmitState({ label: "Create paused ad set", disabled, reason }), [disabled, reason, onSubmitState]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    onSave({ name: name.trim(), ...(goal === "conversions" ? { conversion_event: event } : {}), daily_budget: Number(budget), ...audienceBody(audience) });
  }

  const sample = view.ads[0];
  const rows: PreviewRow[] = [{ label: "Campaign", value: view.campaign.name }, audienceRow(audience), budgetRow(budget, view.currency)];
  return (
    <CreateColumns slug="meta_ads" card={<AdCard text={sample?.primary_text ?? ""} headline={sample?.headline ?? ""} link={sample?.link_url ?? ""} image={sample?.image_url ?? undefined} />} rows={rows} note="Created paused. Nothing spends until the ad set has an ad and is switched on.">
      <form id={formId} onSubmit={save} className="ads-sheet-form">
        <fieldset disabled={busy || built || !!blocked} className="min-w-0 space-y-8">
          <EditorSection title="Ad set">
            <label className={label}>Campaign<input className={input} value={view.campaign.name} readOnly disabled /></label>
            <label className={label}>Ad set name<input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></label>
            {goal === "conversions" && (
              <label className={label}>Conversion to count<SheetSelect value={event} onChange={(e) => setEvent(e.target.value)}><option value="">Pick one</option>{META_CONVERSION_EVENTS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</SheetSelect><span className={hint}>Counted by your ad account's Meta pixel.</span></label>
            )}
          </EditorSection>
          <AudienceFields value={audience} onChange={setAudience} disabled={busy || built || !!blocked} />
          <EditorSection title="Budget">
            <label className={label}>Daily budget in {view.currency}<input className={input} type="number" min={1} max={10000} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
          </EditorSection>
          <SheetNote>Saving creates the ad set in this campaign, paused, so nothing spends yet. Add an ad to it next.</SheetNote>
        </fieldset>
      </form>
    </CreateColumns>
  );
}

export function MetaAdForm({ view, formId, busy, onSubmitState, onSave, state }: CreateFormProps & { view: MetaEditorView }) {
  const built = state !== "open";
  const [setId, setSetId] = useState(view.ad_sets[0]?.id ?? "");
  const [name, setName] = useState("");
  const [creative, setCreative] = useState(CREATIVE);

  const blocked = !view.writes_enabled ? "Zavi can't change Meta campaigns right now."
    : view.ad_sets.length === 0 ? "This campaign has no ad sets yet. Create an ad set first."
    : "";
  const issues: string[] = blocked ? [blocked] : [];
  if (name.trim().length < 3) issues.push("Name the ad (3 characters or more).");
  issues.push(...creativeIssues(creative));
  const reason = createReason(state, "ad", "Meta", issues);
  const disabled = busy || built || issues.length > 0;
  useEffect(() => onSubmitState({ label: "Create ad", disabled, reason }), [disabled, reason, onSubmitState]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    onSave({ ad_set_id: setId, name: name.trim(), ...creativeBody(creative) });
  }

  const rows: PreviewRow[] = [
    { label: "Campaign", value: view.campaign.name },
    { label: "Ad set", value: view.ad_sets.find((s) => s.id === setId)?.name ?? "-" },
    { label: "Button", value: ctaLabel(creative.cta) },
  ];
  return (
    <CreateColumns slug="meta_ads" card={card(creative)} rows={rows} note="The ad runs on its ad set's budget. It adds no budget of its own.">
      <form id={formId} onSubmit={save} className="ads-sheet-form">
        <fieldset disabled={busy || built || !!blocked} className="min-w-0 space-y-8">
          <EditorSection title="Ad">
            <label className={label}>Campaign<input className={input} value={view.campaign.name} readOnly disabled /></label>
            <label className={label}>Ad set<SheetSelect value={setId} onChange={(e) => setSetId(e.target.value)}>{view.ad_sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</SheetSelect></label>
            <label className={label}>Ad name<input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></label>
          </EditorSection>
          <CreativeFields value={creative} onChange={setCreative} />
          <SheetNote>If this ad set and its campaign are on, the ad starts showing once Meta has reviewed it. It spends from the ad set's existing budget.</SheetNote>
        </fieldset>
      </form>
    </CreateColumns>
  );
}
