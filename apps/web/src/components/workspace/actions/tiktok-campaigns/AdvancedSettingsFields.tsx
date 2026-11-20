import { useId, useState } from "react";
import { SheetSelect, sheetHint as hint, sheetInput as input, sheetLabel as label } from "../managed-campaigns/AdsSheet";
import { DaypartingFields } from "./DaypartingFields";
import { ADVANCED_GROUP_FIELDS as advancedFields, words, type TiktokCampaignOptions, type TiktokSettings } from "./types";

type Choice = { id: string; name: string };
function CatalogField({ title, values, choices, error, disabled, onChange }: { title: string; values: string[]; choices?: Choice[]; error?: boolean; disabled: boolean; onChange: (v: string[]) => void }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const filtered = (choices ?? []).filter(c => !values.includes(c.id) && `${c.name} ${c.id}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="space-y-2">
    <label htmlFor={id} className={label}>{title}</label>
    <div className="flex flex-wrap gap-2">{values.map(value => <button key={value} type="button" className="rounded-full border border-rule px-3 py-1 text-sm" disabled={disabled} onClick={() => onChange(values.filter(v => v !== value))} aria-label={`Remove ${title.toLowerCase()}: ${choices?.find(c => c.id === value)?.name ?? value}`}>{choices?.find(c => c.id === value)?.name ?? `ID ${value}`} ×</button>)}</div>
    <input className={input} aria-label={`Search ${title.toLowerCase()}`} placeholder="Search by name or ID" value={search} disabled={disabled || !choices?.length} onChange={e => setSearch(e.target.value)} />
    <SheetSelect id={id} value="" disabled={disabled || !filtered.length} onChange={e => { if (e.target.value) onChange([...values, e.target.value]); }}><option value="">Choose an option</option>{filtered.map(c => <option key={c.id} value={c.id}>{c.name} · {c.id}</option>)}</SheetSelect>
    {error && <p role="status" className={hint}>Choices could not be loaded. Existing selections are preserved.</p>}
    {!error && choices?.length === 0 && <p className={hint}>No choices are available for this ad account.</p>}
    <p className={hint}>An empty selection applies no restriction for this field when saved.</p>
  </div>;
}

export function AdvancedSettingsFields({ value, onChange, options, editableFields, disabled, currency, timezone }: {
  value: TiktokSettings; onChange: (patch: Partial<TiktokSettings>) => void; options: TiktokCampaignOptions | null; editableFields?: string[]; disabled: boolean; currency: string | null; timezone: string | null;
}) {
  const osId = useId();
  const editable = (field: string) => !!editableFields?.includes(field);
  const visible = (field: typeof advancedFields[number]) => editable(field) || value[field] != null;
  const unavailable = (field: string) => disabled || !editable(field);
  if (!advancedFields.some(visible)) return null;
  return <details className="rounded-xl border border-rule p-4">
    <summary className="cursor-pointer font-medium">Advanced audience and delivery</summary>
    <div className="mt-4 space-y-5">
      {options?.audiences_truncated && <p role="status" className={hint}>The audience list is partial. Search covers the loaded audiences; your existing selections are preserved.</p>}
      {visible("audience_ids") && <CatalogField title="Included audiences" values={value.audience_ids ?? []} choices={options?.audiences} error={options?.audiences_error} disabled={unavailable("audience_ids")} onChange={v => onChange({ audience_ids: v })} />}
      {visible("excluded_audience_ids") && <CatalogField title="Excluded audiences" values={value.excluded_audience_ids ?? []} choices={options?.audiences} error={options?.audiences_error} disabled={unavailable("excluded_audience_ids")} onChange={v => onChange({ excluded_audience_ids: v })} />}
      {visible("interest_category_ids") && <CatalogField title="Interests" values={value.interest_category_ids ?? []} choices={options?.interests} error={options?.interests_error} disabled={unavailable("interest_category_ids")} onChange={v => onChange({ interest_category_ids: v })} />}
      {visible("operating_systems") && <fieldset disabled={unavailable("operating_systems")}>
        <legend className={label}>Operating systems</legend>
        <div className="mt-2 flex flex-wrap gap-3">{["", "IOS", "ANDROID"].map(system => <label key={system} className="flex items-center gap-2 text-sm"><input type="radio" name={osId} checked={value.operating_systems != null && (system ? value.operating_systems.length === 1 && value.operating_systems[0] === system : value.operating_systems.length === 0)} onChange={() => onChange({ operating_systems: system ? [system] : [] })} />{system || "All operating systems"}</label>)}</div>
        {value.operating_systems == null && <p className={hint}>TikTok did not report the current operating system restriction.</p>}
        {!!value.operating_systems?.length && (value.operating_systems.length > 1 || !["IOS", "ANDROID"].includes(value.operating_systems[0])) && <p className={hint}>Current values: {value.operating_systems.join(", ")}. Choose a single operating system or all to replace this setting.</p>}
      </fieldset>}
      {([ ["network_types", "Network types", ["WIFI", "2G", "3G", "4G", "5G"]] ] as const).map(([field, title, choices]) => visible(field) && <fieldset key={field} disabled={unavailable(field)}>
        <legend className={label}>{title}</legend><div className="mt-2 flex flex-wrap gap-3">{[...new Set([...choices, ...(value[field] ?? [])])].map(choice => <label key={choice} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value[field]?.includes(choice) ?? false} onChange={e => onChange({ [field]: e.target.checked ? [...(value[field] ?? []), choice] : value[field]?.filter(v => v !== choice) ?? [] })} />{choice}</label>)}</div><p className={hint}>No selection means all {title.toLowerCase()}.</p>
      </fieldset>)}
      {([ ["smart_audience_enabled", "Smart audience expansion"], ["smart_interest_behavior_enabled", "Smart interest and behavior expansion"], ["comment_disabled", "Disable comments"], ["share_disabled", "Disable sharing"] ] as const).map(([field, title]) => visible(field) && <label key={field} className={label}>{title}<SheetSelect value={value[field] == null ? "" : String(value[field])} disabled={unavailable(field)} onChange={e => { if (e.target.value) onChange({ [field]: e.target.value === "true" }); }}><option value="" disabled>Not reported</option><option value="true">Yes</option><option value="false">No</option></SheetSelect></label>)}
      {visible("dayparting") && <DaypartingFields value={value.dayparting} disabled={unavailable("dayparting")} timezone={timezone} onChange={dayparting => onChange({ dayparting })} />}
      {visible("bid_type") && <label className={label}>Bid strategy<SheetSelect value={value.bid_type ?? ""} disabled={unavailable("bid_type")} onChange={e => onChange({ bid_type: e.target.value, ...(e.target.value === "BID_TYPE_NO_BID" ? { bid_price: undefined } : {}) })}><option value="" disabled>Not reported</option><option value="BID_TYPE_NO_BID">Maximum results (no bid cap)</option><option value="BID_TYPE_CUSTOM">Custom bid</option>{value.bid_type && !["BID_TYPE_NO_BID", "BID_TYPE_CUSTOM"].includes(value.bid_type) && <option value={value.bid_type}>{words(value.bid_type)}</option>}</SheetSelect></label>}
      {visible("bid_price") && value.bid_type === "BID_TYPE_CUSTOM" && <label className={label}>Bid per click ({currency ?? "currency unavailable"})<input className={input} type="number" min="0.01" max="100000" step="0.01" value={value.bid_price ?? ""} disabled={unavailable("bid_price")} onChange={e => onChange({ bid_price: e.target.value ? Number(e.target.value) : 0 })} /></label>}
      <p className={hint}>Unavailable controls show the current configuration. Only settings supported for this ad group can be changed here.</p>
    </div>
  </details>;
}
