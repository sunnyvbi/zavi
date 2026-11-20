"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Skeleton } from "./Skeleton";
import { HINT, INPUT, LABEL, SaveBar, Section, Updated, errorMessageOf } from "./personalization/shared";
import { ChevronDown } from "lucide-react";
import { countryLabel, countryOptions } from "@/lib/countries";

type CompanyFact = {
  key: string;
  value_text: string;
  source?: string | null;
  source_ref?: string | null;
  verified_at?: string | null;
  updated_at?: string | null;
};

export function countrySetByZavi(facts: readonly CompanyFact[]): string | null {
  const f = facts.find((x) => x.key === "country");
  return f && f.source === "connector" && f.value_text && f.source_ref ? f.source_ref : null;
}

const FACT_ORDER = [
  "company_name",
  "domain",
  "what_we_sell",
  "who_we_serve",
  "competitors",
  "markets",
  "country",
] as const;

type FactKey = (typeof FACT_ORDER)[number];

const FACT_LABEL: Record<FactKey, string> = {
  company_name: "Company name",
  domain: "Website",
  what_we_sell: "What you sell (offer)",
  who_we_serve: "Who you serve (customers)",
  competitors: "Competitors",
  markets: "Markets",
  country: "Country",
};

const FACT_PLACEHOLDER: Partial<Record<FactKey, string>> = {
  company_name: "Enter company name",
  domain: "https://www.yourcompany.com",
  what_we_sell: "Scheduling software for dental clinics",
  who_we_serve: "Owners and front-desk managers of small clinics",
  competitors: "Calendly, Acuity",
  markets: "e.g. United States, Canada",
};

const FACT_NOTE: Partial<Record<FactKey, string>> = {
  competitors: "Names only, comma separated. Anything that looks like a price is dropped.",
  country: "Zavi starts new ad campaigns across this country until you pick places.",
};

const MAX = 500;

function validate(key: FactKey, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length > MAX) return `Keep this under ${MAX} characters.`;
  if (key === "domain") {
    try {
      const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      if (!u.hostname.includes(".")) return "Enter a full website address, e.g. https://www.example.com.";
    } catch {
      return "Enter a full website address, e.g. https://www.example.com.";
    }
  }
  if (key === "company_name" && v.length < 2) return "Use at least 2 characters.";
  if (key === "country" && !/^[A-Z]{2}$/.test(v)) return "Pick a country from the list.";
  return null;
}

type Values = Record<FactKey, string>;
const empty = (): Values => Object.fromEntries(FACT_ORDER.map((k) => [k, ""])) as Values;

