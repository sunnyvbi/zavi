"use client";
import { useEffect, useState } from "react";
import type { CampaignDraft } from "@zavi/shared";
import { SheetNote, SheetSelect, sheetHint as hint, sheetInput as input, sheetLabel as label } from "../AdsSheet";
import { CampaignLocations } from "../CampaignLocations";
import { EditorSection, Segmented } from "../CampaignEditorParts";
import type { PreviewRow } from "../CampaignPreview";
import { CreateColumns, createReason, httpsLink, type CreateFormProps } from "../CreateSheet";
import type { NewCampaignState } from "../editorSave";
import { GOOGLE_GOALS, MATCH_TYPES, editorApi, type GoogleEditorView, type GoogleGoal, type MatchType } from "./googleEditorApi";

type Place = { id: string; name?: string };
type SearchAd = { link: string; headlines: string; descriptions: string; path1: string; path2: string };
type Keywords = { text: string; match: MatchType };
type PreviewAd = CampaignDraft["ads"][number];

const SEARCH_AD: SearchAd = { link: "", headlines: "", descriptions: "", path1: "", path2: "" };
const KEYWORDS: Keywords = { text: "", match: "PHRASE" };
const CREATE_REASON: Record<Exclude<NewCampaignState, "open">, string> = {
  done: "Created. It stays paused until you launch it from the campaign list.",
  sending: "Creating it in Google Ads. It shows in the campaign list once Google has it.",
  waiting: "It is waiting in Approvals. Approve it there to create it.",
};
const YOUTUBE_LINK = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{11}|^[A-Za-z0-9_-]{11}$/;

export const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
export const todayYmd = () => new Date().toISOString().slice(0, 10);
const usd = (value: string) => (Number(value) > 0 ? `Up to $${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })} a day` : "Not set yet");
const placeNames = (places: Place[]) => (places.length ? places.map((p) => p.name ?? p.id).join(", ") : "No places picked yet");
const runsUntil = (end: string) => `When you launch it · ${end ? `until ${end}` : "no end date"}`;

function budgetIssues(budget: string): string[] {
  const amount = Number(budget);
  if (!budget || !Number.isFinite(amount) || amount < 1) return ["Enter a daily budget of at least $1."];
  return amount > 10_000 ? ["A daily budget above $10,000 looks like a typo."] : [];
}

function searchAdIssues(a: SearchAd): string[] {
  const hl = lines(a.headlines);
  const ds = lines(a.descriptions);
  const issues: string[] = [];
  if (!/^https?:\/\/\S+\.\S+/.test(a.link.trim())) issues.push("Enter the page people land on (https://…).");
  if (hl.length < 3) issues.push("Write at least 3 headlines, one per line.");
  else if (hl.length > 15) issues.push("Google takes up to 15 headlines.");
  else if (hl.some((h) => h.length > 30)) issues.push("Keep each headline to 30 characters.");
  if (ds.length < 2) issues.push("Write at least 2 descriptions, one per line.");
  else if (ds.length > 4) issues.push("Google takes up to 4 descriptions.");
  else if (ds.some((d) => d.length > 90)) issues.push("Keep each description to 90 characters.");
  return issues;
}

const searchAdBody = (a: SearchAd) => ({
  final_url: a.link.trim(),
  headlines: lines(a.headlines),
  descriptions: lines(a.descriptions),
  ...(a.path1.trim() ? { path1: a.path1.trim() } : {}),
  ...(a.path2.trim() ? { path2: a.path2.trim() } : {}),
});

function keywordIssues(k: Keywords): string[] {
  const kw = lines(k.text);
  if (kw.length === 0) return ["Add at least one keyword, one per line."];
  return kw.some((w) => w.length > 80) ? ["Keep each keyword to 80 characters."] : [];
}

const keywordsBody = (k: Keywords) => lines(k.text).map((text) => ({ text, match_type: k.match }));

function previewAd(headlines: string, descriptions: string, link: string): PreviewAd | undefined {
  const hl = lines(headlines);
  if (hl.length === 0) return undefined;
  return { name: "", title: hl.slice(0, 3).join(" | "), body: lines(descriptions)[0] ?? "", target_url: link.trim(), tracking: "" };
}

export function MatchSelect({ value, onChange }: { value: MatchType; onChange: (v: MatchType) => void }) {
  return (
    <SheetSelect value={value} onChange={(e) => onChange(e.target.value as MatchType)}>
      {MATCH_TYPES.map((m) => <option key={m.value} value={m.value}>{m.label} match</option>)}
    </SheetSelect>
  );
}

