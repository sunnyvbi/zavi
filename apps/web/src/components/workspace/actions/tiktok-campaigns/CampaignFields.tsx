"use client";
import { useId } from "react";
import { PlacesField } from "../topActions/fields";
import { SheetSelect, sheetLabel as label, sheetInput as input, sheetHint as hint } from "../managed-campaigns/AdsSheet";
import { AGE_OPTIONS, CALLS_TO_ACTION, words, type TiktokCampaignOptions, type TiktokSettings } from "./types";

export function AudienceFields({ value, onChange, options, advertiserId, disabled, editableFields, existingAgeTargeting = false }: {
  value: TiktokSettings; onChange: (patch: Partial<TiktokSettings>) => void;
  options: TiktokCampaignOptions | null; advertiserId: string; disabled: boolean; editableFields?: string[]; existingAgeTargeting?: boolean;
}) {
  const id = useId();
  const places = (value.location_ids ?? []).map(id => ({ id, name: options?.locations.find(p => p.location_id === id)?.name ?? `Location ${id}` }));
  const ages = value.age_groups ?? [];
  const languages = value.languages ?? [];
  const unavailable = (field: string) => disabled || (!!editableFields && !editableFields.includes(field));
  const unsupportedAges = ages.filter(age => !AGE_OPTIONS.some(([id]) => id === age));
  const replaceAges = existingAgeTargeting && (value.age_groups == null || !ages.length || unsupportedAges.length > 0);
  return <div className="space-y-5">
    {options?.languages_error && <p role="status" className={hint}>Language choices could not be loaded. Your current selection is preserved.</p>}
    <div><label className={label} htmlFor={`${id}-places`}>Where</label><PlacesField id={`${id}-places`} slug="tiktok_ads" advertiserId={advertiserId} max={25} value={places} disabled={unavailable("location_ids")} onChange={p => onChange({ location_ids: p.map(v => v.id) })} /><p className={hint}>Choose up to 25 countries, regions or cities.</p></div>
    <fieldset><legend className={label}>Ages</legend>
      {replaceAges && <div className="mt-2 space-y-2 text-sm">
        <p>{value.age_groups == null ? "TikTok did not report the current age restrictions." : !ages.length ? "Current targeting has no age restrictions; it is not limited to adults." : `Current ages: ${ages.map(age => AGE_OPTIONS.find(([id]) => id === age)?.[1] ?? (age === "AGE_13_17" ? "13–17 (not editable here)" : `${age} (not editable here)`)).join(", ")}.`}</p>
        <button type="button" className="underline" disabled={unavailable("age_groups")} onClick={() => onChange({ age_groups: AGE_OPTIONS.map(([id]) => id) })}>Replace with adult targeting (18+)</button>
        <p className={hint}>The current ages stay unchanged unless you replace them.</p>
      </div>}
      <div className="mt-2 flex flex-wrap gap-4">{AGE_OPTIONS.map(([id, name]) => <label key={id} className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={ages.includes(id)} disabled={unavailable("age_groups") || replaceAges} onChange={e => onChange({ age_groups: e.target.checked ? [...ages, id] : ages.filter(a => a !== id) })} />{name}</label>)}</div>
      {!replaceAges && <p className={hint}>Leave all unchecked to reach all adults (18+).</p>}
    </fieldset>
    <label className={label}>Gender<SheetSelect value={value.gender ?? "GENDER_UNLIMITED"} disabled={unavailable("gender")} onChange={e => onChange({ gender: e.target.value })}><option value="GENDER_UNLIMITED">All genders</option><option value="GENDER_FEMALE">Female</option><option value="GENDER_MALE">Male</option></SheetSelect></label>
    <div><label className={label} htmlFor={`${id}-languages`}>Languages</label><div className="mt-2 flex flex-wrap gap-2">{languages.map(code => <button type="button" key={code} disabled={unavailable("languages")} className="rounded-full border border-rule px-3 py-1 text-sm" aria-label={`Remove language ${options?.languages.find(l => l.id === code)?.name ?? code}`} onClick={() => onChange({ languages: languages.filter(l => l !== code) })}>{options?.languages.find(l => l.id === code)?.name ?? code} ×</button>)}</div><SheetSelect id={`${id}-languages`} value="" disabled={unavailable("languages") || !options?.languages.length} onChange={e => { if (e.target.value) onChange({ languages: [...languages, e.target.value] }); }}><option value="">Add a language</option>{options?.languages.filter(l => !languages.includes(l.id)).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</SheetSelect><p className={hint}>No selection means all languages.</p></div>
  </div>;
}

export function CreativeFields({ value, onChange, disabled, editableFields }: { value: TiktokSettings; onChange: (patch: Partial<TiktokSettings>) => void; disabled: boolean; editableFields?: string[] }) {
  const unavailable = (field: string) => disabled || (!!editableFields && !editableFields.includes(field));
  return <div className="space-y-5">
    <label className={label}>Ad text<textarea className={`${input} py-2`} rows={3} maxLength={100} value={value.ad_text ?? ""} disabled={unavailable("ad_text")} onChange={e => onChange({ ad_text: e.target.value })} /><span className={hint}>{(value.ad_text ?? "").length}/100 characters</span></label>
    <label className={label}>Landing page<input className={input} type="url" value={value.landing_page_url ?? ""} placeholder="https://example.com" disabled={unavailable("landing_page_url")} onChange={e => onChange({ landing_page_url: e.target.value })} /></label>
    <label className={label}>Call to action<SheetSelect value={value.call_to_action ?? ""} disabled={unavailable("call_to_action")} onChange={e => onChange({ call_to_action: e.target.value })}><option value="">Choose a call to action</option>{value.call_to_action && !CALLS_TO_ACTION.includes(value.call_to_action) && <option value={value.call_to_action}>{words(value.call_to_action)}</option>}{CALLS_TO_ACTION.map(cta => <option key={cta} value={cta}>{words(cta)}</option>)}</SheetSelect></label>
  </div>;
}
