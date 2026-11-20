"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, MapPin, Search, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { AdsDialog } from "@/components/ui/AdsDialog";
import { readWorkspaceLocation, replaceWorkspaceLocation } from "../navigation/workspaceRoutes";

export const AD_LOCATION_SLUGS: ReadonlySet<string> = new Set(["google_ads", "youtube_ads", "meta_ads"]);

export const MAX_PLACES = 50;

export const AD_LOCATIONS_SAVE_TIMEOUT_MS = 45_000;
const SLOW_SAVE = "This is taking too long. Wait a minute, then check where your ads show before you save again.";

function timedOut(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

type Kind = "City" | "State" | "Country" | "Region" | "Metro" | "Postal code" | "Place";
type Source = "orders" | "address";
export type AdPlace = { id: string; name: string; kind: Kind; source?: Source; reason?: string };
type Country = { code: string; name: string };

export type LocationStatus =
  | { state: "none" }
  | {
      state: "needs_you" | "saved" | "unsupported";
      channel: string;
      campaign: { id: string; name: string | null };
      country: Country | null;
      places: AdPlace[];
      targeting: "single" | "mixed" | "unsupported";
      ad_groups: number;
      pending: boolean;
      last_error: string | null;
      order_cities: string[];
      fingerprint: string;
    };

type Suggestions = { orders: "confirmed" | "not_set_up" | "no_db"; country: Country | null; places: AdPlace[]; picked: string[] };

const SOURCE_LABEL: Record<Source, string> = { orders: "Your orders", address: "Your address" };

function cx(...p: (string | false | null | undefined)[]) {
  return p.filter(Boolean).join(" ");
}

export function countryArticle(name: string): string {
  return /^(United |Netherlands$|Philippines$|Czech Republic$|Bahamas$|Gambia$)/.test(name) ? "the " : "";
}

export function joinAnd(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

function messageOf(body: unknown, fallback: string): string {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" && m.trim() ? m : fallback;
}

function linkedHere(slug: string): boolean {
  try {
    const url = new URL(readWorkspaceLocation(), "https://workspace.local");
    return url.searchParams.get("locations") === "1" && url.searchParams.get("channel") === slug;
  } catch {
    return false;
  }
}

function clearLink(): void {
  try {
    const url = new URL(readWorkspaceLocation(), "https://workspace.local");
    if (!url.searchParams.has("locations")) return;
    url.searchParams.delete("locations");
    replaceWorkspaceLocation(`${url.pathname}${url.search}${url.hash}`);
  } catch {
  }
}

function isLocationStatus(v: unknown): v is LocationStatus {
  if (!v || typeof v !== "object") return false;
  const s = (v as { state?: unknown; places?: unknown }).state;
  if (s === "none") return true;
  return (s === "needs_you" || s === "saved" || s === "unsupported") && Array.isArray((v as { places?: unknown }).places);
}

export const AD_LOCATIONS_PLACEHOLDER_DELAY_MS = 400;

function AdLocationsPlaceholder() {
  return (
    <section
      aria-label="Where your ads show"
      aria-busy="true"
      data-testid="ad-locations-loading"
      className="mb-4 rounded-2xl border border-rule bg-cream p-4"
    >
      <p className="flex items-center gap-2 text-[14px] font-semibold text-ink">
        <MapPin className="h-4 w-4 text-inkMuted" aria-hidden="true" />
        Where your ads show
      </p>
      <span className="sr-only">Reading your ad account</span>
      <span aria-hidden className="mt-2 block h-3.5 w-[70%] animate-pulse rounded-md bg-creamDeep [animation-duration:1.6s] motion-reduce:animate-none" />
    </section>
  );
}

export function AdLocationsCard({ slug, channelName, onOpenConnectors }: { slug: string; channelName: string; onOpenConnectors?: () => void }) {
  const [status, setStatus] = useState<LocationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [keepBusy, setKeepBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [showPlaceholder, setShowPlaceholder] = useState(false);
  const linked = useRef(linkedHere(slug));

  const load = useCallback(async (): Promise<LocationStatus | null> => {
    try {
      const res = await apiFetch(`/api/channels/${encodeURIComponent(slug)}/ad-locations`);
      if (!res.ok) return null;
      const next = await readJson<LocationStatus>(res);
      if (!isLocationStatus(next)) return null;
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, [slug]);

  useEffect(() => {
    if (settled) return;
    const t = window.setTimeout(() => setShowPlaceholder(true), AD_LOCATIONS_PLACEHOLDER_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [settled]);

  useEffect(() => {
    void load().then((s) => {
      setSettled(true);
      if (linked.current && s && s.state !== "none" && s.state !== "unsupported") setOpen(true);
      if (linked.current) clearLink();
      linked.current = false;
    });
  }, [load]);

  const pending = status && status.state !== "none" && status.pending;
  useEffect(() => {
    if (!pending) return;
    let tries = 0;
    const t = window.setInterval(() => {
      tries += 1;
      void load().then((s) => {
        if (!s || s.state === "none" || !s.pending || tries >= 10) window.clearInterval(t);
      });
    }, 3000);
    return () => window.clearInterval(t);
  }, [pending, load]);

  if (!status && !settled && showPlaceholder) return <AdLocationsPlaceholder />;
  if (!status || status.state === "none") return null;
  const s = status;
  const country = s.country;
  const cities = s.order_cities.filter((c) => c.trim().toLowerCase() !== "other");

  async function keepCountry() {
    setKeepBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/channels/${encodeURIComponent(slug)}/ad-locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(AD_LOCATIONS_SAVE_TIMEOUT_MS),
        body: JSON.stringify({ campaign_id: s.campaign.id, fingerprint: s.fingerprint, places: [] }),
      });
      const body = await readJson<unknown>(res);
      if (!res.ok) setError(messageOf(body, "That didn't save. Try again."));
      await load();
    } catch (e) {
      setError(timedOut(e) ? SLOW_SAVE : "That didn't save. Try again.");
    } finally {
      setKeepBusy(false);
    }
  }

  return (
    <section aria-label="Where your ads show" className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-2xl border border-rule bg-cream p-4">
      <div className="min-w-0 flex-1 basis-[280px]">
      <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
        <MapPin className="h-4 w-4 text-inkMuted" aria-hidden="true" />
        Where your ads show
        {s.state === "needs_you" && <span className="rounded-md bg-creamDeep px-2 py-0.5 text-[13px] font-medium text-inkSoft">Needs you</span>}
      </p>

      {s.state === "unsupported" ? (
        <p className="mt-1 text-[14px] leading-relaxed text-inkSoft">
          Zavi can&apos;t change where this {channelName} campaign shows. Change it in {slug === "meta_ads" ? "Meta Ads Manager" : "Google Ads"}.
        </p>
      ) : s.state === "needs_you" ? (
        <p className="mt-1 text-[14px] leading-relaxed text-inkSoft">
          Across {country ? countryArticle(country.name) : ""}
          <span className="font-medium text-ink">{country?.name ?? "your country"}</span> for now.{" "}
          {cities.length > 0 ? `Most of your orders come from ${joinAnd(cities)}.` : "Pick places to narrow it."}
        </p>
      ) : (
        <p className="mt-1 text-[14px] leading-relaxed text-inkSoft">
          {s.places.map((p) => p.name).join(", ")}.{" "}
          {s.pending ? "Zavi is updating your campaign now." : "Zavi tells you if orders start coming from somewhere new."}
        </p>
      )}

      {s.last_error && (
        <p role="alert" className="mt-2 text-[14px] font-medium text-danger">
          Your last change didn&apos;t go through: {s.last_error}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[14px] font-medium text-danger">
          {error}
        </p>
      )}

      </div>
      {s.state !== "unsupported" && (
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {s.state === "needs_you" && (
            <button
              type="button"
              disabled={keepBusy}
              onClick={() => void keepCountry()}
              className="h-10 rounded-cta border-[1.5px] border-rule bg-cream px-3.5 text-[14px] font-semibold text-inkSoft transition-colors hover:bg-creamDeep disabled:opacity-40"
            >
              Keep the whole country
            </button>
          )}
          <button
            type="button"
            disabled={s.pending}
            onClick={() => setOpen(true)}
            className="h-10 rounded-cta bg-ink px-3.5 text-[14px] font-semibold text-cream transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {s.state === "needs_you" ? "Pick places" : "Edit places"}
          </button>
        </div>
      )}

      {open && (
        <AdLocationsModal
          slug={slug}
          channelName={channelName}
          status={s}
          onOpenConnectors={onOpenConnectors}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            void load();
          }}
        />
      )}
    </section>
  );
}

export function usePlaceSearch(slug: string, q: string, advertiserId?: string): { results: AdPlace[]; searching: boolean; problem: string | null } {
  const [results, setResults] = useState<AdPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setProblem(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiFetch(`/api/channels/${encodeURIComponent(slug)}/ad-locations/search?q=${encodeURIComponent(term)}${advertiserId ? `&advertiser_id=${encodeURIComponent(advertiserId)}` : ""}`);
        const body = await readJson<{ places?: AdPlace[]; error?: { message?: string } }>(res);
        if (!live) return;
        setResults(res.ok ? body?.places ?? [] : []);
        setProblem(res.ok ? null : body?.error?.message || "Place search failed. Try again in a minute.");
      } catch {
        if (!live) return;
        setResults([]);
        setProblem("Place search failed. Try again in a minute.");
      } finally {
        if (live) setSearching(false);
      }
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, slug, advertiserId]);
  return { results, searching, problem };
}

