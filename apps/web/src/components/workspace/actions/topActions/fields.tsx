"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { TopActionField } from "../platformSpec";
import { usePlaceSearch, type AdPlace } from "../AdLocations";
import { MField, Tiles, m } from "./ActionModal";
import { CountriesField, areCountryCodes, countryCodesOf } from "./CountriesField";
import { FindPinterestBoard, NewPinterestBoard, type PinterestBoardOption } from "../PinterestBoardTools";
import { currencySymbol, readTopActionContext } from "./api";

export type TopActionContext = { currency?: string; credits?: number } & Record<string, unknown>;

const HTTPS = /^https:\/\/\S+\.\S+/i;

type Place = { id: string; name: string };

const selectedIds = (raw: string): string[] => {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
  } catch { return []; }
};
type Option = { id: string; label: string };

function mergeOptions(have: unknown, extra: readonly Option[]): Option[] {
  const list = Array.isArray(have) ? (have as Option[]) : [];
  return [...list, ...extra.filter((o) => !list.some((h) => h.id === o.id))];
}

function placesOf(raw: string): Place[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((p): p is Place => !!p && typeof p.id === "string" && typeof p.name === "string") : [];
  } catch {
    return [];
  }
}

function valueOf(f: TopActionField, raw: string): unknown {
  if (f.kind === "multi_select") return selectedIds(raw);
  if (f.kind === "money") return raw.trim() === "" && f.optional ? undefined : Number(raw);
  if (f.kind === "countries") return countryCodesOf(raw).join(", ") || undefined;
  if (f.kind === "places") return placesOf(raw).length || !f.optional ? placesOf(raw) : undefined;
  if (f.kind === "choice" || f.kind === "select" || f.kind === "video" || f.kind === "image") return raw;
  const t = raw.trim();
  return t === "" && f.optional ? undefined : t;
}

