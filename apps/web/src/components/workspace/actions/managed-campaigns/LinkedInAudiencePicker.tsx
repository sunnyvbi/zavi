"use client";
import { useEffect, useRef, useState } from "react";
import { LINKEDIN_AUDIENCE_FACETS, LINKEDIN_AUDIENCE_LABELS, type LinkedInAudienceFacet, type LinkedInAudienceOption, type LinkedInAudienceSuggestions } from "@zavi/shared";
import { Check } from "lucide-react";
import { campaignFetch } from "./api";
import { sheetHint, sheetLabel } from "./AdsSheet";
import { AdsChipsSkeleton } from "./AdsLoading";
import { SuggestBox, type SuggestItem } from "./SuggestBox";

export type AudienceChoices = Record<LinkedInAudienceFacet, LinkedInAudienceOption[]>;
export const emptyAudienceChoices = (): AudienceChoices => ({ titles: [], seniorities: [], industries: [], staffCountRanges: [] });

type OptionCache = Map<string, LinkedInAudienceOption[]>;

const optionCache: OptionCache = new Map();
export const forgetLinkedInAudienceOptions = () => optionCache.clear();

const isTypeahead = (facet: LinkedInAudienceFacet) => facet === "titles" || facet === "industries";
const optionsKey = (base: string, accountId: string, bindingId: string | undefined, facet: LinkedInAudienceFacet, query: string) => {
  const params = new URLSearchParams({ account_id: accountId, facet, query });
  if (bindingId) params.set("account_binding_id", bindingId);
  return { key: `${base}?${params}`, params };
};