function KeywordFields({ value, onChange }: { value: Keywords; onChange: (v: Keywords) => void }) {
  return (
    <EditorSection title="Keywords">
      <div className="grid gap-5 md:grid-cols-[1fr_200px]">
        <label className={label}>Searches to show for<textarea className={`${input} min-h-24 py-2`} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder="one per line" /></label>
        <label className={label}>Match<MatchSelect value={value.match} onChange={(match) => onChange({ ...value, match })} /></label>
      </div>
    </EditorSection>
  );
}

function SearchAdFields({ value, onChange }: { value: SearchAd; onChange: (v: SearchAd) => void }) {
  return (
    <EditorSection title="The ad">
      <label className={label}>Landing page<input className={input} value={value.link} onChange={(e) => onChange({ ...value, link: e.target.value })} placeholder="https://" /></label>
      <label className={label}>Headlines<textarea className={`${input} min-h-28 py-2`} value={value.headlines} onChange={(e) => onChange({ ...value, headlines: e.target.value })} placeholder="one per line, 3 to 15" /><span className={hint}>Up to 30 characters each. Google mixes them.</span></label>
      <label className={label}>Descriptions<textarea className={`${input} min-h-24 py-2`} value={value.descriptions} onChange={(e) => onChange({ ...value, descriptions: e.target.value })} placeholder="one per line, 2 to 4" /><span className={hint}>Up to 90 characters each.</span></label>
      <div className="grid gap-5 md:grid-cols-2">
        <label className={label}>Display path 1 (optional)<input className={input} value={value.path1} onChange={(e) => onChange({ ...value, path1: e.target.value })} maxLength={15} /></label>
        <label className={label}>Display path 2 (optional)<input className={input} value={value.path2} onChange={(e) => onChange({ ...value, path2: e.target.value })} maxLength={15} /></label>
      </div>
    </EditorSection>
  );
}

export function GoogleCampaignForm({ formId, busy, onSubmitState, onSave, state }: CreateFormProps) {
  const built = state !== "open";
  const [name, setName] = useState("");
  const [goal, setGoal] = useState<GoogleGoal>("clicks");
  const [bidCap, setBidCap] = useState("");
  const [budget, setBudget] = useState("");
  const [end, setEnd] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [partners, setPartners] = useState(false);
  const [keywords, setKeywords] = useState(KEYWORDS);
  const [ad, setAd] = useState(SEARCH_AD);

  const cap = bidCap.trim() === "" ? null : Number(bidCap);
  const issues: string[] = [];
  if (name.trim().length < 3) issues.push("Name the campaign (3 characters or more).");
  issues.push(...budgetIssues(budget));
  if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) issues.push(goal === "clicks" ? "Enter a max cost per click above 0, or leave it blank." : "Enter a target cost per conversion above 0, or leave it blank.");
  if (end && end < todayYmd()) issues.push("Pick an end date that is today or later.");
  if (places.length === 0) issues.push("Pick at least one place to show in.");
  issues.push(...keywordIssues(keywords), ...searchAdIssues(ad));
  const reason = state !== "open" ? CREATE_REASON[state] : issues[0] ?? "";
  const disabled = busy || built || issues.length > 0;
  useEffect(() => onSubmitState({ label: "Create paused campaign", disabled, reason }), [disabled, reason, onSubmitState]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    onSave({
      name: name.trim(),
      goal,
      daily_budget: Number(budget),
      ...(cap !== null ? (goal === "clicks" ? { max_cpc_usd: cap } : { target_cpa_usd: cap }) : {}),
      places: places.map((p) => p.id),
      ...(end ? { end_date: end } : {}),
      search_partners: partners,
      keywords: keywordsBody(keywords),
      ...searchAdBody(ad),
    });
  }

  const rows: PreviewRow[] = [
    { label: "Goal", value: GOOGLE_GOALS.find((g) => g.value === goal)?.label ?? "-" },
    { label: "Who sees it", value: placeNames(places) },
    { label: "Budget", value: usd(budget) },
    { label: "Runs", value: runsUntil(end) },
  ];
  return (
    <CreateColumns slug="google_ads" ad={previewAd(ad.headlines, ad.descriptions, ad.link)} rows={rows} note="Created paused. Nothing spends until you launch it from the campaign list.">
      <form id={formId} onSubmit={save} className="ads-sheet-form">
        <fieldset disabled={busy || built} className="min-w-0 space-y-8">
          <EditorSection title="Campaign">
            <label className={label}>Campaign name<input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} /></label>
            <Segmented legend="Goal" value={goal} onChange={(v) => setGoal(v as GoogleGoal)} options={GOOGLE_GOALS.map((g) => ({ value: g.value, label: g.label }))} />
            <p className={`${hint} !mt-2`}>{GOOGLE_GOALS.find((g) => g.value === goal)?.hint}</p>
            <label className={label}>{goal === "clicks" ? "Max cost per click (optional)" : "Target cost per conversion (optional)"}<input className={input} type="number" min={0.01} step="0.01" value={bidCap} onChange={(e) => setBidCap(e.target.value)} placeholder="Let Google decide" /></label>
          </EditorSection>
          <EditorSection title="Target audience">
            <CampaignLocations apiBase={editorApi("google_ads")} label="Places to show in" selected={places} onChange={setPlaces} />
            <label className="flex items-center gap-2 text-[14px] font-medium leading-[22px] text-ink">
              <input type="checkbox" checked={partners} onChange={(e) => setPartners(e.target.checked)} />
              Also show on Google search partners
            </label>
          </EditorSection>
          <EditorSection title="Budget and dates">
            <div className="grid gap-5 md:grid-cols-2">
              <label className={label}>Daily budget (USD)<input className={input} type="number" min={1} max={10000} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
              <label className={label}>Last day (optional)<input className={input} type="date" min={todayYmd()} value={end} onChange={(e) => setEnd(e.target.value)} /><span className={hint}>Blank runs until you pause it.</span></label>
            </div>
          </EditorSection>
          <KeywordFields value={keywords} onChange={setKeywords} />
          <SearchAdFields value={ad} onChange={setAd} />
          <SheetNote>Saving creates the Search campaign, its ad group, keywords and ad in Google Ads, with the campaign paused, so nothing spends yet. Launch it from the campaign list when you are ready.</SheetNote>
        </fieldset>
      </form>
    </CreateColumns>
  );
}

