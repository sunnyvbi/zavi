"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { RulesCard } from "./RulesCard";

type Kind = "Country" | "State" | "City" | "Zip" | "Region" | "Other";
type Platform = "meta" | "google";
export type GuardPlace = { id: string; name: string; kind: Kind; platform: Platform };
export type AdGuard = { allowed_places: GuardPlace[]; blocked_places: GuardPlace[]; banned_phrases: string[] };

const EMPTY: AdGuard = { allowed_places: [], blocked_places: [], banned_phrases: [] };
const MAX = 50;
const PHRASE_MAX = 80;
const PLATFORM_LABEL: Record<Platform, string> = { meta: "Meta", google: "Google" };
const KINDS = new Set<Kind>(["Country", "State", "City", "Zip", "Region"]);

async function errorMessage(r: Response, fallback: string): Promise<string> {
  try {
    const j = (await r.json()) as { error?: { message?: string } };
    return j.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function searchPlaces(q: string): Promise<GuardPlace[]> {
  const one = async (slug: string, platform: Platform): Promise<GuardPlace[]> => {
    try {
      const r = await apiFetch(`/api/channels/${slug}/ad-locations/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) return [];
      const j = (await r.json()) as { places?: Array<{ id: string; name: string; kind: string }> };
      return (j.places ?? []).map((p) => ({ id: p.id, name: p.name, kind: (KINDS.has(p.kind as Kind) ? p.kind : "Other") as Kind, platform }));
    } catch {
      return [];
    }
  };
  const [meta, google] = await Promise.all([one("meta_ads", "meta"), one("google_ads", "google")]);
  return [...meta, ...google];
}

const same = (a: GuardPlace, b: GuardPlace) => a.id === b.id && a.platform === b.platform;

function PlaceList({
  label,
  hint,
  places,
  canManage,
  busy,
  onChange,
}: {
  label: string;
  hint: string;
  places: GuardPlace[];
  canManage: boolean;
  busy: boolean;
  onChange: (next: GuardPlace[]) => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ term: string; places: GuardPlace[] }>({ term: "", places: [] });
  const results = found.term === q.trim() ? found.places : [];
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setSearching(false);
      return;
    }
    let live = true;
    const t = window.setTimeout(async () => {
      setSearching(true);
      const hits = await searchPlaces(term);
      if (live) {
        setFound({ term, places: hits });
        setSearching(false);
      }
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q]);

  const fresh = results.filter((r) => !places.some((p) => same(p, r)));
  const first = [...fresh.filter((r) => r.platform === "meta").slice(0, 3), ...fresh.filter((r) => r.platform === "google").slice(0, 3)];
  const shown = [...first, ...fresh.filter((r) => !first.includes(r))].slice(0, 6);
  return (
    <div>
      <p className="text-[13px] font-medium text-[#0e0f11]">{label}</p>
      <p className="mt-0.5 text-[12px] text-[#8a8a8a]">{hint}</p>
      {places.length === 0 ? (
        <p className="mt-2 rounded-xl bg-[#f9f9f9] px-3 py-2.5 text-[13px] text-[#595959]">None saved.</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {places.map((p) => (
            <li key={`${p.platform}:${p.id}`} className="flex items-center justify-between gap-3 rounded-xl bg-[#f9f9f9] px-3 py-2">
              <span className="min-w-0 flex-1 text-[13px] text-[#0e0f11]">
                {p.name} <span className="text-[12px] text-[#8a8a8a]">· {p.kind} · {PLATFORM_LABEL[p.platform]}</span>
              </span>
              {canManage && (
                <button
                  type="button"
                  aria-label={`Remove ${p.name}`}
                  onClick={() => onChange(places.filter((x) => !same(x, p)))}
                  disabled={busy}
                  className="rounded-cta p-1 text-[#595959] hover:bg-white disabled:opacity-40"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && places.length < MAX && (
        <div className="mt-2">
          <input
            aria-label={`Search places: ${label}`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a city, state or country"
            disabled={busy}
            className="w-full rounded-xl border border-[#e8e8e8] bg-white px-3 py-2 text-[13px]"
          />
          {searching && <p className="mt-1 text-[12px] text-[#8a8a8a]">Searching…</p>}
          {shown.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {shown.map((p) => (
                <li key={`${p.platform}:${p.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange([...places, p]);
                      setQ("");
                    }}
                    className="w-full rounded-xl px-3 py-2 text-left text-[13px] text-[#0e0f11] hover:bg-[#f9f9f9]"
                  >
                    {p.name} <span className="text-[12px] text-[#8a8a8a]">· {p.kind} · {PLATFORM_LABEL[p.platform]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function AdGuardSection({ canManage }: { canManage: boolean }) {
  const [saved, setSaved] = useState<AdGuard | null>(null);
  const [draft, setDraft] = useState<AdGuard>(EMPTY);
  const [phrase, setPhrase] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/rules/ad-guard");
      if (!r.ok) throw new Error(String(r.status));
      const g = ((await r.json()) as { ad_guard?: AdGuard }).ad_guard ?? EMPTY;
      setSaved(g);
      setDraft(g);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const changed = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch("/api/rules/ad-guard", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!r.ok) {
        setError(await errorMessage(r, "Could not save these."));
        return;
      }
      const g = ((await r.json()) as { ad_guard?: AdGuard }).ad_guard ?? draft;
      setSaved(g);
      setDraft(g);
    } catch {
      setError("Could not save these.");
    } finally {
      setBusy(false);
    }
  };
  const addPhrase = () => {
    const p = phrase.trim();
    if (!p || draft.banned_phrases.includes(p) || draft.banned_phrases.length >= MAX) return;
    setDraft({ ...draft, banned_phrases: [...draft.banned_phrases, p] });
    setPhrase("");
  };

  return (
    <RulesCard>
      <h3 className="text-[14px] font-semibold text-[#0e0f11]">Places and phrases for ads</h3>
      <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
        Zavi checks your live ads once a day and asks you about any that break these. It never pauses or blocks an ad
        on its own. Leave them empty and nothing is checked.
      </p>
      {loadFailed && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-[#f9f9f9] px-3 py-2.5">
          <span className="text-[13px] text-[#595959]">Could not load these.</span>
          <button type="button" onClick={() => void load()} className="shrink-0 rounded-cta px-2 py-1 text-[13px] font-medium text-[#0e0f11] hover:bg-white">
            Retry
          </button>
        </div>
      )}
      {saved && (
        <div className="mt-4 space-y-5">
          <PlaceList
            label="Ads may show only in"
            hint="An ad reaching anywhere else is flagged."
            places={draft.allowed_places}
            canManage={canManage}
            busy={busy}
            onChange={(allowed_places) => setDraft({ ...draft, allowed_places })}
          />
          <PlaceList
            label="Ads must never show in"
            hint="An ad reaching any of these is flagged."
            places={draft.blocked_places}
            canManage={canManage}
            busy={busy}
            onChange={(blocked_places) => setDraft({ ...draft, blocked_places })}
          />
          <div>
            <p className="text-[13px] font-medium text-[#0e0f11]">Ads must never say</p>
            <p className="mt-0.5 text-[12px] text-[#8a8a8a]">A word or phrase, for example a competitor&apos;s name.</p>
            {draft.banned_phrases.length === 0 ? (
              <p className="mt-2 rounded-xl bg-[#f9f9f9] px-3 py-2.5 text-[13px] text-[#595959]">None saved.</p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {draft.banned_phrases.map((p) => (
                  <li key={p} className="flex items-center gap-1 rounded-xl bg-[#f9f9f9] px-2.5 py-1.5 text-[13px] text-[#0e0f11]">
                    {p}
                    {canManage && (
                      <button
                        type="button"
                        aria-label={`Remove ${p}`}
                        onClick={() => setDraft({ ...draft, banned_phrases: draft.banned_phrases.filter((x) => x !== p) })}
                        disabled={busy}
                        className="rounded-cta p-0.5 text-[#595959] hover:bg-white disabled:opacity-40"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canManage && (
              <div className="mt-2 flex gap-2">
                <input
                  aria-label="Add a phrase ads must never say"
                  placeholder="For example: cheapest in town"
                  value={phrase}
                  maxLength={PHRASE_MAX}
                  onChange={(e) => setPhrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPhrase();
                    }
                  }}
                  disabled={busy}
                  className="min-w-0 flex-1 rounded-xl border border-[#e8e8e8] bg-white px-3 py-2 text-[13px]"
                />
                <button
                  type="button"
                  onClick={addPhrase}
                  disabled={busy || !phrase.trim()}
                  className="rounded-cta px-3 py-2 text-[13px] font-medium text-[#0e0f11] hover:bg-[#f9f9f9] disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            )}
          </div>
          {canManage && (
            <div className="flex items-center gap-2 border-t border-[#f6f6f6] pt-4">
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !changed}
                className="rounded-cta bg-[#0e0f11] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-40"
              >
                Save places and phrases
              </button>
              {changed && (
                <button type="button" onClick={() => setDraft(saved)} disabled={busy} className="rounded-cta px-3 py-2 text-[13px] text-[#595959] hover:bg-[#f9f9f9]">
                  Cancel
                </button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-[12px] text-[#cb2029]">
              {error}
            </p>
          )}
        </div>
      )}
    </RulesCard>
  );
}