export function CompanyFactsPanel({ readOnly = false, onSaved }: { readOnly?: boolean; onSaved?: () => void }) {
  const [vals, setVals] = useState<Values>(empty);
  const [loaded, setLoaded] = useState<Values>(empty);
  const [stamps, setStamps] = useState<Partial<Record<FactKey, string | null>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FactKey, string>>>({});
  const [countryHint, setCountryHint] = useState<{ value: string; from: string } | null>(null);
  const [countryFrom, setCountryFrom] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await apiFetch("/api/connectors/company-facts");
      const body = (await res.json().catch(() => null)) as { facts?: CompanyFact[] } | null;
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      const next = empty();
      const at: Partial<Record<FactKey, string | null>> = {};
      for (const f of body?.facts ?? []) {
        if (!(FACT_ORDER as readonly string[]).includes(f.key)) continue;
        next[f.key as FactKey] = f.value_text ?? "";
        at[f.key as FactKey] = f.verified_at ?? f.updated_at ?? null;
      }
      setLoaded(next);
      setVals(next);
      setStamps(at);
      setCountryFrom(countrySetByZavi(body?.facts ?? []));
    } catch (e) {
      if (!silent) setError(e instanceof Error ? e.message : "Could not load company facts.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (readOnly || loading || loaded.country) return;
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch("/api/connectors/company-facts/suggestions");
        const body = (await res.json().catch(() => null)) as { suggestions?: { country?: { value: string; from: string } } } | null;
        if (live && res.ok && body?.suggestions?.country && /^[A-Z]{2}$/.test(body.suggestions.country.value)) setCountryHint(body.suggestions.country);
      } catch {
      }
    })();
    return () => {
      live = false;
    };
  }, [readOnly, loading, loaded.country]);

  const changed = FACT_ORDER.filter((k) => vals[k].trim() !== loaded[k].trim());
  const dirty = changed.length > 0;
  const newest = Object.values(stamps).reduce<string | null>(
    (best, s) => (s && (!best || Date.parse(s) > Date.parse(best)) ? s : best),
    null,
  );

  const save = useCallback(async () => {
    if (changed.length === 0) return;
    const errs: Partial<Record<FactKey, string>> = {};
    for (const k of changed) {
      const msg = validate(k, vals[k]);
      if (msg) errs[k] = msg;
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    setSaved(false);
    try {
      const res = await apiFetch("/api/connectors/company-facts", {
        method: "POST",
        body: JSON.stringify({ facts: changed.map((k) => ({ key: k, value: vals[k].trim() })) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { canonicalized?: string[]; rejected?: { key: string; dropped: string[] }[] }
        | null;
      if (!res.ok) throw new Error(errorMessageOf(body, `HTTP ${res.status}`));
      await load(true);
      onSaved?.();
      const parts: string[] = [];
      for (const entry of body?.canonicalized ?? []) {
        const i = entry.indexOf(" → ");
        parts.push(i === -1 ? entry : `${FACT_LABEL[entry.slice(0, i) as FactKey] ?? entry.slice(0, i)}${entry.slice(i)}`);
      }
      for (const r of body?.rejected ?? []) {
        parts.push(`${FACT_LABEL[r.key as FactKey] ?? r.key}: dropped "${r.dropped.join(", ")}" (names only)`);
      }
      if (parts.length > 0) setNotice(`Saved. ${parts.join(" · ")}`);
      else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }, [changed, vals, load, onSaved]);

  return (
    <Section
      id="about-company"
      title="About your company"
      description="Facts every agent starts from. Leave a field blank if you are not sure; agents will ask rather than guess."
      updatedAt={loading ? undefined : newest}
      aside={loading ? <Skeleton className="h-3 w-24" /> : undefined}
    >
      {loading ? (
        <div className="space-y-4">
          {FACT_ORDER.map((k) => (
            <div key={k}>
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-2 h-10 w-full" rounded="rounded-[10px]" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {FACT_ORDER.map((k) => {
            const id = `company-fact-${k}`;
            const err = fieldErrors[k];
            return (
              <div key={k}>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor={id} className={LABEL}>
                    {FACT_LABEL[k]}
                  </label>
                  {loaded[k] ? <Updated at={stamps[k]} /> : null}
                </div>
                {k === "country" ? (
                  <div className="relative">
                    <select
                      id={id}
                      value={vals.country}
                      disabled={readOnly || saving}
                      aria-invalid={!!err}
                      aria-describedby={err ? `${id}-error` : FACT_NOTE[k] ? `${id}-hint` : undefined}
                      onChange={(e) => {
                        const v = e.target.value;
                        setVals((prev) => ({ ...prev, country: v }));
                        setFieldErrors((prev) => {
                          if (!prev.country) return prev;
                          const next = { ...prev };
                          delete next.country;
                          return next;
                        });
                      }}
                      className={`${INPUT} cursor-pointer appearance-none pr-10`}
                    >
                      <option value="">Not set</option>
                      {countryOptions().map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <span className="pointer-events-none absolute bottom-0 right-3 flex h-10 items-center text-inkMuted" aria-hidden="true">
                      <ChevronDown className="h-4 w-4" />
                    </span>
                  </div>
                ) : (
                <input
                  id={id}
                  type={k === "domain" ? "url" : "text"}
                  value={vals[k]}
                  disabled={readOnly || saving}
                  maxLength={MAX}
                  aria-invalid={!!err}
                  aria-describedby={err ? `${id}-error` : FACT_NOTE[k] ? `${id}-hint` : undefined}
                  onChange={(e) => {
                    const v = e.target.value;
                    setVals((prev) => ({ ...prev, [k]: v }));
                    setFieldErrors((prev) => {
                      if (!prev[k]) return prev;
                      const next = { ...prev };
                      delete next[k];
                      return next;
                    });
                  }}
                  onBlur={() => {
                    const msg = validate(k, vals[k]);
                    setFieldErrors((prev) => (msg ? { ...prev, [k]: msg } : prev));
                  }}
                  placeholder={FACT_PLACEHOLDER[k] ?? ""}
                  className={INPUT}
                />
                )}
                {k === "country" && countryFrom && vals.country && vals.country === loaded.country ? (
                  <p className="mt-1.5 text-[13px] text-inkSoft">
                    Set by Zavi from {countryFrom}.{readOnly ? "" : " Pick another country to change it."}
                  </p>
                ) : null}
                {k === "country" && !readOnly && !vals.country && countryHint ? (
                  <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-inkSoft">
                    Suggested: {countryLabel(countryHint.value)}, from {countryHint.from}.
                    <button
                      type="button"
                      onClick={() => setVals((prev) => ({ ...prev, country: countryHint.value }))}
                      className="rounded-cta border border-rule px-2 py-0.5 text-[13px] font-semibold text-ink hover:bg-bone"
                    >
                      Use this
                    </button>
                  </p>
                ) : null}
                {err ? (
                  <p id={`${id}-error`} role="alert" className="mt-1 text-[13px] text-ink">
                    {err}
                  </p>
                ) : FACT_NOTE[k] ? (
                  <p id={`${id}-hint`} className={HINT}>
                    {FACT_NOTE[k]}
                  </p>
                ) : null}
              </div>
            );
          })}

          {!readOnly ? (
            <SaveBar
              dirty={dirty}
              saving={saving}
              saved={saved}
              error={error}
              onSave={() => void save()}
              onCancel={() => {
                setVals(loaded);
                setFieldErrors({});
                setError(null);
              }}
            />
          ) : (
            <p className="text-[13px] text-inkMuted">Only an owner or admin can edit company facts.</p>
          )}
          {notice ? (
            <p aria-live="polite" role="status" className="text-[13px] text-inkMuted">
              {notice}
            </p>
          ) : null}
        </div>
      )}
    </Section>
  );
}