export function isYoutubeVideoLink(raw: string): boolean {
  return /^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/)|youtu\.be\/)[A-Za-z0-9_-]{11}(?:[?&#/].*)?$/.test(raw.trim());
}

export function areXPostLinks(raw: string): boolean {
  const parts = raw.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  const ok = (p: string) => /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/[0-9]{1,25}(?:[/?#].*)?$/i.test(p) || /^[0-9]{1,25}$/.test(p);
  return parts.length >= 1 && parts.length <= 10 && parts.every(ok);
}

export function isSubreddit(raw: string): boolean {
  return /^(?:https:\/\/(?:www\.|old\.)?reddit\.com)?\/?(?:r\/)?[A-Za-z0-9_]{2,21}\/?$/i.test(raw.trim());
}

const ACCEPTS = { youtube_video: isYoutubeVideoLink, x_posts: areXPostLinks, subreddit: isSubreddit } as const;

function errorOf(f: TopActionField, raw: string, values: Record<string, string>): string | null {
  const t = raw.trim();
  if ((f.kind === "text" || f.kind === "area" || f.kind === "url") && f.accepts && t && !ACCEPTS[f.accepts](t)) {
    return f.error ?? "Check this field.";
  }
  switch (f.kind) {
    case "multi_select":
      return selectedIds(raw).length > f.max ? `Pick up to ${f.max}.` : null;
    case "text":
    case "area":
      if (!t && !f.optional) return f.error ?? `Enter ${f.label.toLowerCase()}.`;
      return f.max && (f.measure ? f.measure(t) : t.length) > f.max ? `Keep it under ${f.max} characters.` : null;
    case "url":
      if (!t && f.optional) return null;
      return HTTPS.test(t) ? null : (f.error ?? "Enter a full link that starts with https:// (for example https://yoursite.com/offer).");
    case "money": {
      if (raw.trim() === "" && f.optional) return null;
      const n = Number(raw);
      const ok = raw.trim() !== "" && Number.isFinite(n) && (f.atLeast !== undefined ? n >= f.atLeast : n > (f.above ?? 0));
      if (ok) return null;
      return f.error ?? (f.atLeast !== undefined ? `Enter at least ${f.atLeast}.` : `Enter a ${f.label.toLowerCase()} above ${f.above ?? 0}.`);
    }
    case "select":
      return t ? null : `Pick ${f.label.toLowerCase()}.`;
    case "places":
      if (!placesOf(raw).length) return f.optional ? null : "Pick at least one place.";
      return f.notIn && placesOf(raw).some((p) => placesOf(values[f.notIn!] ?? "").some((q) => q.id === p.id)) ? "A place cannot be in both lists." : null;
    case "video":
      return t ? null : f.uploadOnly ? "Upload a video." : "Pick a video or upload one.";
    case "image":
      return t ? null : "Add an image.";
    case "countries":
      if (!t) return f.optional ? null : "Pick at least one country.";
      if (!areCountryCodes(t)) return "Pick countries from the list.";
      return f.notIn && countryCodesOf(t).some((c) => countryCodesOf(values[f.notIn!] ?? "").includes(c)) ? "A country cannot be in both lists." : null;
    case "choice":
      return null;
  }
}

function initialOf(f: TopActionField): string {
  if (f.kind === "money") return f.initial ?? "";
  if (f.kind === "choice") return f.initial;
  return "";
}

const readsContext = (f: TopActionField) =>
  f.kind === "money" ||
  f.kind === "select" ||
  (f.kind === "multi_select" && !!f.from) ||
  (f.kind === "places" && !!f.from) ||
  (f.kind === "video" && !f.uploadOnly) ||
  (f.kind === "url" && !!f.defaultFrom);

const defaultUrlOf = (f: TopActionField, ctx: TopActionContext): string | null => {
  if (f.kind !== "url" || !f.defaultFrom) return null;
  const v = ctx[f.defaultFrom];
  return typeof v === "string" && HTTPS.test(v) ? v : null;
};

export function useTopActionForm(slug: string, actionKey: string, fields: readonly TopActionField[] = [], readAlways = false) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, initialOf(f)])));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [context, setContext] = useState<TopActionContext>({});
  const [contextRead, setContextRead] = useState(false);
  const [contextFailed, setContextFailed] = useState(false);
  const alive = useRef(true);
  const added = useRef<Record<string, Option[]>>({});

  const needsContext = readAlways || fields.some(readsContext);
  useEffect(() => {
    alive.current = true;
    setContextFailed(false);
    if (!needsContext) {
      setContextRead(true);
      return () => {
        alive.current = false;
      };
    }
    readTopActionContext(slug, actionKey)
      .then((c) => {
        if (!alive.current) return;
        const ctx = (c ?? {}) as TopActionContext;
        setContext(ctx);
        setValues((cur) => {
          const next = { ...cur };
          for (const f of fields) {
            if (f.kind === "places" && f.from && !cur[f.name] && Array.isArray(ctx[f.from])) next[f.name] = JSON.stringify(ctx[f.from]);
            const site = defaultUrlOf(f, ctx);
            if (site && !cur[f.name]) next[f.name] = site;
          }
          return next;
        });
      })
      .catch(() => { if (alive.current) setContextFailed(true); })
      .finally(() => alive.current && setContextRead(true));
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, actionKey, needsContext]);

  const errors = Object.fromEntries(fields.map((f) => [f.name, errorOf(f, values[f.name] ?? "", values)]));
  const valid = fields.every((f) => !errors[f.name]);
  const inputs = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = valueOf(f, values[f.name] ?? "");
      if (v !== undefined) out[f.name] = v;
    }
    return out;
  };
  return {
    slug,
    values,
    set: (name: string, v: string) => setValues((s) => ({ ...s, [name]: v })),
    touch: (name: string) => setTouched((t) => (t[name] ? t : { ...t, [name]: true })),
    shownError: (name: string) => (touched[name] ? errors[name] : null),
    context,
    contextRead,
    contextFailed,
    valid,
    inputs,
    addOptions: (from: string, opts: readonly Option[]) => {
      added.current[from] = mergeOptions(added.current[from], opts);
      setContext((c) => ({ ...c, [from]: mergeOptions(c[from], opts) }));
    },
    reload: () =>
      readTopActionContext(slug, actionKey)
        .then((c) => {
          if (!alive.current) return;
          const ctx = { ...(c ?? {}) } as TopActionContext;
          for (const [from, opts] of Object.entries(added.current)) ctx[from] = mergeOptions(ctx[from], opts);
          setContext(ctx);
        })
        .catch(() => {}),
  };
}

export type TopActionForm = ReturnType<typeof useTopActionForm>;

