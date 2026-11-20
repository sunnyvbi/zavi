"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { settingsFieldUnit, writesElsewhere } from "@zavi/shared";
import { apiFetch } from "@/lib/api";
import { readChannelCacheEntry, writeChannelCache } from "@/lib/workspace/channelReadCache";
import { sharedJson } from "@/lib/workspace/sharedRead";
import { CHANNEL_SETTINGS_CHANGED_EVENT } from "@/lib/workspace/onTabReturn";
import { isMember } from "@/lib/members";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { cx, FOCUS_RING } from "./shared";
import { ChannelSettingsSkeleton } from "./ChannelSettingsSkeleton";
import { parseAmount } from "./moneyInput";
import { isSubreddit } from "../actions/topActions/fields";
import { cardButton } from "../actions/card/styles";
import type { PlatformSpec, SettingsField } from "../actions/types";
import { AmountInput, amountAffixes } from "../actions/AmountInput";

export type ChannelTabKey = "studio" | "library" | "overview" | "analytics" | "settings";

export function channelTabs(
  platform: PlatformSpec,
  extras = false,
  analytics = false,
): ReadonlyArray<readonly [ChannelTabKey, string]> {
  if (platform.studio) return [["studio", "Overview"], ["library", "Library"]];
  const tabs: Array<readonly [ChannelTabKey, string]> = [["overview", "Overview"]];
  if (analytics || platform.paidAnalytics) tabs.push(["analytics", "Analytics"]);
  if (platform.settings?.length || extras) tabs.push(["settings", "Settings"]);
  return tabs;
}

type Item = {
  id?: string;
  item: string;
  item_type?: string | null;
  status?: "suggested" | "tracking" | "paused" | "dismissed" | null;
  position?: number | null;
  note?: string | null;
  detail?: string | null;
  origin?: "suggested" | "custom" | null;
  stats?: Record<string, number | string | null> | null;
};

type FieldsMap = Record<string, Item[]>;

const STATUS_LABEL: Record<string, string> = {
  tracking: "tracking",
  paused: "paused",
  suggested: "suggested",
  dismissed: "dismissed",
};

const PAUSABLE = new Set(["tracking", "paused"]);

const SCROLL_AFTER_ROWS = 8;