export function AdLocationsModal({
  slug,
  channelName,
  status,
  onClose,
  onSaved,
  onOpenConnectors,
}: {
  slug: string;
  channelName: string;
  status: Extract<LocationStatus, { campaign: unknown }>;
  onClose: () => void;
  onSaved: () => void;
  onOpenConnectors?: () => void;
}) {
  const [sugg, setSugg] = useState<Suggestions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<AdPlace[]>([]);
  const [q, setQ] = useState("");
  const [applyAll, setApplyAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countryWide = status.places.length === 1 && status.places[0].kind === "Country";
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch(`/api/channels/${encodeURIComponent(slug)}/ad-locations/suggestions`);
        const body = await readJson<Suggestions>(res);
        if (!live) return;
        if (!res.ok || !body) {
          setLoadError(messageOf(body, "Zavi couldn't load suggestions. You can still search for places."));
          setSugg({ orders: "not_set_up", country: status.country, places: [], picked: [] });
          setPicked(countryWide ? [] : status.places);
          return;
        }
        setSugg(body);
        setPicked(countryWide ? body.places.filter((p) => body.picked.includes(p.id)) : status.places);
      } catch {
        if (!live) return;
        setLoadError("Zavi couldn't load suggestions. You can still search for places.");
        setSugg({ orders: "not_set_up", country: status.country, places: [], picked: [] });
        setPicked(countryWide ? [] : status.places);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const { results, searching } = usePlaceSearch(slug, q);

  const has = useCallback((p: AdPlace) => picked.some((x) => x.id === p.id), [picked]);
  const full = picked.length >= MAX_PLACES;
  const toggle = (p: AdPlace) =>
    setPicked((cur) => (cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : cur.length >= MAX_PLACES ? cur : [...cur, p]));
  const shown = useMemo(() => results.filter((p) => !has(p)).slice(0, 6), [results, has]);
  const suggested = sugg?.places ?? [];
  const country = status.country ?? sugg?.country ?? null;
  const countryText = country ? `${countryArticle(country.name)}${country.name}` : "your country";
  const mixed = status.targeting === "mixed";
  const fromOrders = suggested.some((p) => p.source === "orders");
  const fromAddress = suggested.some((p) => p.source === "address");
  const subtitle = fromOrders
    ? fromAddress
      ? "Zavi suggested these from your orders and address."
      : "Zavi suggested these from your orders."
    : fromAddress
      ? "Zavi suggested these from your address."
      : "Search for the places your customers are in.";

  async function save() {
    if (mixed && !applyAll) {
      setError("Tick the box to apply these places to every ad group.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/channels/${encodeURIComponent(slug)}/ad-locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(AD_LOCATIONS_SAVE_TIMEOUT_MS),
        body: JSON.stringify({
          campaign_id: status.campaign.id,
          fingerprint: status.fingerprint,
          places: picked.map((p) => ({ id: p.id, name: p.name })),
          ...(mixed ? { apply_to_all: applyAll } : {}),
        }),
      });
      const body = await readJson<{ approved?: boolean; decision_id?: string | null }>(res);
      if (!res.ok) {
        setError(messageOf(body, "That didn't save. Try again."));
        return;
      }
      if (body?.decision_id && body.approved === false) {
        setError("Zavi saved your places but couldn't apply them. Approve the change in Channels.");
        return;
      }
      onSaved();
    } catch (e) {
      setError(timedOut(e) ? SLOW_SAVE : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdsDialog labelledBy="ad-locations-title" onClose={onClose} busy={busy} closeOnBackdrop>
      <div className="flex flex-col gap-5 p-6 compact:p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <h2 id="ad-locations-title" className="text-[24px] font-bold leading-[34px] text-ink">
              Where your ads show
            </h2>
            <p className="text-[14px] font-medium leading-5 text-inkSoft">{sugg ? subtitle : "Loading suggestions…"}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
            className="flex shrink-0 items-center justify-center rounded-block border border-rule bg-cream p-2 text-inkSoft outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-40"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {sugg?.orders === "no_db" && (
          <div className="flex items-center gap-3 rounded-xl border border-rule bg-creamDeep p-3.5 text-[14px] text-inkSoft">
            Connect your database and Zavi suggests places from where your customers actually buy.
            {onOpenConnectors && (
              <button
                type="button"
                onClick={onOpenConnectors}
                className="ml-auto shrink-0 rounded-cta border border-rule bg-cream px-3 py-1.5 text-[13px] font-semibold text-ink hover:bg-bone"
              >
                Connect
              </button>
            )}
          </div>
        )}
        {loadError && <p className="text-[14px] text-inkSoft">{loadError}</p>}

        {suggested.length > 0 && (
          <div>
            <p className="text-[13px] font-semibold uppercase tracking-wider text-inkMuted">Suggested</p>
            <ul className="mt-2 space-y-1.5">
              {suggested.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={has(p)}
                    disabled={!has(p) && full}
                    onClick={() => toggle(p)}
                    className={cx(
                      "flex w-full items-center gap-3 rounded-cta border bg-cream px-3.5 py-2.5 text-left transition-colors disabled:opacity-40",
                      has(p) ? "border-ink" : "border-rule hover:bg-creamDeep",
                    )}
                  >
                    <span className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded-md border", has(p) ? "border-ink bg-ink text-cream" : "border-rule")}>
                      {has(p) && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium text-ink">{p.name}</span>
                      {p.reason && <span className="block text-[13px] text-inkMuted">{p.reason}</span>}
                    </span>
                    {p.source && <span className="shrink-0 rounded-md bg-creamDeep px-2 py-0.5 text-[12px] font-medium text-inkSoft">{SOURCE_LABEL[p.source]}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <p className="text-[13px] font-semibold uppercase tracking-wider text-inkMuted">Add a place</p>
          <div className="relative mt-2">
            <div className="flex h-12 items-center gap-2 rounded-xl border border-rule bg-cream px-3.5 focus-within:border-ink">
              <Search className="h-4 w-4 text-inkMuted" aria-hidden="true" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                disabled={full}
                placeholder="City, state or country"
                aria-label="Search places"
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-inkMuted focus:outline-none disabled:opacity-60"
              />
            </div>
            {shown.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-rule bg-cream shadow-lg">
                {shown.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        toggle(p);
                        setQ("");
                      }}
                      className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-[14px] hover:bg-creamDeep"
                    >
                      <span className="text-ink">{p.name}</span>
                      <span className="text-[12px] text-inkMuted">{p.kind}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!searching && q.trim().length >= 2 && shown.length === 0 && results.length === 0 && (
              <p className="mt-1.5 text-[13px] text-inkMuted">No places match. Try a city, state or country name.</p>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {picked.length === 0 ? (
              <span className="text-[14px] text-inkMuted">Nothing picked: ads show across {countryText}.</span>
            ) : (
              picked.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1 rounded-lg bg-creamDeep py-1 pl-2.5 pr-1.5 text-[13px] font-medium text-ink">
                  {p.name}
                  <button
                    type="button"
                    onClick={() => toggle(p)}
                    aria-label={`Remove ${p.name}`}
                    className="flex size-5 items-center justify-center rounded text-inkMuted hover:bg-bone hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </span>
              ))
            )}
          </div>
          {full && <p className="mt-2 text-[13px] text-inkMuted">You can pick up to {MAX_PLACES} places.</p>}
        </div>

        {mixed && (
          <label className="flex items-start gap-2 rounded-2xl border border-rule p-4 text-[14px] font-medium text-ink">
            <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} className="mt-0.5 h-4 w-4" />
            <span>
              This campaign&apos;s {status.ad_groups} ad groups show in different places today. Apply these places to every ad group.
            </span>
          </label>
        )}

        <p className="text-[13px] text-inkMuted">These places apply to this {channelName} campaign only.</p>
        {error && (
          <p role="alert" className="text-[14px] font-medium leading-5 text-danger">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-12 rounded-cta border-[1.5px] border-rule bg-cream px-4 text-[16px] font-semibold text-inkSoft disabled:opacity-40"
          >
            Cancel
          </button>
          <button type="button" disabled={busy || !sugg} onClick={() => void save()} className="h-12 rounded-cta bg-ink px-4 text-[16px] font-semibold text-cream disabled:opacity-40">
            {busy ? "Saving…" : picked.length ? `Save ${picked.length} place${picked.length === 1 ? "" : "s"}` : "Save whole country"}
          </button>
        </div>
      </div>
    </AdsDialog>
  );
}