async function fetchAudienceOptions(base: string, accountId: string, bindingId: string | undefined, facet: LinkedInAudienceFacet, query: string): Promise<LinkedInAudienceOption[]> {
  const { key, params } = optionsKey(base, accountId, bindingId, facet, query);
  const known = optionCache.get(key);
  if (known) return known;
  const result = await campaignFetch<{ options: LinkedInAudienceOption[] }>(`${base}/targeting?${params}`);
  const options = result.options ?? [];
  if (options.length) optionCache.set(key, options);
  return options;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const pickSuggested = (term: string, options: LinkedInAudienceOption[], loose: boolean) =>
  options.find(o => sameName(o.name, term))
  ?? options.find(o => o.name.toLowerCase().includes(term.trim().toLowerCase()) || term.toLowerCase().includes(o.name.trim().toLowerCase()))
  ?? (loose ? options[0] : undefined);

export async function resolveAudienceSuggestions(base: string, accountId: string, bindingId: string | undefined, suggestions: LinkedInAudienceSuggestions | undefined): Promise<AudienceChoices> {
  const chosen = emptyAudienceChoices();
  if (!suggestions) return chosen;
  await Promise.all(LINKEDIN_AUDIENCE_FACETS.map(async facet => {
    const terms = [...new Set((suggestions[facet] ?? []).map(t => t.trim()).filter(Boolean))];
    if (!terms.length) return;
    const found = isTypeahead(facet)
      ? await Promise.all(terms.map(term => fetchAudienceOptions(base, accountId, bindingId, facet, term).then(o => pickSuggested(term, o, true), () => undefined)))
      : await fetchAudienceOptions(base, accountId, bindingId, facet, "").then(o => terms.map(term => pickSuggested(term, o, false)), () => []);
    const seen = new Set<string>();
    chosen[facet] = found.filter((o): o is LinkedInAudienceOption => !!o && !seen.has(o.urn) && !!seen.add(o.urn)).slice(0, 20);
  }));
  if (chosen.titles.length) chosen.seniorities = [];
  return chosen;
}

function FacetPicker({ facet, base, accountId, bindingId, selected, suggestions, disabled, cache, onChange }: {
  facet: LinkedInAudienceFacet; base: string; accountId: string; bindingId?: string; cache: OptionCache;
  selected: LinkedInAudienceOption[]; suggestions: string[]; disabled: boolean;
  onChange: (options: LinkedInAudienceOption[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<LinkedInAudienceOption[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [openRequest, setOpenRequest] = useState(0);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);
  const typeahead = facet === "titles" || facet === "industries";
  const label = LINKEDIN_AUDIENCE_LABELS[facet];
  async function search(term: string) {
    const request = ++sequence.current;
    const { key } = optionsKey(base, accountId, bindingId, facet, typeahead ? term.trim() : "");
    const known = cache.get(key);
    if (known) { setError(""); setBusy(false); setOptions(known); return; }
    setBusy(true); setError(""); setOptions(null);
    try {
      const options = await fetchAudienceOptions(base, accountId, bindingId, facet, typeahead ? term.trim() : "");
      if (request === sequence.current) setOptions(options);
    } catch (e) {
      if (request === sequence.current) setError(e instanceof Error ? e.message : "LinkedIn audience search failed.");
    } finally { if (request === sequence.current) setBusy(false); }
  }
  useEffect(() => {
    if (!typeahead || query.trim().length < 2) return;
    const timer = setTimeout(() => void search(query), 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => { if (!typeahead) void search(""); }, []);
  const full = selected.length >= 20;
  function toggle(option: LinkedInAudienceOption) {
    onChange(selected.some(v => v.urn === option.urn) ? selected.filter(v => v.urn !== option.urn) : [...selected, option]);
  }
  const chips = selected.length > 0 && <ul className="flex flex-wrap gap-2 pt-2">{selected.map(o => <li key={o.urn} className="inline-flex min-h-8 items-center gap-2 rounded-2xl border border-rule bg-cream pl-4 pr-2.5 text-[13px] font-semibold leading-5 text-inkSoft">
    <span>{o.name}</span>
    <button type="button" aria-label={`Remove ${o.name}`} className="relative size-4 shrink-0" onClick={() => onChange(selected.filter(v => v.urn !== o.urn))}><span aria-hidden className="absolute inset-[17.71%] bg-current [mask:url(/icons/ads-sheet/cancel.svg)_center/contain_no-repeat]" /></button>
  </li>)}</ul>;
  if (!typeahead) return <fieldset disabled={disabled} className="min-w-0 disabled:opacity-60">
    <legend className={sheetLabel}>{label}</legend>
    {suggestions.length > 0 && <p className={sheetHint}>Zavi suggested {suggestions.join(", ")}</p>}
    {error ? <p role="alert" className="mt-2 text-[13px] font-medium text-danger">{error} <button type="button" className="font-semibold text-ink underline underline-offset-2" onClick={() => void search("")}>Try again</button></p>
      : options === null ? <AdsChipsSkeleton label="Loading options…" />
      : options.length === 0 ? <p className={sheetHint}>LinkedIn offers no options here. <button type="button" className="font-semibold text-ink underline underline-offset-2" onClick={() => void search("")}>Try again</button></p>
      : <div role="group" aria-label={`${label} options`} className="flex flex-wrap gap-2 pt-2">{options.map(o => {
        const on = selected.some(v => v.urn === o.urn);
        return <button key={o.urn} type="button" aria-pressed={on} disabled={!on && full} onClick={() => toggle(o)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-2xl border px-3.5 text-[13px] font-semibold leading-5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${on ? "border-ink bg-ink text-cream" : "border-rule bg-cream text-inkSoft hover:border-inkMuted"}`}>
          {on && <Check aria-hidden className="size-3.5" strokeWidth={3} />}{o.name}
        </button>;
      })}</div>}
  </fieldset>;
  const items: SuggestItem[] | null = options && options.map(o => {
    const on = selected.some(v => v.urn === o.urn);
    return { key: o.urn, label: o.name, selected: on, disabled: !on && full, note: !on && full ? "Up to 20 per category." : undefined };
  });
  return <fieldset disabled={disabled} className="min-w-0">
    <legend className={sheetLabel}>{label}</legend>
    <SuggestBox label={label} disabled={disabled} query={query} items={items} busy={busy} error={error}
      placeholder={facet === "titles" ? "Type a job title, e.g. Founder" : "Type an industry, e.g. Software"}
      empty="No matching LinkedIn options. Try another word."
      hint="Type at least 2 letters to see LinkedIn suggestions."
      onQuery={next => { sequence.current++; setOptions(null); setBusy(false); setError(""); setQuery(next); }}
      onPick={urn => { const o = options?.find(v => v.urn === urn); if (o) toggle(o); }} openRequest={openRequest} />
    {suggestions.length > 0 && <p className={sheetHint}>Zavi suggested: {suggestions.map((term, i) => <span key={term}>{i > 0 && ", "}<button type="button" className="font-semibold text-ink underline underline-offset-2" onClick={() => { if (term !== query) { sequence.current++; setOptions(null); setError(""); setQuery(term); } setOpenRequest(n => n + 1); }}>{term}</button></span>)}</p>}
    {chips}
  </fieldset>;
}

export function LinkedInAudiencePicker({ base, accountId, bindingId, value, suggestions, disabled, onChange }: {
  base: string; accountId: string; bindingId?: string; value: AudienceChoices;
  suggestions?: LinkedInAudienceSuggestions; disabled: boolean; onChange: (value: AudienceChoices) => void;
}) {
  return <section className="space-y-5" aria-label="Professional audience">
    <p className={sheetHint}>Choose job titles or seniority; LinkedIn does not allow both together. Matches within each category use “or”; selected categories must all match.</p>
    {LINKEDIN_AUDIENCE_FACETS.map(facet => <FacetPicker key={`${base}:${accountId}:${bindingId ?? ""}:${facet}`} facet={facet} base={base} accountId={accountId} bindingId={bindingId} selected={value[facet]} suggestions={suggestions?.[facet] ?? []} cache={optionCache}
      disabled={disabled || (facet === "titles" && value.seniorities.length > 0) || (facet === "seniorities" && value.titles.length > 0)} onChange={options => onChange({ ...value, [facet]: options })} />)}
  </section>;
}