export function TopActionFields({ fields = [], form, disabled }: { fields?: readonly TopActionField[]; form: TopActionForm; disabled: boolean }) {
  return (
    <>
      {fields.map((f) => {
        const id = `top-action-${f.name}`;
        const error = form.shownError(f.name);
        const aria = error ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};
        const common = {
          id,
          value: form.values[f.name] ?? "",
          disabled,
          onBlur: () => form.touch(f.name),
          ...aria,
        };
        if (f.kind === "choice") {
          return (
            <MField key={f.name} label={f.label}>
              <Tiles label={f.label} options={f.options} value={form.values[f.name] ?? f.initial} onChange={(v) => form.set(f.name, v)} disabled={disabled} />
            </MField>
          );
        }
        if (f.kind === "multi_select") {
          const options = f.options ?? (f.from && Array.isArray(form.context[f.from]) ? form.context[f.from] as Array<{ id: string; label: string }> : []);
          const selected = selectedIds(form.values[f.name] ?? "");
          const failed = !!f.from && form.contextRead && (form.contextFailed || form.context[`${f.from}_error`] === true);
          return (
            <MField key={f.name} label={f.label} htmlFor={id} hint={f.hint} error={error}>
              <div className="mb-2 flex flex-wrap gap-2">
                {selected.length === 0 && <span className={m.hint}>{f.allLabel}</span>}
                {selected.map((value) => (
                  <button key={value} type="button" className="rounded-full border border-[#e5e7eb] px-3 py-1 text-sm" disabled={disabled} aria-label={`Remove ${options.find((o) => o.id === value)?.label ?? value}`} onClick={() => form.set(f.name, JSON.stringify(selected.filter((v) => v !== value)))}>
                    {options.find((o) => o.id === value)?.label ?? value} ×
                  </button>
                ))}
              </div>
              <select id={id} className={m.input} value="" disabled={disabled || selected.length >= f.max || options.length === 0} onChange={(e) => {
                if (e.target.value) form.set(f.name, JSON.stringify([...selected, e.target.value]));
                form.touch(f.name);
              }}>
                <option value="">{f.from && !form.contextRead ? "Loading choices…" : `Choose ${f.label.toLowerCase()}`}</option>
                {options.filter((o) => !selected.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {failed && <p role="status" className={m.hint}>Language choices couldn't be loaded. Leave this empty for all languages, or reopen the form to try again.</p>}
            </MField>
          );
        }
        if (f.kind === "places") {
          return (
            <MField key={f.name} label={f.label} htmlFor={id} hint={f.hint} error={error}>
              <PlacesField
                id={id}
                slug={form.slug}
                max={f.max ?? 50}
                value={placesOf(form.values[f.name] ?? "")}
                taken={f.notIn ? placesOf(form.values[f.notIn] ?? "") : []}
                takenLabel={f.takenLabel ?? ""}
                placeholder={f.placeholder}
                disabled={disabled}
                onChange={(v) => { form.set(f.name, JSON.stringify(v)); form.touch(f.name); }}
              />
            </MField>
          );
        }
        if (f.kind === "countries") {
          return (
            <MField key={f.name} label={f.label} htmlFor={id} hint={f.hint} error={error}>
              <CountriesField
                id={id}
                value={form.values[f.name] ?? ""}
                taken={f.notIn ? form.values[f.notIn] ?? "" : ""}
                takenLabel={f.takenLabel ?? ""}
                placeholder={f.placeholder}
                disabled={disabled}
                invalid={!!error}
                describedBy={error ? `${id}-error` : undefined}
                onChange={(v) => form.set(f.name, v)}
                onBlur={() => form.touch(f.name)}
              />
            </MField>
          );
        }
        if (f.kind === "image") {
          return (
            <MField key={f.name} label={f.label} htmlFor={id} hint={f.hint} error={error}>
              <ImageField id={id} value={form.values[f.name] ?? ""} disabled={disabled} onChange={(v) => { form.set(f.name, v); form.touch(f.name); }} />
            </MField>
          );
        }
        if (f.kind === "video") {
          const options = Array.isArray(form.context[f.from]) ? (form.context[f.from] as Array<{ id: string; label: string }>) : [];
          return (
            <MField key={f.name} label={f.label} htmlFor={id} hint={f.hint} error={error}>
              <VideoField id={id} options={options} uploadOnly={f.uploadOnly === true} value={form.values[f.name] ?? ""} disabled={disabled} onChange={(v) => { form.set(f.name, v); form.touch(f.name); }} />
            </MField>
          );
        }
        if (f.kind === "select") {
          const options = Array.isArray(form.context[f.from]) ? (form.context[f.from] as Array<{ id: string; label: string }>) : [];
          const none = form.contextRead && options.length === 0;
          const failed = form.contextRead && form.context[`${f.from}_error`] === true;
          const partial = form.contextRead && form.context[`${f.from}_partial`] === true;
          const hint = failed
            ? f.unavailable ?? "Zavi couldn't load these right now. Try again in a minute."
            : none
              ? (form.context.connected === false && f.disconnected) || f.empty
              : partial && f.partial
                ? f.partial
                : f.hint;
          const boardTools = f.pinterestBoards === true && form.contextRead && form.context.connected !== false;
          const pick = (boards: PinterestBoardOption[]) => {
            form.addOptions(f.from, boards);
            if (boards.length === 1) {
              form.set(f.name, boards[0].id);
              form.touch(f.name);
            }
          };
          return (
            <MField key={f.name} label={f.label} htmlFor={id} hint={hint} error={error}>
              <select {...common} className={`${m.input} cursor-pointer`} onChange={(e) => form.set(f.name, e.target.value)} disabled={disabled || none}>
                <option value="">{form.contextRead ? "Choose one" : "Loading…"}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              {boardTools ? (
                <div className="mt-2 flex flex-col items-start">
                  {partial ? <FindPinterestBoard disabled={disabled} onFound={pick} /> : null}
                  <div className="mt-2">
                    <NewPinterestBoard
                      disabled={disabled}
                      onCreated={(b) => {
                        pick([b]);
                        void form.reload();
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </MField>
          );
        }
        if (f.kind === "money") {
          const code = form.context.currency;
          const symbol = currencySymbol(code);
          const hint = f.hint?.replace("{currency}", code ? ` (${code})` : "");
          return (
            <MField key={f.name} label={f.label} htmlFor={id} hint={hint} error={error}>
              <div className={`${m.input} flex max-w-[220px] items-center gap-1`}>
                {symbol && <span className="text-[#8a8a8a]">{symbol}</span>}
                <input
                  {...common}
                  inputMode="decimal"
                  onChange={(e) => form.set(f.name, e.target.value.replace(/[^0-9.]/g, ""))}
                  className="w-full min-w-0 bg-transparent outline-none"
                />
                {f.perDay && <span className="whitespace-nowrap text-[#8a8a8a]">/ day</span>}
              </div>
            </MField>
          );
        }
        if (f.kind === "area") {
          return (
            <MField key={f.name} label={f.label} htmlFor={id} hint={f.hint} error={error}>
              <textarea
                {...common}
                rows={4}
                placeholder={f.placeholder}
                onChange={(e) => {
                  form.set(f.name, e.target.value);
                  if (f.max && e.target.value.trim().length > f.max) form.touch(f.name);
                }}
                className={`${m.input} h-auto py-3 leading-[1.4]`}
              />
              {f.max ? <AreaCounter n={(form.values[f.name] ?? "").trim().length} cap={f.max} /> : null}
            </MField>
          );
        }
        const site = defaultUrlOf(f, form.context);
        if (site) {
          return (
            <DefaultLinkField
              key={f.name}
              id={id}
              label={f.label}
              site={site}
              value={form.values[f.name] ?? ""}
              error={error}
              disabled={disabled}
              onChange={(v) => form.set(f.name, v)}
              onBlur={() => form.touch(f.name)}
            />
          );
        }
        return (
          <MField key={f.name} label={f.label} htmlFor={id} hint={f.hint} error={error}>
            <input
              {...common}
              className={m.input}
              maxLength={f.measure ? undefined : f.max}
              placeholder={f.placeholder ?? (f.kind === "url" ? "https://" : undefined)}
              inputMode={f.kind === "url" ? "url" : undefined}
              onChange={(e) => form.set(f.name, e.target.value)}
            />
          </MField>
        );
      })}
    </>
  );
}

function AreaCounter({ n, cap }: { n: number; cap: number }) {
  const over = n > cap;
  return (
    <p className={`mt-1 text-right text-[11px] tabular-nums ${over ? "font-medium text-[#b4232a]" : "text-[#8a8a8a]"}`}>
      {n} / {cap}
    </p>
  );
}

function DefaultLinkField({
  id,
  label,
  site,
  value,
  error,
  disabled,
  onChange,
  onBlur,
}: {
  id: string;
  label: string;
  site: string;
  value: string;
  error: string | null;
  disabled: boolean;
  onChange: (v: string) => void;
  onBlur: () => void;
}) {
  const [custom, setCustom] = useState(value !== "" && value !== site);
  if (!custom) {
    return (
      <MField label={label} hint="People land on your published website.">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[#e5e7eb] px-3.5 py-3">
          <span data-testid={`${id}-site`} className="min-w-0 truncate text-[14px] text-[#0e0f11]">
            {site}
          </span>
          <button
            type="button"
            className="shrink-0 text-[13px] font-medium text-[#595959] underline-offset-2 hover:underline disabled:opacity-50"
            disabled={disabled}
            onClick={() => {
              setCustom(true);
              onChange("");
            }}
          >
            Use a different link
          </button>
        </div>
      </MField>
    );
  }
  return (
    <MField
      label={label}
      htmlFor={id}
      hint="Where people land when they tap it. Starts with https://"
      error={error}
    >
      <input
        id={id}
        value={value}
        disabled={disabled}
        onBlur={onBlur}
        className={m.input}
        placeholder="https://"
        inputMode="url"
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="mt-2 text-[13px] font-medium text-[#595959] underline-offset-2 hover:underline disabled:opacity-50"
        disabled={disabled}
        onClick={() => {
          setCustom(false);
          onChange(site);
        }}
      >
        Use my website
      </button>
    </MField>
  );
}

export function PlacesField({
  id,
  slug,
  max,
  value,
  taken = [],
  takenLabel = "",
  placeholder,
  disabled,
  onChange,
  advertiserId,
}: {
  id: string;
  slug: string;
  max: number;
  value: Place[];
  taken?: Place[];
  takenLabel?: string;
  placeholder?: string;
  disabled: boolean;
  onChange: (v: Place[]) => void;
  advertiserId?: string;
}) {
  const [q, setQ] = useState("");
  const { results, searching, problem } = usePlaceSearch(slug, q, advertiserId);
  const shown = results.filter((p: AdPlace) => !value.some((v) => v.id === p.id)).slice(0, 6);
  const searched = q.trim().length >= 2 && !searching;
  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2" data-testid="top-action-places">
          {value.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e7eb] bg-[#fbfaf7] px-3 py-1 text-[13px] text-[#1f1f1f]">
              {p.name}
              <button type="button" aria-label={`Remove ${p.name}`} disabled={disabled} onClick={() => onChange(value.filter((x) => x.id !== p.id))} className="text-[#8a8a8a] hover:text-[#1f1f1f]">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input id={id} className={m.input} value={q} disabled={disabled} placeholder={placeholder ?? "Add a city, region or country"} onChange={(e) => setQ(e.target.value)} />
      {searching && <p className={m.hint}>Searching…</p>}
      {searched && problem && (
        <p role="alert" className={m.hint}>
          {problem}
        </p>
      )}
      {searched && !problem && results.length === 0 && <p className={m.hint}>No places found for “{q.trim()}”. Try another spelling, or a larger area.</p>}
      {shown.length > 0 && (
        <div role="listbox" aria-label="Places" className="mt-2 overflow-hidden rounded-xl border border-[#e5e7eb]">
          {shown.map((p) => {
            const off = taken.some((t) => t.id === p.id);
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={false}
                aria-disabled={off || undefined}
                disabled={disabled || off || value.length >= max}
                onClick={() => {
                  onChange([...value, { id: p.id, name: p.name }]);
                  setQ("");
                }}
                className={`flex w-full items-center gap-2.5 border-b border-[#f0ede5] px-3.5 py-2.5 text-left text-[14px] last:border-b-0 ${off ? "cursor-default text-[#a8a8a8]" : "text-[#1f1f1f] hover:bg-[#fbfaf7]"}`}
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="text-[12px] text-[#8a8a8a]">{off ? takenLabel : p.kind}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

function videoSize(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      const done = (r: { w: number; h: number } | null) => {
        URL.revokeObjectURL(url);
        resolve(r);
      };
      const t = window.setTimeout(() => done(null), 4000);
      v.preload = "metadata";
      v.onloadedmetadata = () => {
        window.clearTimeout(t);
        done(v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : null);
      };
      v.onerror = () => {
        window.clearTimeout(t);
        done(null);
      };
      v.src = url;
    } catch {
      resolve(null);
    }
  });
}

export function videoFileProblem(file: { type: string; size: number }, size: { w: number; h: number } | null): string | null {
  if (file.type !== "video/mp4") return "Upload an MP4 video.";
  if (file.size > VIDEO_MAX_BYTES) return "The video must be 50 MB or smaller.";
  if (size && Math.abs(size.w / size.h - 9 / 16) > 0.02) return "The video must be vertical, 9:16 (for example 1080x1920).";
  return null;
}

export function VideoField({ id, options, value, disabled, onChange, uploadOnly = false, onBusyChange }: { id: string; options: Array<{ id: string; label: string }>; value: string; disabled: boolean; onChange: (v: string) => void; uploadOnly?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  useEffect(() => { onBusyChange?.(uploading); }, [uploading, onBusyChange]);
  async function upload(file: File) {
    setProblem(null);
    setUploading(true);
    const bad = videoFileProblem(file, uploadOnly ? null : await videoSize(file));
    if (bad) {
      setProblem(bad);
      setUploading(false);
      return;
    }
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch("/api/chat/upload-video", { method: "POST", body: form, retryOnNetworkError: false });
      const body = (await res.json().catch(() => ({}))) as { video_path?: string; error?: { message?: string } };
      if (!res.ok || !body.video_path) throw new Error(body.error?.message ?? "The upload did not finish.");
      setUploaded(file.name);
      onChange(uploadOnly ? body.video_path : `upload:${body.video_path}`);
    } catch (e) {
      setProblem(`${(e as Error).message} Try again.`);
    } finally {
      setUploading(false);
    }
  }
  const hasUpload = uploadOnly ? value !== "" : value.startsWith("upload:");
  return (
    <div className="flex flex-col gap-2">
      {!uploadOnly && (
        <select id={id} className={`${m.input} cursor-pointer`} value={value.startsWith("zavi:") ? value : ""} disabled={disabled || uploading} onChange={(e) => onChange(e.target.value)}>
          <option value="">{options.length ? "Pick a video Zavi made" : "Zavi has made no video for you yet"}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <label className="text-[13px] text-[#595959]">
        {uploadOnly ? "An MP4, up to 50 MB:" : "Or upload a vertical 9:16 MP4 (5 to 60 seconds, up to 50 MB):"}
        <input
          {...(uploadOnly ? { id } : {})}
          type="file"
          accept="video/mp4"
          aria-label="Upload a video"
          disabled={disabled || uploading}
          className="mt-1.5 block text-[13px]"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </label>
      {uploading && <p className={m.hint}>Uploading…</p>}
      {uploaded && hasUpload && <p className={m.hint}>Using {uploaded}.</p>}
      {problem && (
        <p role="alert" className="text-[13px] leading-5 text-[#b4232a]">
          {problem}
        </p>
      )}
    </div>
  );
}

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export function imageFileProblem(file: { type: string; size: number }): string | null {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return "Use a JPG, PNG or WebP image.";
  if (file.size > IMAGE_MAX_BYTES) return "The image must be 5 MB or smaller.";
  return null;
}

const IMAGE_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/;

function ImageField({ id, value, disabled, onChange }: { id: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  async function upload(file: File) {
    setUploaded(null);
    setPreview(null);
    onChange("");
    setProblem(null);
    const bad = imageFileProblem(file);
    if (bad) {
      setProblem(bad);
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch("/api/chat/upload-image", { method: "POST", body: form, retryOnNetworkError: false });
      const body = (await res.json().catch(() => ({}))) as { image_path?: string; error?: { message?: string } };
      if (!res.ok || !body.image_path || !IMAGE_PATH.test(body.image_path)) throw new Error(body.error?.message ? "That image could not be used. Try a different file." : "The upload did not finish.");
      setUploaded(file.name);
      setPreview(typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null);
      onChange(body.image_path);
    } catch (e) {
      setProblem(`${(e as Error).message} Try again.`);
    } finally {
      setUploading(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[13px] text-[#595959]">
        A JPG, PNG or WebP, up to 5 MB:
        <input
          id={id}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Upload an image"
          disabled={disabled || uploading}
          className="mt-1.5 block text-[13px]"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </label>
      {uploading && <p className={m.hint}>Uploading…</p>}
      {uploaded && value && preview && (
        <img src={preview} alt={`Preview of ${uploaded}`} className="max-h-48 w-auto self-start rounded-xl border border-[#e5e7eb] object-contain" />
      )}
      {uploaded && value && <p className={m.hint}>Using {uploaded}.</p>}
      {problem && (
        <p role="alert" className="text-[13px] leading-5 text-[#b4232a]">
          {problem}
        </p>
      )}
    </div>
  );
}
