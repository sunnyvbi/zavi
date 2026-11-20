"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Info, Search, X } from "lucide-react";
import type { CreatorFilterLabels, CreatorFilterOptions, CreatorResultsNotes, CreatorSearchResult, FilterOption } from "@/lib/creator-storefront";
import { PlatformIcon } from "../actions/creators/CreatorCard";

export type Order = "newest" | "a_to_z";

export type FindFilters = {
  platform: string | null;
  keyword: string;
  niches: string[];
  lane: string | null;
  maxPriceCents: number | null;
  maxDeliveryDays: number | null;
  minFollowers: number | null;
  country: string | null;
  order: Order;
};

export const NO_FILTERS: FindFilters = {
  platform: null,
  keyword: "",
  niches: [],
  lane: null,
  maxPriceCents: null,
  maxDeliveryDays: null,
  minFollowers: null,
  country: null,
  order: "newest",
};

export type FilterParams = {
  platform?: string;
  keyword?: string;
  niches?: string;
  lane?: string;
  max_price?: string;
  max_days?: string;
  min_followers?: string;
  country?: string;
  sort?: string;
};

const positiveInt = (v: string | undefined): number | null => {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
};

export function filtersFromParams(p: FilterParams): FindFilters {
  return {
    platform: p.platform?.trim() || null,
    keyword: (p.keyword ?? "").slice(0, 200),
    niches: (p.niches ?? "").split(",").map((n) => n.trim()).filter(Boolean).slice(0, 20),
    lane: p.lane?.trim() || null,
    maxPriceCents: positiveInt(p.max_price),
    maxDeliveryDays: positiveInt(p.max_days),
    minFollowers: positiveInt(p.min_followers),
    country: p.country && /^[A-Za-z]{2}$/.test(p.country) ? p.country.toUpperCase() : null,
    order: p.sort === "a_to_z" ? "a_to_z" : "newest",
  };
}

export function filtersToParams(f: FindFilters): FilterParams {
  const p: FilterParams = {};
  if (f.platform) p.platform = f.platform;
  if (f.keyword.trim()) p.keyword = f.keyword.trim();
  if (f.niches.length) p.niches = f.niches.join(",");
  if (f.lane) p.lane = f.lane;
  if (f.maxPriceCents) p.max_price = String(f.maxPriceCents);
  if (f.maxDeliveryDays) p.max_days = String(f.maxDeliveryDays);
  if (f.minFollowers) p.min_followers = String(f.minFollowers);
  if (f.country) p.country = f.country;
  if (f.order !== "newest") p.sort = f.order;
  return p;
}

const LAST_FIND_KEY = "zavi.find.filters";
let lastParams: FilterParams | null = null;

export function rememberFindParams(p: FilterParams): void {
  lastParams = p;
  try {
    sessionStorage.setItem(LAST_FIND_KEY, JSON.stringify(p));
  } catch {
  }
}

export function lastFindParams(): FilterParams {
  if (lastParams) return lastParams;
  try {
    const raw = sessionStorage.getItem(LAST_FIND_KEY);
    if (raw) return filtersToParams(filtersFromParams(JSON.parse(raw) as FilterParams));
  } catch {
  }
  return {};
}

export function searchPath(f: FindFilters): string {
  const q = new URLSearchParams({ order: f.order, limit: "100" });
  if (f.platform) q.set("platform", f.platform);
  if (f.niches.length) q.set("niches", f.niches.join(","));
  if (f.lane) q.set("lane", f.lane);
  if (f.maxPriceCents) q.set("max_price_cents", String(f.maxPriceCents));
  if (f.maxDeliveryDays) q.set("max_delivery_days", String(f.maxDeliveryDays));
  if (f.country) q.set("country_code", f.country);
  return `/api/humans/creators/search?${q.toString()}`;
}