export function YoutubeCampaignForm({ formId, busy, onSubmitState, onSave, state }: CreateFormProps) {
  const built = state !== "open";
  const [name, setName] = useState("");
  const [budget, setBudget] = useState("");
  const [cpa, setCpa] = useState("");
  const [end, setEnd] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [videos, setVideos] = useState("");
  const [link, setLink] = useState("");
  const [headlines, setHeadlines] = useState("");
  const [longHeadlines, setLongHeadlines] = useState("");
  const [descriptions, setDescriptions] = useState("");
  const [business, setBusiness] = useState("");
  const [logo, setLogo] = useState("");

  const vids = lines(videos);
  const hl = lines(headlines);
  const lh = lines(longHeadlines);
  const ds = lines(descriptions);
  const target = cpa.trim() === "" ? null : Number(cpa);
  const issues: string[] = [];
  if (name.trim().length < 3) issues.push("Name the campaign (3 characters or more).");
  issues.push(...budgetIssues(budget));
  if (target !== null && (!Number.isFinite(target) || target <= 0)) issues.push("Enter a target cost per conversion above 0, or leave it blank.");
  if (end && end < todayYmd()) issues.push("Pick an end date that is today or later.");
  if (places.length === 0) issues.push("Pick at least one place to show in.");
  if (vids.length === 0) issues.push("Add a YouTube video link.");
  else if (vids.length > 5) issues.push("Add up to 5 videos.");
  else if (vids.some((v) => !YOUTUBE_LINK.test(v))) issues.push("Each video must be a YouTube link: youtube.com/watch?v=…, youtu.be/… or youtube.com/shorts/….");
  if (!httpsLink(link)) issues.push("Enter the page people land on (https://…).");
  if (hl.length < 1 || hl.length > 5) issues.push("Write 1 to 5 headlines, one per line.");
  else if (hl.some((h) => h.length > 40)) issues.push("Keep each headline to 40 characters.");
  if (lh.length < 1 || lh.length > 5) issues.push("Write 1 to 5 long headlines, one per line.");
  else if (lh.some((h) => h.length > 90)) issues.push("Keep each long headline to 90 characters.");
  if (ds.length < 1 || ds.length > 5) issues.push("Write 1 to 5 descriptions, one per line.");
  else if (ds.some((d) => d.length > 90)) issues.push("Keep each description to 90 characters.");
  if (!business.trim()) issues.push("Enter your business name.");
  if (!httpsLink(logo)) issues.push("Enter a link to your logo (https://…).");
  const reason = state !== "open" ? CREATE_REASON[state] : issues[0] ?? "";
  const disabled = busy || built || issues.length > 0;
  useEffect(() => onSubmitState({ label: "Create paused campaign", disabled, reason }), [disabled, reason, onSubmitState]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    onSave({
      name: name.trim(),
      daily_budget: Number(budget),
      ...(target !== null ? { target_cpa_usd: target } : {}),
      places: places.map((p) => p.id),
      ...(end ? { end_date: end } : {}),
      videos: vids,
      final_url: link.trim(),
      headlines: hl,
      long_headlines: lh,
      descriptions: ds,
      business_name: business.trim(),
      logo_url: logo.trim(),
    });
  }

  const rows: PreviewRow[] = [
    { label: "Who sees it", value: placeNames(places) },
    { label: "Budget", value: usd(budget) },
    { label: "Runs", value: runsUntil(end) },
    { label: "Videos", value: vids.length ? String(vids.length) : "None yet" },
  ];
  return (
    <CreateColumns slug="youtube_ads" ad={previewAd(headlines, descriptions, link)} rows={rows} note="Created paused. Nothing spends until you launch it from the campaign list.">
      <form id={formId} onSubmit={save} className="ads-sheet-form">
        <fieldset disabled={busy || built} className="min-w-0 space-y-8">
          <EditorSection title="Campaign">
            <label className={label}>Campaign name<input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} /></label>
          </EditorSection>
          <EditorSection title="Target audience">
            <CampaignLocations apiBase={editorApi("youtube_ads")} label="Places to show in" selected={places} onChange={setPlaces} />
          </EditorSection>
          <EditorSection title="Budget and dates">
            <div className="grid gap-5 md:grid-cols-2">
              <label className={label}>Daily budget (USD)<input className={input} type="number" min={1} max={10000} step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
              <label className={label}>Target cost per conversion (optional)<input className={input} type="number" min={0.01} step="0.01" value={cpa} onChange={(e) => setCpa(e.target.value)} placeholder="Let Google decide" /><span className={hint}>Google bids for conversions (Maximize conversions).</span></label>
            </div>
            <label className={label}>Last day (optional)<input className={input} type="date" min={todayYmd()} value={end} onChange={(e) => setEnd(e.target.value)} /><span className={hint}>Blank runs until you pause it.</span></label>
          </EditorSection>
          <EditorSection title="The ad">
            <label className={label}>YouTube videos<textarea className={`${input} min-h-20 py-2`} value={videos} onChange={(e) => setVideos(e.target.value)} placeholder="one link per line, up to 5" /><span className={hint}>Public or unlisted videos on YouTube.</span></label>
            <label className={label}>Landing page<input className={input} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" /></label>
            <label className={label}>Headlines<textarea className={`${input} min-h-20 py-2`} value={headlines} onChange={(e) => setHeadlines(e.target.value)} placeholder="one per line, 1 to 5" /><span className={hint}>Up to 40 characters each.</span></label>
            <label className={label}>Long headlines<textarea className={`${input} min-h-20 py-2`} value={longHeadlines} onChange={(e) => setLongHeadlines(e.target.value)} placeholder="one per line, 1 to 5" /><span className={hint}>Up to 90 characters each.</span></label>
            <label className={label}>Descriptions<textarea className={`${input} min-h-20 py-2`} value={descriptions} onChange={(e) => setDescriptions(e.target.value)} placeholder="one per line, 1 to 5" /><span className={hint}>Up to 90 characters each.</span></label>
            <div className="grid gap-5 md:grid-cols-2">
              <label className={label}>Business name<input className={input} value={business} onChange={(e) => setBusiness(e.target.value)} maxLength={25} /></label>
              <label className={label}>Logo link<input className={input} value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://" /><span className={hint}>A square PNG or JPG, at least 128×128.</span></label>
            </div>
          </EditorSection>
          <SheetNote>This runs as a Demand Gen campaign, which shows on YouTube (in-stream, in-feed and Shorts), Discover and Gmail. Google checks it before anything is saved. Saving creates it paused, so nothing spends yet. Launch it from the campaign list when you are ready.</SheetNote>
        </fieldset>
      </form>
    </CreateColumns>
  );
}

