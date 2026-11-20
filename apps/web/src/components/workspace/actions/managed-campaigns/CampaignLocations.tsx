"use client";
import { useEffect, useRef, useState } from "react";
import { campaignFetch } from "./api";
import { campaignLocationDetail, type CampaignLocation } from "@zavi/shared";
import { SuggestBox } from "./SuggestBox";
type Location = CampaignLocation & { eu?: boolean; includable?: boolean };
export function CampaignLocations({ apiBase, label, selected, onChange, params, placeholder = "Search for a location", includeOnly = false, max }: { includeOnly?: boolean; max?: number; apiBase: string; label: string; selected: Location[]; onChange: (rows: Location[]) => void; params?: Record<string, string | undefined>; placeholder?: string }) {
  const [query, setQuery] = useState(""); const [rows, setRows] = useState<Location[] | null>(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const scope = JSON.stringify(params ?? {});
  useEffect(() => () => { sequence.current++; }, []);
  useEffect(() => {
    const request = ++sequence.current;
    setRows(null); setError(""); setBusy(false);
    if (query.trim().length < 2) return;
    const timer = setTimeout(async () => {
      setBusy(true);
      try { const r = await campaignFetch<{ locations: Location[] }>(`${apiBase}/locations?${new URLSearchParams({ q: query.trim(), ...Object.fromEntries(Object.entries(params ?? {}).filter((e): e is [string, string] => !!e[1])) })}`); if (request === sequence.current) setRows(r.locations ?? []); }
      catch (e) { if (request === sequence.current) setError(e instanceof Error ? e.message : "Location search failed."); }
      finally { if (request === sequence.current) setBusy(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, apiBase, scope]);
  const blocked = (r: Location) => includeOnly && r.includable === false;
  const full = max !== undefined && selected.length >= max;
  const fullNote = max === undefined ? "" : selected.length > max ? `This list has ${selected.length} places, and a campaign can take up to ${max}. Remove ${selected.length - max} to continue.` : `A campaign can take up to ${max} places here. Remove one to add another.`;
  const items = rows && rows.map(r => { const on = selected.some(v => v.id === r.id); return { key: r.id, label: r.name ?? r.id, detail: campaignLocationDetail(r) || undefined, selected: on, disabled: blocked(r) || (full && !on), note: blocked(r) ? (r.eu ? "EU and EEA places can only be excluded for now." : "This place does not name its country, so it can only be excluded for now.") : full && !on ? fullNote : undefined }; });
  function toggle(id: string) {
    if (selected.some(v => v.id === id)) return onChange(selected.filter(v => v.id !== id));
    const r = rows?.find(v => v.id === id);
    if (!r || blocked(r) || full) return;
    const { eu: _eu, includable: _includable, ...place } = r;
    onChange([...selected, place]);
  }
  return <fieldset className="min-w-0"><legend className="text-[14px] font-medium leading-5 tracking-[0.14px] text-inkSoft">{label}</legend><SuggestBox label={`${label} search`} placeholder={placeholder} query={query} onQuery={setQuery} items={items} busy={busy} error={error} empty="No matching places. Try another spelling." onPick={toggle} />{selected.length > 0 && <ul className="flex flex-wrap gap-2 pt-2">{selected.map(r => <li key={r.id} className="inline-flex min-h-8 items-center gap-2 rounded-2xl border border-rule bg-cream pl-4 pr-2.5 text-[13px] font-semibold leading-5 text-inkSoft"><span>{r.name ?? r.id}{campaignLocationDetail(r) && <span className="block text-[12px] font-normal">{campaignLocationDetail(r)}</span>}</span><button type="button" aria-label={`Remove ${r.name ?? r.id}${campaignLocationDetail(r) ? ` (${campaignLocationDetail(r)})` : ""}`} className="relative size-4 shrink-0" onClick={() => onChange(selected.filter(v => v.id !== r.id))}><span aria-hidden className="absolute inset-[17.71%] bg-current [mask:url(/icons/ads-sheet/cancel.svg)_center/contain_no-repeat]" /></button></li>)}</ul>}{full && <p className="pt-2 text-[12px] leading-4 text-inkSoft">{fullNote}</p>}</fieldset>;
}