export function matchesLocally(c: CreatorSearchResult, f: FindFilters, bio?: string | null): boolean {
  if (f.minFollowers) {
    const most = Math.max(0, ...c.handles.map((h) => h.followers ?? 0));
    if (most < f.minFollowers) return false;
  }
  const words = f.keyword.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    c.display_name,
    ...c.niches,
    ...c.handles.map((h) => h.handle),
    ...c.packages.map((p) => p.title ?? ""),
    c.location.city ?? "",
    bio ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function activeCount(f: FindFilters): number {
  return (
    (f.platform ? 1 : 0) +
    (f.keyword.trim() ? 1 : 0) +
    f.niches.length +
    (f.lane ? 1 : 0) +
    (f.maxPriceCents ? 1 : 0) +
    (f.maxDeliveryDays ? 1 : 0) +
    (f.minFollowers ? 1 : 0) +
    (f.country ? 1 : 0)
  );
}

const labelOf = <T extends string | number>(list: FilterOption<T>[], v: T | null): string | null =>
  v === null ? null : (list.find((o) => o.value === v)?.label ?? null);

const PILL =
  "inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30";

const bone = "block animate-pulse bg-bone motion-reduce:animate-none";

function Pop({
  label,
  active,
  children,
  wide = false,
  trigger,
}: {
  label: ReactNode;
  active: boolean;
  children: (close: () => void) => ReactNode;
  wide?: boolean;
  trigger?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <div ref={box} className="relative" onKeyDown={onKey}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={trigger ?? `${PILL} ${active ? "border-ink bg-ink text-cream" : "border-rule bg-cream text-ink hover:bg-bone"}`}
      >
        {label}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          className={`absolute top-full left-0 z-30 mt-2 rounded-2xl border border-rule bg-cream p-2 shadow-elev ${wide ? "w-[min(320px,80vw)]" : "w-60"}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function Option({ on, onPick, children }: { on: boolean; onPick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      onClick={onPick}
      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-[14px] text-ink hover:bg-bone ${on ? "font-semibold" : ""}`}
    >
      <span className="min-w-0 truncate">{children}</span>
      {on ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
    </button>
  );
}

function ListPill<T extends string | number>({
  name,
  anyLabel,
  list,
  value,
  onPick,
  note,
  scroll = false,
}: {
  name: string;
  anyLabel: string;
  list: FilterOption<T>[];
  value: T | null;
  onPick: (v: T | null) => void;
  note?: string;
  scroll?: boolean;
}) {
  if (list.length === 0) return null;
  return (
    <Pop active={value !== null} label={labelOf(list, value) ?? name}>
      {(close) => (
        <div className={scroll ? "scrollbar-visible max-h-[280px] overflow-y-auto overscroll-contain" : ""}>
          {note ? <p className="px-3 pt-1 pb-2 text-[12px] text-inkMuted">{note}</p> : null}
          <Option
            on={value === null}
            onPick={() => {
              onPick(null);
              close();
            }}
          >
            {anyLabel}
          </Option>
          {list.map((o) => (
            <Option
              key={String(o.value)}
              on={value === o.value}
              onPick={() => {
                onPick(o.value);
                close();
              }}
            >
              {o.label}
            </Option>
          ))}
        </div>
      )}
    </Pop>
  );
}

function AboutResults({ notes }: { notes: (string | null)[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const shown = notes.filter((n): n is string => !!n);
  return (
    <span
      ref={box}
      className="relative inline-flex"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-label="About these results"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full text-inkMuted hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <span role="dialog" aria-label="About these results" className="absolute top-full left-0 z-30 mt-2 w-[min(360px,80vw)] rounded-2xl border border-rule bg-cream p-3.5 shadow-elev">
          <ul className="space-y-2 text-[13px] leading-relaxed text-inkSoft">
            {shown.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </span>
      )}
    </span>
  );
}

export function FindFilterBar({
  value: f,
  onChange,
  options,
  orders,
  shown,
  scanned = null,
  loading,
  orderLabel,
  neutralityNote,
  selfReportedNote = null,
  labels,
  notes,
  ready,
  aside = null,
}: {
  value: FindFilters;
  onChange: (next: FindFilters) => void;
  options: CreatorFilterOptions | null;
  orders: FilterOption[];
  shown: number;
  scanned?: number | null;
  loading: boolean;
  orderLabel: string;
  neutralityNote: string | null;
  selfReportedNote?: string | null;
  labels: CreatorFilterLabels | null;
  notes: CreatorResultsNotes | null;
  ready: boolean;
  aside?: ReactNode;
}) {
  const set = (patch: Partial<FindFilters>) => onChange({ ...f, ...patch });

  const [draft, setDraft] = useState(f.keyword);
  useEffect(() => setDraft(f.keyword), [f.keyword]);
  useEffect(() => {
    if (draft === f.keyword) return;
    const t = setTimeout(() => onChange({ ...f, keyword: draft }), 250);
    return () => clearTimeout(t);
  }, [draft, f, onChange]);

  const [nichesOpen, setNichesOpen] = useState(false);
  const kwBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!nichesOpen) return;
    const onDown = (e: MouseEvent) => {
      if (kwBox.current && !kwBox.current.contains(e.target as Node)) setNichesOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [nichesOpen]);

  const toggleNiche = (n: string) => set({ niches: f.niches.includes(n) ? f.niches.filter((x) => x !== n) : [...f.niches, n] });
  const nicheLabel = (n: string) => labelOf(options?.niches ?? [], n) ?? n;
  const platformLabel = f.platform ? (labelOf(options?.platforms ?? [], f.platform) ?? f.platform) : (labels?.platforms.any ?? "");
  const word = (text: string | undefined, w: string) =>
    text ?? (ready ? "" : <span aria-hidden="true" className={`${bone} inline-block h-3 ${w} rounded-full align-middle`} />);
  const any = activeCount(f) > 0;
  const runSearch = () => {
    onChange({ ...f, keyword: draft });
    setNichesOpen(false);
  };

  return (
    <div className="mt-4">
      {}
      <div className="flex flex-col gap-1 rounded-[22px] border border-rule bg-cream p-1.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] sm:flex-row sm:items-stretch">
        <Pop
          active={false}
          wide
          trigger="flex h-full min-h-12 w-full cursor-pointer items-center justify-between gap-3 rounded-2xl px-3.5 py-1.5 text-ink hover:bg-bone/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 sm:w-56"
          label={
            <span className="flex min-w-0 flex-col items-start text-left">
              <span className="text-[12px] font-semibold text-ink">{word(labels?.platforms.name, "w-14")}</span>
              <span className="flex min-w-0 items-center gap-2 text-[14px] font-normal text-inkMuted">
                {f.platform ? <PlatformIcon platform={f.platform} /> : null}
                <span className="truncate">{f.platform ? platformLabel : word(labels?.platforms.any, "w-20")}</span>
              </span>
            </span>
          }
        >
          {(close) =>
            !options ? (
              <div aria-hidden="true" className="grid grid-cols-3 gap-2 p-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} className={`${bone} h-[62px] rounded-xl`} />
                ))}
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-3 gap-2 p-1">
                  {options.platforms.map((p) => {
                    const on = f.platform === p.value;
                    return (
                      <button
                        key={p.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          set({ platform: on ? null : p.value });
                          close();
                        }}
                        className={`flex flex-col items-center gap-2 rounded-cta border px-2 py-2.5 text-[13px] font-medium text-ink transition-colors ${on ? "border-ink bg-bone" : "border-rule hover:bg-bone"}`}
                      >
                        <PlatformIcon platform={p.value} className="size-7 rounded-lg" />
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    set({ platform: null });
                    close();
                  }}
                  className="mt-1 w-full rounded-cta border border-rule bg-bone px-3 py-2 text-[13px] font-medium text-ink hover:opacity-80"
                >
                  {labels?.platforms.any}
                </button>
              </div>
            )
          }
        </Pop>

        <span aria-hidden="true" className="mx-1 hidden w-px self-stretch bg-rule sm:block" />

        <div ref={kwBox} className="relative min-w-0 flex-1">
          <label className="flex h-full flex-col justify-center rounded-2xl px-3.5 py-1.5 focus-within:bg-bone/60">
            <span className="text-[12px] font-semibold text-ink">{word(labels?.keyword.name, "w-24")}</span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setNichesOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) runSearch();
                if (e.key === "Escape" && nichesOpen) {
                  e.stopPropagation();
                  setNichesOpen(false);
                }
              }}
              placeholder={labels?.keyword.placeholder ?? ""}
              aria-label={labels?.keyword.name ?? "Search creators"}
              className="w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-inkMuted"
            />
          </label>
          {nichesOpen && (options?.niches.length ?? 1) > 0 && (
            <div className="absolute top-full right-0 left-0 z-30 mt-2 rounded-2xl border border-rule bg-cream p-3 shadow-elev">
              <p className="px-1 text-[12px] font-semibold text-inkMuted">{word(labels?.niches.name, "w-12")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {!options
                  ? [0, 1, 2, 3, 4, 5].map((i) => <span key={i} aria-hidden="true" className={`${bone} h-8 w-20 rounded-lg`} />)
                  : options.niches.map((n) => {
                      const on = f.niches.includes(n.value);
                      return (
                        <button
                          key={n.value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleNiche(n.value)}
                          className={`inline-flex items-center gap-1 rounded-cta px-2.5 py-1.5 text-[13px] font-medium transition-colors ${on ? "bg-ink text-cream" : "bg-bone text-ink hover:opacity-80"}`}
                        >
                          {on ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                          {n.label}
                        </button>
                      );
                    })}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label={loading ? "Searching" : "Search"}
          disabled={loading}
          onClick={runSearch}
          className="flex size-12 shrink-0 cursor-pointer items-center justify-center self-center rounded-full bg-ink text-cream transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40 compact:w-full"
        >
          <Search className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {}
      {!options || !labels ? (
        !ready && (
        <div aria-hidden="true" className="mt-3 flex flex-wrap items-center gap-2">
          {["w-32", "w-20", "w-24", "w-28", "w-24", "w-28"].map((w, i) => (
            <span key={i} className={`${bone} h-9 ${w} rounded-full`} />
          ))}
        </div>
        )
      ) : (
        <div role="group" aria-label="Filters" className="mt-3 flex flex-wrap items-center gap-2">
          <ListPill name={labels.lanes.name} anyLabel={labels.lanes.any} list={options.lanes} value={f.lane} onPick={(v) => set({ lane: v })} />
          <ListPill
            name={labels.max_price_cents.name}
            anyLabel={labels.max_price_cents.any}
            list={options.max_price_cents}
            value={f.maxPriceCents}
            onPick={(v) => set({ maxPriceCents: v })}
          />
          <ListPill
            name={labels.max_delivery_days.name}
            anyLabel={labels.max_delivery_days.any}
            list={options.max_delivery_days}
            value={f.maxDeliveryDays}
            onPick={(v) => set({ maxDeliveryDays: v })}
          />
          <ListPill
            name={labels.min_followers.name}
            anyLabel={labels.min_followers.any}
            note={labels.min_followers.note}
            list={options.min_followers}
            value={f.minFollowers}
            onPick={(v) => set({ minFollowers: v })}
          />
          <ListPill name={labels.countries.name} anyLabel={labels.countries.any} list={options.countries} value={f.country} onPick={(v) => set({ country: v })} scroll />
          {orders.length > 0 ? (
            <Pop active={false} label={labelOf(orders, f.order) ?? (orderLabel || labels.order.name)}>
              {(close) => (
                <>
                  {orders.map((o) => (
                    <Option
                      key={o.value}
                      on={f.order === o.value}
                      onPick={() => {
                        set({ order: o.value as Order });
                        close();
                      }}
                    >
                      {o.label}
                    </Option>
                  ))}
                </>
              )}
            </Pop>
          ) : null}
          {any ? (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                onChange({ ...NO_FILTERS, order: f.order });
              }}
              className="ml-1 cursor-pointer text-[14px] font-medium text-ink underline underline-offset-2 hover:text-inkMuted"
            >
              Clear all
            </button>
          ) : null}
        </div>
      )}

      {}
      {f.niches.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {f.niches.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => toggleNiche(n)}
              aria-label={`Remove ${nicheLabel(n)}`}
              className="inline-flex items-center gap-1 rounded-full bg-bone px-2.5 py-1 text-[13px] font-medium text-ink hover:opacity-80"
            >
              {nicheLabel(n)}
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}

      {}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        {loading ? (
          <span role="status" className="flex items-center">
            <span className="sr-only">Searching creators.</span>
            <span aria-hidden="true" className={`${bone} h-3.5 w-64 max-w-full rounded-full`} />
          </span>
        ) : (
          <div className="flex items-center gap-2 text-[13px] text-inkMuted">
            <p aria-live="polite">
              {[
                `${shown} ${shown === 1 ? "creator" : "creators"}${scanned !== null ? ` in the first ${scanned} loaded` : ""}`,
                orderLabel,
                notes?.summary,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <AboutResults
              notes={[
                neutralityNote,
                selfReportedNote ? `Follower numbers: ${selfReportedNote}` : null,
                notes?.fee ?? null,
              ]}
            />
          </div>
        )}
        {aside && <p className="text-[13px] text-inkMuted">{aside}</p>}
      </div>
    </div>
  );
}