const SEARCH_ONLY = "Zavi adds ad groups and ads to Search campaigns only. Add this one in Google Ads.";

export function GoogleAdGroupForm({ view, formId, busy, onSubmitState, onSave, state }: CreateFormProps & { view: GoogleEditorView }) {
  const built = state !== "open";
  const [name, setName] = useState("");
  const [cpc, setCpc] = useState("");
  const [keywords, setKeywords] = useState(KEYWORDS);
  const [ad, setAd] = useState(SEARCH_AD);

  const bid = cpc.trim() === "" ? null : Number(cpc);
  const blocked = !view.writes_enabled ? "Zavi can't change Google Ads campaigns right now." : view.campaign.channel_type !== "SEARCH" ? SEARCH_ONLY : "";
  const issues: string[] = blocked ? [blocked] : [];
  if (name.trim().length < 3) issues.push("Name the ad group (3 characters or more).");
  else if (view.ad_groups.some((g) => g.name.trim().toLowerCase() === name.trim().toLowerCase())) issues.push("This campaign already has an ad group with that name.");
  if (bid !== null && (!Number.isFinite(bid) || bid <= 0)) issues.push("Enter a max cost per click above 0, or leave it blank.");
  issues.push(...keywordIssues(keywords), ...searchAdIssues(ad));
  const reason = createReason(state, "ad group", "Google Ads", issues);
  const disabled = busy || built || issues.length > 0;
  useEffect(() => onSubmitState({ label: "Create paused ad group", disabled, reason }), [disabled, reason, onSubmitState]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    onSave({ name: name.trim(), ...(bid !== null ? { max_cpc_usd: bid } : {}), keywords: keywordsBody(keywords), ...searchAdBody(ad) });
  }

  const rows: PreviewRow[] = [
    { label: "Campaign", value: view.campaign.name },
    { label: "Keywords", value: String(lines(keywords.text).length) },
    { label: "Bid", value: bid !== null && bid > 0 ? `Up to $${bid} a click` : "Set by the campaign" },
  ];
  return (
    <CreateColumns slug="google_ads" ad={previewAd(ad.headlines, ad.descriptions, ad.link)} rows={rows} note="Created paused. It spends from the campaign's budget once it is switched on.">
      <form id={formId} onSubmit={save} className="ads-sheet-form">
        <fieldset disabled={busy || built || !!blocked} className="min-w-0 space-y-8">
          <EditorSection title="Ad group">
            <label className={label}>Campaign<input className={input} value={view.campaign.name} readOnly disabled /></label>
            <label className={label}>Ad group name<input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={255} /></label>
            <label className={label}>Max cost per click (optional)<input className={input} type="number" min={0.01} step="0.01" value={cpc} onChange={(e) => setCpc(e.target.value)} placeholder="Set by the campaign" /></label>
          </EditorSection>
          <KeywordFields value={keywords} onChange={setKeywords} />
          <SearchAdFields value={ad} onChange={setAd} />
          <SheetNote>Saving creates the ad group, its keywords and ad in this campaign, paused, so it shows nothing yet. It has no budget of its own: it shares the campaign's.</SheetNote>
        </fieldset>
      </form>
    </CreateColumns>
  );
}