const itemKey = (item: string) => item.trim().toLowerCase();
const communityKey = (item: string) =>
  itemKey(item)
    .replace(/^https:\/\/(?:www\.|old\.)?reddit\.com\//, "")
    .replace(/^\/?r\//, "")
    .replace(/\/+$/, "");
const itemKeyFor = (slug: string, id: string) =>
  slug === "reddit_organic" && id === "communities" ? communityKey : itemKey;
const itemKeys = (rows: readonly Item[], key: (item: string) => string = itemKey) =>
  new Set(rows.map((r) => key(r.item)));
const checkCommunity = (term: string) => (isSubreddit(term) ? null : "Enter a community like r/smallbusiness.");
async function postItem(path: string, body: unknown): Promise<string | null> {
  try {
    const res = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const err = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    const message = typeof err?.message === "string" && err.message.trim() ? err.message : null;
    if (res.status === 409) return err?.error !== "already_exists" && message ? message : "Already saved.";
    if (res.status === 403) return message ?? "Only an owner or an admin can change this.";
    if (res.status === 400) return "That doesn't look right. Check the value and try again.";
    return "Couldn't save that. Try again in a moment.";
  } catch {
    return "Couldn't reach Zavi. Check your connection.";
  }
}

const ITEM_ROUTES: Record<string, string> = {
  keywords: "/api/reddit/workspace/keywords",
  competitors: "/api/reddit/workspace/competitors",
};
const errorMessage = (body: { error?: unknown; message?: unknown } | null): string | null => {
  const err = body?.error;
  const nested = err && typeof err === "object" ? (err as { message?: unknown }).message : undefined;
  if (typeof nested === "string" && nested) return nested;
  return typeof body?.message === "string" && body.message ? body.message : null;
};

type SettingsRead = { fields?: FieldsMap; prefill?: FieldsMap };
const settingsCacheKey = (slug: string) => `channel-settings:${slug}`;

const settingsSaves = new Map<string, number>();

async function readSettings(slug: string, fresh: boolean): Promise<SettingsRead | null> {
  const savesAtStart = settingsSaves.get(slug) ?? 0;
  const body = await sharedJson<SettingsRead>(`/api/channels/${slug}/settings`, { fresh });
  if (body && (settingsSaves.get(slug) ?? 0) === savesAtStart) writeChannelCache(settingsCacheKey(slug), body);
  return body;
}

function rememberSavedField(slug: string, id: string, saved: Item[]): void {
  settingsSaves.set(slug, (settingsSaves.get(slug) ?? 0) + 1);
  const cached = readChannelCacheEntry<SettingsRead>(settingsCacheKey(slug));
  if (!cached) return;
  writeChannelCache(settingsCacheKey(slug), {
    ...cached.data,
    fields: { ...(cached.data.fields ?? {}), [id]: saved },
  });
}

export function prefetchChannelSettings(slug: string): void {
  void readSettings(slug, false);
}

async function readLatest(slug: string): Promise<FieldsMap | null> {
  try {
    const res = await apiFetch(`/api/channels/${slug}/settings`);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { fields?: FieldsMap } | null;
    return body?.fields ?? null;
  } catch {
    return null;
  }
}

export function withArrivals(
  edited: readonly Item[],
  server: readonly Item[] | undefined,
  loadedKeys: ReadonlySet<string> | undefined,
  key: (item: string) => string = itemKey,
): Item[] {
  if (!server || !loadedKeys) return [...edited];
  const editedKeys = itemKeys(edited, key);
  const arrived = server.filter((r) => !loadedKeys.has(key(r.item)) && !editedKeys.has(key(r.item)));
  return [...edited, ...arrived];
}

const STATUS_PILL = "shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-semibold w-20 text-center";

const statusTone = (status: string) =>
  status === "tracking"
    ? "bg-successBg text-success"
    : status === "suggested"
      ? "bg-warnBg text-warn"
      : "bg-bone text-inkMuted";

const ELSEWHERE: Record<string, string> = {
  "channel.monthly_budget":
    "Saved with the channel's budget, where pacing reads it. Changing it here would make a second copy.",
};

const INPUT = `h-10 rounded-[10px] border border-rule bg-cream px-3 text-[16px] leading-5 text-ink sm:text-[14px] outline-none placeholder:text-inkLight focus:border-ink/40 disabled:cursor-not-allowed disabled:bg-creamDeep disabled:text-inkMuted ${FOCUS_RING}`;
const BTN = `inline-flex h-10 shrink-0 items-center justify-center rounded-cta border border-rule bg-cream px-3 text-[13px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`;

const BTN_PRIMARY_BARE = `inline-flex h-10 shrink-0 items-center justify-center rounded-cta bg-ink px-4 text-[13px] font-medium text-cream disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS_RING}`;
const BTN_ADD_BARE = `inline-flex h-9 shrink-0 items-center justify-center rounded-cta border border-ink bg-ink px-4 text-[13px] font-medium text-cream disabled:cursor-not-allowed disabled:border-rule disabled:bg-transparent disabled:text-inkLight ${FOCUS_RING}`;
const SAVE_BUTTON = `${cardButton.base} ${cardButton.primary} shrink-0 disabled:bg-ca-surface disabled:text-ca-secondary disabled:opacity-100`;
const BTN_QUIET = `inline-flex h-8 shrink-0 items-center justify-self-end rounded-md px-2 text-[13px] font-medium text-inkMuted ${FOCUS_RING}`;
const BTN_TEXT = `inline-flex h-8 shrink-0 items-center px-0 text-[13px] font-medium text-inkMuted underline underline-offset-2 ${FOCUS_RING}`;

const scalar = (rows: Item[] | undefined) => rows?.[0]?.item ?? "";

const statValue = (v: number | string | null | undefined): string | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString() : null;
  if (typeof v === "string") return v.trim() || null;
  return null;
};

const SETTINGS_OWNERS_ONLY = "Only a workspace owner or admin can change these settings.";

const unsavedDrafts = new Map<string, { values: FieldsMap; dirty: readonly string[]; loaded: Record<string, Set<string>> }>();

export function ChannelSettingsTab({
  slug,
  fields,
  bare = false,
}: {
  slug: string;
  fields: readonly SettingsField[];
  bare?: boolean;
}) {
  const workspace = useWorkspaceOptional();
  const viewOnly = isMember(workspace?.role ?? null);
  const draftKey = workspace?.tenantId ? `${workspace.tenantId}:${slug}` : null;
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [values, setValues] = useState<FieldsMap>({});
  const [dirty, setDirty] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [fresh, setFresh] = useState<readonly string[]>([]);
  const [offers, setOffers] = useState<FieldsMap>({});
  const readToken = useRef(0);
  const loaded = useRef<Record<string, Set<string>>>({});
  const editedDuringSave = useRef<Set<string> | null>(null);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const dirtyRef = useRef<readonly string[]>([]);
  dirtyRef.current = dirty;
  const valuesRef = useRef<FieldsMap>(values);
  valuesRef.current = values;

  const apply = useCallback((body: SettingsRead, keepIds: readonly string[]) => {
    const server = body.fields ?? {};
    for (const f of fieldsRef.current) {
      if (!keepIds.includes(f.id)) loaded.current[f.id] = itemKeys(server[f.id] ?? [], itemKeyFor(slug, f.id));
    }
    setValues((prev) => {
      const next = { ...server };
      for (const id of keepIds) if (Object.prototype.hasOwnProperty.call(prev, id)) next[id] = prev[id];
      return next;
    });
    setOffers(body.prefill ?? {});
  }, [slug]);

  const load = useCallback(async (keep: () => readonly string[] = () => [], fresh = true): Promise<boolean> => {
    const token = (readToken.current += 1);
    const body = await readSettings(slug, fresh);
    if (!body || token !== readToken.current) return false;
    apply(body, keep());
    return true;
  }, [slug, apply]);

  useEffect(() => {
    let live = true;
    const kept = draftKey ? unsavedDrafts.get(draftKey) : undefined;
    if (draftKey) unsavedDrafts.delete(draftKey);
    if (kept) loaded.current = { ...kept.loaded };
    const keptDirty = kept?.dirty ?? [];
    const cached = readChannelCacheEntry<SettingsRead>(settingsCacheKey(slug));
    setState(cached ? "ready" : "loading");
    setValues(kept?.values ?? {});
    setDirty(keptDirty);
    setNote(null);
    setFresh([]);
    setOffers({});
    if (cached) apply(cached.data, keptDirty);
    void load(() => [...new Set([...keptDirty, ...dirtyRef.current])], false).then((ok) => {
      if (live) setState(ok || cached ? "ready" : "unavailable");
    });
    return () => {
      live = false;
    };
  }, [load, apply, slug, draftKey]);

  useEffect(() => {
    const reread = () => {
      void load(() => dirtyRef.current, true).then((ok) => {
        if (ok) setState("ready");
      });
    };
    window.addEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, reread);
    return () => window.removeEventListener(CHANNEL_SETTINGS_CHANGED_EVENT, reread);
  }, [load]);

  useEffect(
    () => () => {
      const d = dirtyRef.current;
      if (!draftKey || d.length === 0) return;
      unsavedDrafts.set(draftKey, {
        values: Object.fromEntries(d.map((id) => [id, valuesRef.current[id] ?? []])),
        dirty: d,
        loaded: Object.fromEntries(d.flatMap((id) => (loaded.current[id] ? [[id, loaded.current[id]]] : []))),
      });
    },
    [draftKey],
  );

  useEffect(() => {
    if (dirty.length === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty.length]);

  useEffect(() => {
    if (!bare || note !== "Saved.") return;
    const t = setTimeout(() => setNote((n) => (n === "Saved." ? null : n)), 3000);
    return () => clearTimeout(t);
  }, [bare, note]);

  const edit = useCallback((id: string, next: Item[]) => {
    editedDuringSave.current?.add(id);
    setValues((v) => ({ ...v, [id]: next }));
    setDirty((d) => (d.includes(id) ? d : [...d, id]));
    setNote(null);
  }, []);

  const takeOffer = useCallback(
    (id: string, value: string) => {
      edit(id, [{ item: value }]);
      setNote("Filled in from your connected account. Save to keep it.");
    },
    [edit],
  );

  const save = useCallback(async () => {
    setSaving(true);
    setNote(null);
    const stillDirty: string[] = [];
    const reasons: string[] = [];
    editedDuringSave.current = new Set();
    let savedAny = false;
    const latest = await readLatest(slug);
    for (const id of dirty) {
      const field = fieldsRef.current.find((f) => f.id === id);
      let items = values[id] ?? [];
      if (field?.kind === "number" && items.length > 0) {
        const typed = scalar(items);
        const amount = parseAmount(typed, field.max);
        if (amount === null) {
          stillDirty.push(id);
          reasons.push(`${field.label}: Zavi can't read "${typed.trim()}" as an amount. Type a number like 12000. Your saved value has not changed.`);
          continue;
        }
        items = [{ ...items[0], item: amount }];
      }
      try {
        const res = await apiFetch(`/api/channels/${slug}/settings/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items:
              field?.kind === "list"
                ? withArrivals(items, latest?.[id], loaded.current[id], itemKeyFor(slug, id))
                : items,
          }),
        });
        if (!res.ok) {
          stillDirty.push(id);
          const reason = res.status === 403
            ? `${SETTINGS_OWNERS_ONLY} Your changes are still here.`
            : errorMessage((await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null);
          if (reason && !reasons.includes(reason)) reasons.push(reason);
          continue;
        }
        const body = (await res.json().catch(() => null)) as { fields?: FieldsMap } | null;
        const saved = body?.fields?.[id];
        if (saved) {
          savedAny = true;
          rememberSavedField(slug, id, saved);
          const editedWhileSaving = editedDuringSave.current.has(id);
          loaded.current[id] = itemKeys(editedWhileSaving ? values[id] ?? [] : saved, itemKeyFor(slug, id));
          if (!editedWhileSaving) setValues((v) => ({ ...v, [id]: saved }));
        }
      } catch {
        stillDirty.push(id);
      }
    }
    if (savedAny) void readSettings(slug, true);
    const failed = stillDirty.length;
    const newer = [...editedDuringSave.current].filter((id) => !stillDirty.includes(id));
    editedDuringSave.current = null;
    setSaving(false);
    setDirty([...stillDirty, ...newer]);
    setNote(
      failed > 0
        ? reasons.length > 0
          ? reasons.join(" ")
          : `${failed} of ${dirty.length} didn't save. Your changes are still here. Press Save to try again.`
        : newer.length > 0
          ? "Saved. You changed something while it saved; press Save again to keep that too."
          : bare
            ? "Saved."
            : "Saved. Applies on the next run.",
    );
  }, [bare, dirty, slug, values]);

  const suggest = useCallback(
    async (id: string, endpoint: string) => {
      setSuggesting(id);
      setNote(null);
      try {
        const res = await apiFetch(endpoint, { method: "POST" });
        const body = (await res.json().catch(() => null)) as
          | { keywords_added?: unknown; competitors_added?: unknown; error?: unknown; message?: unknown }
          | null;
        if (!res.ok) {
          setNote(errorMessage(body) ?? "Zavi couldn't draft suggestions right now. Try again in a minute.");
          return;
        }
        const counted = typeof body?.keywords_added === "number" || typeof body?.competitors_added === "number";
        const added =
          (typeof body?.keywords_added === "number" ? body.keywords_added : 0) +
          (typeof body?.competitors_added === "number" ? body.competitors_added : 0);
        let kept: readonly string[] = [];
        await load(() => (kept = dirtyRef.current));
        const filled = fields
          .filter((f) => f.kind === "list" && f.suggest === endpoint)
          .map((f) => f.id);
        const targets = [id, ...filled];
        setFresh((prev) => [...new Set([...prev, ...targets.filter((t) => !kept.includes(t))])]);
        setNote(
          counted && added === 0
            ? "Nothing new to suggest right now."
            : targets.some((t) => kept.includes(t))
              ? "Zavi added what it found to the fields you haven't changed. Save your changes, then press Suggest again to fill the rest."
              : "Zavi added what it found. Suggested rows are marked.",
        );
      } catch {
        setNote("Zavi couldn't draft suggestions right now. Try again in a minute.");
      } finally {
        setSuggesting(null);
      }
    },
    [fields, load],
  );

  const addItem = useCallback(
    async (id: string, term: string): Promise<string | null> => {
      const route = ITEM_ROUTES[id];
      if (!route) return "Couldn't save that. Try again in a moment.";
      const err = await postItem(route, id === "keywords" ? { term } : { name: term });
      if (err) return err;
      const latest = await readLatest(slug);
      const server = latest?.[id];
      if (server) {
        const key = itemKeyFor(slug, id);
        if (dirtyRef.current.includes(id)) {
          const added = server.find((r) => key(r.item) === key(term));
          setValues((v) => ({
            ...v,
            [id]: withArrivals(v[id] ?? [], server, loaded.current[id], key).map((r) => (added && key(r.item) === key(term) ? added : r)),
          }));
          loaded.current[id] = new Set([...(loaded.current[id] ?? []), ...itemKeys(server, key)]);
        } else {
          loaded.current[id] = itemKeys(server, key);
          setValues((v) => ({ ...v, [id]: server }));
        }
      }
      return null;
    },
    [slug],
  );

  const lead = bare ? null : (
    <div className="pt-1">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-inkMuted">Channel settings</h3>
      <p className="mt-1 max-w-[720px] text-[13px] leading-[18px] text-inkMuted">
        What this channel is pointed at. Changes apply on the next run.
      </p>
    </div>
  );

  if (state === "loading") {
    return <ChannelSettingsSkeleton fields={fields} lead={lead} />;
  }

  if (state === "unavailable") {
    return (
      <div className="mt-5 flex flex-col gap-5">
        {lead}
        <p className="rounded-2xl border border-rule bg-white p-4 text-[14px] leading-5 text-inkMuted">
          Settings for this channel aren&apos;t available yet. Nothing is lost. The channel keeps running on what it already has.
        </p>
      </div>
    );
  }

  const lists = fields.filter((f) => f.kind === "list");
  const rest = fields.filter((f) => f.kind !== "list");

  return (
    <div className={bare ? "flex flex-col gap-4" : "mt-5 flex flex-col gap-5"}>
      {lead}

      {viewOnly && (
        <p role="status" data-testid="settings-view-only" className="rounded-2xl border border-rule bg-white p-4 text-[14px] leading-5 text-inkMuted">
          {SETTINGS_OWNERS_ONLY} You can view them here.
        </p>
      )}

      {[...lists, ...rest].map((field) => (
        <SettingsFieldView
          key={field.id}
          locked={viewOnly}
          field={field}
          rows={values[field.id] ?? []}
          onEdit={edit}
          onSuggest={suggest}
          suggesting={suggesting === field.id}
          suggestionsFresh={fresh.includes(field.id)}
          offer={offerFor(offers[field.id])}
          onTakeOffer={takeOffer}
          onAdd={slug === "reddit_organic" && ITEM_ROUTES[field.id] ? addItem : undefined}
          check={slug === "reddit_organic" && field.id === "communities" ? checkCommunity : undefined}
          bare={bare}
          unit={settingsFieldUnit(slug, field.id)}
        />
      ))}

      {viewOnly ? null : bare ? (
        (dirty.length > 0 || note) && (
          <div data-testid="settings-save-bar" className="flex flex-wrap items-center justify-end gap-3 pt-3">
            <span className="min-w-0 text-[13px] leading-[18px] text-inkMuted">
              {note ?? "Unsaved changes"}
            </span>
            {(dirty.length > 0 || saving) && (
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || dirty.length === 0}
                className={BTN_PRIMARY_BARE}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        )
      ) : (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rule bg-white px-4 py-3 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]">
          <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] leading-[18px] text-inkMuted">
            {dirty.length > 0 && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-marigoldDeep" />}
            {note ??
              (dirty.length > 0
                ? "You have unsaved changes."
                : "Applies on the next run. Nothing changes in your account until you approve an action.")}
          </span>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || dirty.length === 0}
            className={SAVE_BUTTON}
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      )}
    </div>
  );
}

function offerFor(rows: Item[] | undefined): string | null {
  const value = rows?.[0]?.item;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function SettingsFieldView({
  field,
  rows,
  onEdit,
  onSuggest,
  suggesting,
  suggestionsFresh,
  offer,
  onTakeOffer,
  onAdd,
  check,
  bare = false,
  unit = null,
  locked = false,
}: {
  locked?: boolean;
  field: SettingsField;
  rows: Item[];
  onEdit: (id: string, next: Item[]) => void;
  onSuggest: (id: string, endpoint: string) => void;
  suggesting: boolean;
  suggestionsFresh: boolean;
  offer: string | null;
  onTakeOffer: (id: string, value: string) => void;
  onAdd?: (id: string, term: string) => Promise<string | null>;
  check?: (term: string) => string | null;
  bare?: boolean;
  unit?: "USD" | null;
}) {
  const [draft, setDraft] = useState("");
  const [addNote, setAddNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const elsewhere = writesElsewhere(field.id) || Boolean(field.writesTo);
  const readOnly = locked || elsewhere;
  const suggestUrl = field.kind === "list" ? field.suggest : undefined;
  const statCols = field.kind === "list" ? field.stats : undefined;
  const typeOptions = field.kind === "list" ? field.itemTypeOptions : undefined;
  const itemTypes = field.kind === "list" && !typeOptions ? field.itemTypes : undefined;
  const pausable = field.kind !== "list" || field.pausable !== false;
  const addPlaceholder = field.kind === "list" ? field.placeholder : undefined;
  const showSuggested = !suggestUrl || suggestionsFresh;
  const shown = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => showSuggested || row.status !== "suggested");

  return (
    <section className={bare ? "" : "rounded-2xl border border-rule bg-white p-4"}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {bare ? (
            <h3 className="text-[15px] font-semibold text-ink">{field.label}</h3>
          ) : (
            <h4 className="text-[16px] font-semibold text-ink">{field.label}</h4>
          )}
          {field.help && (
            <p className="mt-1 text-[13px] leading-[18px] text-inkMuted">{field.help}</p>
          )}
          {elsewhere && (
            <p className="mt-1 text-[13px] leading-[18px] text-inkMuted">
              {}
              {(field.writesTo ? ELSEWHERE[field.writesTo] : undefined) ??
                "This value lives in another store and is not saved from this tab."}
            </p>
          )}
        </div>
        {suggestUrl && !readOnly && (
          <button
            type="button"
            disabled={suggesting}
            onClick={() => onSuggest(field.id, suggestUrl)}
            className={BTN}
          >
            {suggesting ? "Looking…" : "Suggest"}
          </button>
        )}
        {offer && !readOnly && !rows.some((r) => r.item.trim()) && (
          <button
            type="button"
            onClick={() => onTakeOffer(field.id, offer)}
            title="From your connected account"
            className={BTN}
          >
            Use @{offer}
          </button>
        )}
      </div>

      {field.kind === "list" && (
        <div className="mt-3">
          {!readOnly && (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const term = draft.trim();
                if (!term || adding) return;
                const invalid = check?.(term) ?? null;
                if (invalid) {
                  setAddNote(invalid);
                  return;
                }
                const at = rows.findIndex((r) => r.item.trim().toLowerCase() === term.toLowerCase());
                if (onAdd && at >= 0 && rows[at].status === "tracking") {
                  setAddNote("Already saved.");
                  return;
                }
                if (onAdd) {
                  setAdding(true);
                  setAddNote(null);
                  const err = await onAdd(field.id, term);
                  setAdding(false);
                  setAddNote(err ?? "Added.");
                  if (!err) setDraft("");
                  return;
                }
                setAddNote(null);
                onEdit(
                  field.id,
                  at >= 0
                    ? rows.map((r, j) => (j === at ? { ...r, status: "tracking" } : r))
                    : [
                        ...rows,
                        { item: term, item_type: itemTypes?.[0] ?? null, status: "tracking", origin: "custom" },
                      ],
                );
                setDraft("");
              }}
            >
              <label className="sr-only" htmlFor={`add-${field.id}`}>
                Add to {field.label}
              </label>
              <input
                id={`add-${field.id}`}
                type="text"
                value={draft}
                placeholder={addPlaceholder ?? `Add to ${field.label.toLowerCase()}`}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setAddNote(null);
                }}
                className={bare ? cx(INPUT, "h-9 min-w-0 flex-1 basis-40 bg-white text-[16px] sm:text-[13.5px]") : cx(INPUT, "min-w-0 flex-1 basis-40")}
              />
              <button
                type="submit"
                disabled={!draft.trim() || adding}
                className={bare ? BTN_ADD_BARE : BTN}
              >
                Add
              </button>
            </form>
          )}
          {!readOnly && addNote && (
            <p role="status" className="mt-1.5 text-[13px] leading-[18px] text-inkMuted">
              {addNote}
            </p>
          )}
          {shown.length === 0 ? (
            <p className="mt-2.5 text-[13px] text-inkMuted">
              {rows.length === 0
                ? "Nothing here yet. Zavi uses the whole channel until you narrow it."
                :
                  `${rows.length} suggestion${rows.length === 1 ? "" : "s"} from an earlier run ${
                    rows.length === 1 ? "is" : "are"
                  } hidden, because a suggestion goes stale. Press Suggest for a fresh set, or type a term to track it directly.`}
            </p>
          ) : (
            <div
              className={cx(
                "mt-2.5",
                shown.length > SCROLL_AFTER_ROWS &&
                  "max-h-[19rem] overflow-y-auto overscroll-contain rounded-xl border border-bone px-3",
              )}
            >
              <ul className="flex flex-col">
                {shown.map(({ row, i }) => (
                  <li
                    key={row.id ?? `${row.item}-${i}`}
                    className={
                      bare
                        ? cx(
                            "grid gap-2 border-b border-rule py-2 last:border-b-0 [@container(min-width:36rem)]:items-center",
                            typeOptions ? "[@container(min-width:36rem)]:grid-cols-[minmax(0,1fr)_11rem_auto]" : "[@container(min-width:36rem)]:grid-cols-[minmax(0,1fr)_auto]",
                          )
                        : "flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-bone py-2.5 last:border-b-0 [@container(min-width:36rem)]:flex-nowrap [@container(min-width:36rem)]:pr-2"
                    }
                  >
                    <div className={bare ? "order-1 flex min-w-0 flex-col" : "order-1 flex min-w-[8rem] flex-1 flex-col [@container(min-width:36rem)]:min-w-0"}>
                      <span className="min-w-0 [overflow-wrap:anywhere] text-[14px] leading-5 text-ink">{row.item}</span>
                      {row.detail && (
                        <span title={row.detail} className="truncate text-[13px] leading-4 text-inkMuted">
                          {row.detail}
                        </span>
                      )}
                      {row.note && (
                        <span className="[overflow-wrap:anywhere] text-[13px] leading-4 text-inkMuted">{row.note}</span>
                      )}
                    </div>
                    {pausable &&
                      row.status &&
                      row.status !== "suggested" &&
                      (PAUSABLE.has(row.status) && !readOnly ? (
                        <button
                          type="button"
                          aria-pressed={row.status === "tracking"}
                          aria-label={`${row.status === "tracking" ? "Pause" : "Resume"} ${row.item}`}
                          title={row.status === "tracking" ? "Click to pause" : "Click to resume"}
                          onClick={() =>
                            onEdit(
                              field.id,
                              rows.map((r, j) =>
                                j === i
                                  ? { ...r, status: r.status === "tracking" ? "paused" : "tracking" }
                                  : r,
                              ),
                            )
                          }
                          className={cx(STATUS_PILL, "order-2 [@container(min-width:36rem)]:order-4", statusTone(row.status), FOCUS_RING)}
                        >
                          {STATUS_LABEL[row.status]}
                        </button>
                      ) : (
                        <span className={cx(STATUS_PILL, "order-2 [@container(min-width:36rem)]:order-4", statusTone(row.status))}>
                          {STATUS_LABEL[row.status]}
                        </span>
                      ))}
                    <div className={bare ? "order-3 flex min-w-0 items-center gap-3 [@container(min-width:36rem)]:contents" : "hide-scrollbar order-3 flex max-w-full items-center gap-2 overflow-x-auto [@container(min-width:36rem)]:contents"}>
                      {statCols?.map((c) => {
                        const v = statValue(row.stats?.[c.key]);
                        return v === null ? null : (
                          <span key={c.key} className="hidden shrink-0 text-[13px] text-inkMuted [@container(min-width:36rem)]:order-2 [@container(min-width:36rem)]:block">
                            <span className="font-semibold tabular-nums text-ink">{v}</span> {c.label}
                          </span>
                        );
                      })}
                      {typeOptions && bare && (
                        <span className="relative min-w-0 flex-1 [@container(min-width:36rem)]:order-3 [@container(min-width:36rem)]:w-[11rem] [@container(min-width:36rem)]:flex-none">
                          <select
                            aria-label={typeOptions.label(row.item)}
                            disabled={readOnly}
                            value={row.item_type ?? ""}
                            onChange={(e) =>
                              onEdit(
                                field.id,
                                rows.map((r, j) =>
                                  j === i ? { ...r, item_type: e.target.value || null } : r,
                                ),
                              )
                            }
                            className={cx(
                              "h-8 w-full cursor-pointer appearance-none truncate rounded-lg border border-rule bg-white pl-2.5 pr-8 text-[13px] disabled:cursor-not-allowed",
                              row.item_type ? "text-ink" : "text-inkMuted",
                              FOCUS_RING,
                            )}
                          >
                            <option value="">{typeOptions.unsetLabel}</option>
                            {typeOptions.options.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                          <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-inkMuted" />
                        </span>
                      )}
                      {typeOptions && !bare && (
                        <select
                          aria-label={typeOptions.label(row.item)}
                          disabled={readOnly}
                          value={row.item_type ?? ""}
                          onChange={(e) =>
                            onEdit(
                              field.id,
                              rows.map((r, j) =>
                                j === i ? { ...r, item_type: e.target.value || null } : r,
                              ),
                            )
                          }
                          className="h-8 min-w-0 flex-1 truncate rounded-lg border border-rule bg-cream pl-1.5 pr-6 text-[13px] text-ink [@container(min-width:36rem)]:order-3 [@container(min-width:36rem)]:w-[12rem] [@container(min-width:36rem)]:flex-none [@container(min-width:36rem)]:shrink-0 [@container(min-width:36rem)]:pl-2.5"
                        >
                          <option value="">{typeOptions.unsetLabel}</option>
                          {typeOptions.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      )}
                      {itemTypes && (
                        <select
                          aria-label={`Type for ${row.item}`}
                          disabled={readOnly}
                          value={row.item_type ?? itemTypes[0]}
                          onChange={(e) =>
                            onEdit(
                              field.id,
                              rows.map((r, j) => (j === i ? { ...r, item_type: e.target.value } : r)),
                            )
                          }
                          className="h-8 w-[7.5rem] shrink-0 rounded-lg border border-rule bg-cream px-1.5 text-[13px] text-ink [@container(min-width:36rem)]:order-3 [@container(min-width:36rem)]:w-[9rem] [@container(min-width:36rem)]:px-2"
                        >
                          {itemTypes.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      )}
                      {row.status === "suggested" && <span aria-hidden className="hidden [@container(min-width:36rem)]:order-4 [@container(min-width:36rem)]:block [@container(min-width:36rem)]:w-16" />}
                      {!readOnly && (
                        <div className={cx("flex shrink-0 items-center gap-2 [@container(min-width:36rem)]:order-5 [@container(min-width:36rem)]:justify-end", shown.some(({ row: r }) => r.status === "suggested") && "[@container(min-width:36rem)]:w-[9.5rem]")}>
                          <button
                            type="button"
                            onClick={() =>
                              row.status === "suggested"
                                ? onEdit(
                                    field.id,
                                    rows.map((r, j) => (j === i ? { ...r, status: "tracking" } : r)),
                                  )
                                : onEdit(
                                    field.id,
                                    rows.filter((_, j) => j !== i),
                                  )
                            }
                            className={bare && row.status !== "suggested" ? BTN_QUIET : cx(BTN, "h-8 px-2 [@container(min-width:36rem)]:px-2.5")}
                          >
                            {row.status === "suggested" ? "Track it" : "Remove"}
                          </button>
                          {row.status === "suggested" && (
                            <button
                              type="button"
                              onClick={() =>
                                onEdit(
                                  field.id,
                                  rows.map((r, j) => (j === i ? { ...r, status: "dismissed" } : r)),
                                )
                              }
                              className={cx(BTN, "h-8 px-2 [@container(min-width:36rem)]:px-2.5")}
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {field.kind === "number" && (
        <div className="mt-3">
          <label className="sr-only" htmlFor={`num-${field.id}`}>
            {field.label}
          </label>
          <AmountInput
            {...amountAffixes(unit, field.prefix, field.suffix)}
            id={`num-${field.id}`}
            inputMode="decimal"
            placeholder="1,200"
            disabled={readOnly}
            value={scalar(rows)}
            invalid={scalar(rows).trim() !== "" && parseAmount(scalar(rows), field.max) === null}
            onChange={(e) => onEdit(field.id, e.target.value.trim() ? [{ item: e.target.value }] : [])}
          />
          {scalar(rows).trim() !== "" && parseAmount(scalar(rows), field.max) === null && (
            <p role="alert" className="mt-1.5 text-[13px] leading-[18px] text-inkMuted">
              Type a number like 12000. A $ sign and commas are fine.
            </p>
          )}
        </div>
      )}

      {field.kind === "choice" && (
        <div className="mt-3 flex flex-wrap gap-2">
          {field.options.map((o) => {
            const on = scalar(rows) === o.value;
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                disabled={readOnly}
                onClick={() => onEdit(field.id, on ? [] : [{ item: o.value }])}
                className={cx(
                  "inline-flex h-9 items-center rounded-cta border px-3 text-[14px] disabled:cursor-not-allowed",
                  on
                    ? "border-ink bg-ink font-semibold text-cream"
                    : "border-rule bg-cream font-medium text-inkMuted",
                  FOCUS_RING,
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}

      {field.kind === "toggle" && (() => {
        const isOn = scalar(rows) ? scalar(rows) === "on" : field.unsetIsOn === true;
        return (
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={isOn}
              aria-label={field.label}
              disabled={readOnly}
              onClick={() => onEdit(field.id, [{ item: isOn ? "off" : "on" }])}
              className={cx(
                "h-6 w-11 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                isOn ? "border-ink bg-ink" : "border-rule bg-bone",
                FOCUS_RING,
              )}
            >
              <span
                className={cx(
                  "block h-4 w-4 rounded-full bg-cream transition-transform",
                  isOn ? "translate-x-[26px]" : "translate-x-[3px]",
                )}
              />
            </button>
            <span className="text-[14px] text-ink">{isOn ? (field.on ?? "On") : (field.off ?? "Off")}</span>
          </div>
        );
      })()}

      {field.kind === "mapping" && (
        <div className="mt-3 overflow-hidden rounded-xl border border-bone">
          <table className="w-full table-fixed text-left">
            <thead className="bg-cream">
              <tr className="text-[13px] font-medium text-inkMuted">
                <th scope="col" className="px-3 py-2">{field.rowHeader}</th>
                <th scope="col" className="w-1/2 px-3 py-2 [@container(min-width:36rem)]:w-[16rem]">{field.columnHeader}</th>
              </tr>
            </thead>
            <tbody>
              {field.rows.map((r) => {
                const chosen = rows.find((x) => x.item === r.key)?.item_type ?? "";
                return (
                  <tr key={r.key} className="border-t border-bone">
                    <th scope="row" className="px-3 py-2.5 text-[16px] font-normal leading-5 text-ink">
                      {r.label}
                    </th>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`${field.columnHeader} for ${r.label}`}
                        disabled={readOnly}
                        value={chosen}
                        onChange={(e) => {
                          const v = e.target.value;
                          const others = rows.filter((x) => x.item !== r.key);
                          onEdit(field.id, v ? [...others, { item: r.key, item_type: v }] : others);
                        }}
                        className={cx(
                          "h-9 w-full truncate rounded-lg border border-rule bg-cream pl-2.5 pr-7 text-[13px] text-ink disabled:cursor-not-allowed",
                          FOCUS_RING,
                        )}
                      >
                        <option value="">{field.unsetLabel}</option>
                        {field.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {field.kind === "text" && (
        <div className="mt-3">
          <label className="sr-only" htmlFor={`txt-${field.id}`}>
            {field.label}
          </label>
          <input
            id={`txt-${field.id}`}
            type="text"
            disabled={readOnly}
            placeholder={field.placeholder}
            value={scalar(rows)}
            onChange={(e) => onEdit(field.id, e.target.value ? [{ item: e.target.value }] : [])}
            className={cx(INPUT, "w-full")}
          />
        </div>
      )}
    </section>
  );
}