export function GoogleAdForm({ view, formId, busy, onSubmitState, onSave, state }: CreateFormProps & { view: GoogleEditorView }) {
  const built = state !== "open";
  const groups = view.ad_groups.filter((g) => g.type === "SEARCH_STANDARD");
  const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
  const [ad, setAd] = useState(SEARCH_AD);

  const blocked = !view.writes_enabled ? "Zavi can't change Google Ads campaigns right now."
    : view.campaign.channel_type !== "SEARCH" ? SEARCH_ONLY
    : groups.length === 0 ? "This campaign has no Search ad groups yet. Create an ad group first."
    : "";
  const issues: string[] = blocked ? [blocked] : [];
  issues.push(...searchAdIssues(ad));
  const reason = createReason(state, "ad", "Google Ads", issues);
  const disabled = busy || built || issues.length > 0;
  useEffect(() => onSubmitState({ label: "Create paused ad", disabled, reason }), [disabled, reason, onSubmitState]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return;
    onSave({ ad_group_id: groupId, ...searchAdBody(ad) });
  }

  const rows: PreviewRow[] = [
    { label: "Campaign", value: view.campaign.name },
    { label: "Ad group", value: groups.find((g) => g.id === groupId)?.name ?? "-" },
  ];
  return (
    <CreateColumns slug="google_ads" ad={previewAd(ad.headlines, ad.descriptions, ad.link)} rows={rows} note="Created paused. It adds no budget: it runs in its ad group once switched on.">
      <form id={formId} onSubmit={save} className="ads-sheet-form">
        <fieldset disabled={busy || built || !!blocked} className="min-w-0 space-y-8">
          <EditorSection title="Ad">
            <label className={label}>Campaign<input className={input} value={view.campaign.name} readOnly disabled /></label>
            <label className={label}>Ad group<SheetSelect value={groupId} onChange={(e) => setGroupId(e.target.value)}>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</SheetSelect></label>
          </EditorSection>
          <SearchAdFields value={ad} onChange={setAd} />
          <SheetNote>Saving creates a responsive search ad in this ad group, paused. Google reviews it before it can show.</SheetNote>
        </fieldset>
      </form>
    </CreateColumns>
  );
}
