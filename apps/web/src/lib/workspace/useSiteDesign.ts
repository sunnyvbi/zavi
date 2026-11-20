"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import { createVisiblePoller } from "./useBuildPreview";

export type SiteDesignPreview = {
  name: string;
  eyebrow?: string;
  headline: string;
  subtitle?: string;
  primary_action?: string;
  hero_variant?: string;
  sections: Array<{ title: string; body?: string; kind?: string; variant?: string; tone?: string; items?: SiteDesignPreviewItem[] }>;
};

export type SiteDesignPreviewItem = { label: string; detail?: string };

const PREVIEW_WORD = /^[A-Za-z]{2,20}$/;

function previewWord(v: unknown): string | undefined {
  return typeof v === "string" && PREVIEW_WORD.test(v) ? v : undefined;
}

export const SITE_DESIGN_LAYOUTS = ["split", "centered", "editorial", "bold", "minimal"] as const;
export type SiteDesignLayout = (typeof SITE_DESIGN_LAYOUTS)[number];
export function readSiteLayout(value: unknown): SiteDesignLayout {
  return SITE_DESIGN_LAYOUTS.find((layout) => layout === value) ?? "centered";
}

export type SiteDesignLook = {
  id: string;
  label: string;
  mood: string;
  recommended: boolean;
  fonts: { display: string; body: string };
  swatches: { background: string; foreground: string; primary: string; accent: string; muted: string };
  radius: string;
  layout?: SiteDesignLayout;
  theme_css?: string | null;
  preview?: SiteDesignPreview | null;
};

export type SiteDesign = {
  run_id: string;
  awaiting_pick?: boolean;
  auto_start_at?: string | null;
  picked?: boolean;
  preview?: SiteDesignPreview | null;
  source: "model" | "fallback";
  looks: SiteDesignLook[];
  chosen: string;
  applied: string | null;
  structure?: string | null;
  look_given?: "idea" | "references" | "template" | null;
  locked: null | "live" | "built" | "ended" | "unsupported";
  plan: {
    audience: string | null;
    positioning: string | null;
    tone: string | null;
    main_action: string | null;
    sections: Array<{ id: string; name: string; headline: string }>;
    pages: Array<{ path: string; title: string }>;
    facts: string[];
  };
  checklist: null | {
    checked_at: string;
    found: number;
    total: number;
    items: Array<{ kind: string; label: string; found: boolean }>;
  };
};

export type SiteDesignState = {
  design: SiteDesign | null;
  loaded: boolean;
  picking: string | null;
  pickError: string | null;
  pick: (lookId: string) => Promise<void>;
  starting: string | null;
  started: string | null;
  startError: string | null;
  start: (lookId: string) => Promise<void>;
};

export const PICK_LOOK_EVENT = "zavi:pick-look";
export const START_FAILED = "We could not start your build. Try again.";
export const START_OFFLINE = "We could not start your build. Check your connection and try again.";

const THEME_CSS_MAX = 64_000;
const PREVIEW_TEXT_MAX = 400;

function previewText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, PREVIEW_TEXT_MAX) : undefined;
}

const PREVIEW_ITEM_MAX = 60;

function previewItems(v: unknown): SiteDesignPreviewItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 4)
    .map((x) => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const label = previewText(o.label)?.slice(0, PREVIEW_ITEM_MAX);
      if (!label) return null;
      const detail = previewText(o.detail)?.slice(0, PREVIEW_ITEM_MAX);
      return detail ? { label, detail } : { label };
    })
    .filter((x): x is SiteDesignPreviewItem => x !== null);
}

export function readSitePreview(raw: unknown): SiteDesignPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = previewText(r.name);
  const headline = previewText(r.headline);
  if (!name || !headline) return null;
  const sections = (Array.isArray(r.sections) ? r.sections : [])
    .map((x) => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const title = previewText(o.title);
      if (!title) return null;
      const items = previewItems(o.items);
      return { title, body: previewText(o.body), kind: previewWord(o.kind), variant: previewWord(o.variant), tone: previewWord(o.tone), ...(items.length ? { items } : {}) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 6);
  return {
    name,
    eyebrow: previewText(r.eyebrow),
    headline,
    subtitle: previewText(r.subtitle),
    primary_action: previewText(r.primary_action),
    hero_variant: previewWord(r.hero_variant),
    sections,
  };
}

type DesignListener = (design: SiteDesign, from: symbol) => void;
const sharedDesigns = new Map<string, SiteDesign>();
const designListeners = new Map<string, Set<DesignListener>>();
const designKicks = new Map<string, Set<() => void>>();
const startedRuns = new Map<string, string>();
const startingRuns = new Set<string>();

function inSet<T>(map: Map<string, Set<T>>, key: string, value: T): () => void {
  const set = map.get(key) ?? new Set<T>();
  set.add(value);
  map.set(key, set);
  return () => {
    set.delete(value);
    if (set.size === 0 && map.get(key) === set) map.delete(key);
  };
}

function shareDesign(runId: string, design: SiteDesign, from: symbol) {
  sharedDesigns.set(runId, design);
  designListeners.get(runId)?.forEach((l) => l(design, from));
}

function kickDesignReads(runId: string) {
  designKicks.get(runId)?.forEach((k) => k());
}

export function useSharedSiteDesign(runId: string | null): SiteDesign | null {
  const subscribe = useCallback(
    (onChange: () => void) => (runId ? inSet(designListeners, runId, () => onChange()) : () => undefined),
    [runId],
  );
  const snapshot = () => (runId ? sharedDesigns.get(runId) ?? null : null);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

const lookSelections = new Map<string, string>();
const selectionListeners = new Map<string, Set<() => void>>();

export function selectLook(runId: string, lookId: string | null) {
  if (lookId) lookSelections.set(runId, lookId);
  else lookSelections.delete(runId);
  selectionListeners.get(runId)?.forEach((l) => l());
}

export function useLookSelection(runId: string | null): string | null {
  const subscribe = useCallback((onChange: () => void) => (runId ? inSet(selectionListeners, runId, onChange) : () => undefined), [runId]);
  const snapshot = () => (runId ? lookSelections.get(runId) ?? null : null);
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

export function resetSharedSiteDesigns() {
  sharedDesigns.clear();
  designListeners.clear();
  designKicks.clear();
  startedRuns.clear();
  startingRuns.clear();
  lookSelections.clear();
  selectionListeners.clear();
}

export const SITE_DESIGN_POLL_MS = 6_000;

const HEX = /^#[0-9a-f]{6}$/i;

export function readSiteDesign(raw: unknown): SiteDesign | null {
  const d = (raw as { design?: unknown } | null)?.design as Partial<SiteDesign> | null | undefined;
  if (!d || typeof d !== "object" || !Array.isArray(d.looks) || typeof d.chosen !== "string" || !d.plan) return null;
  const looks = d.looks.filter(
    (l): l is SiteDesignLook =>
      !!l &&
      typeof l.id === "string" &&
      typeof l.label === "string" &&
      !!l.swatches &&
      Object.values(l.swatches).every((v) => typeof v === "string" && HEX.test(v)) &&
      !!l.fonts &&
      typeof l.fonts.display === "string" &&
      typeof l.fonts.body === "string",
  ).map((l) => ({
    ...l,
    layout: readSiteLayout(l.layout),
    theme_css: typeof l.theme_css === "string" && l.theme_css.length <= THEME_CSS_MAX ? l.theme_css : null,
    preview: readSitePreview(l.preview),
  }));
  return {
    ...(d as SiteDesign),
    looks,
    awaiting_pick: d.awaiting_pick === true,
    auto_start_at: d.awaiting_pick === true && typeof d.auto_start_at === "string" && Number.isFinite(Date.parse(d.auto_start_at)) ? d.auto_start_at : null,
    picked: d.picked === true,
    preview: readSitePreview(d.preview),
    structure: typeof d.structure === "string" ? d.structure : null,
    look_given: d.look_given === "idea" || d.look_given === "references" || d.look_given === "template" ? d.look_given : null,
  };
}

export function shouldPollDesign(design: SiteDesign | null, buildActive: boolean): boolean {
  if (!design) return buildActive;
  if (design.awaiting_pick || design.locked === null) return true;
  return buildActive && design.checklist === null;
}

export function useSiteDesign(runId: string | null, buildActive: boolean): SiteDesignState {
  const [design, setDesign] = useState<SiteDesign | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const selfRef = useRef(Symbol("site-design"));
  const startedRef = useRef<string | null>(null);
  const activeRef = useRef(buildActive);
  activeRef.current = buildActive;
  const designRef = useRef<SiteDesign | null>(null);
  const pickingRef = useRef<string | null>(null);
  const genRef = useRef(0);
  const readEpochRef = useRef(0);

  useEffect(() => {
    const gen = ++genRef.current;
    pickingRef.current = null;
    const seededStart = runId ? startedRuns.get(runId) ?? null : null;
    startedRef.current = seededStart;
    setPicking(null);
    setStarting(null);
    setStarted(seededStart);
    setStartError(null);
    const seeded = runId ? sharedDesigns.get(runId) ?? null : null;
    setDesign(seeded);
    designRef.current = seeded;
    setLoaded(false);
    setPickError(null);
    if (!runId) return;
    let cancelled = false;
    let missing = false;
    const poller = createVisiblePoller(() => void read());
    const self = selfRef.current;
    const unlisten = inSet(designListeners, runId, (next, from) => {
      if (cancelled || from === self || pickingRef.current) return;
      const otherStart = startedRuns.get(runId) ?? null;
      if (otherStart && !startedRef.current) {
        startedRef.current = otherStart;
        setStarted(otherStart);
        setStartError(null);
      }
      designRef.current = next;
      setDesign(next);
    });
    const unkick = inSet(designKicks, runId, () => {
      if (!cancelled) poller.schedule(0);
    });
    async function read() {
      const epoch = readEpochRef.current;
      try {
        const res = await apiFetch(`/api/workspace/autopilot/site-design?run_id=${encodeURIComponent(runId!)}`);
        if (cancelled) return;
        if (res.status === 404) {
          missing = true;
        } else if (res.ok) {
          missing = false;
          const next = readSiteDesign(await res.json().catch(() => null));
          if (!cancelled && next && !pickingRef.current && readEpochRef.current === epoch) {
            designRef.current = next;
            setDesign(next);
            shareDesign(runId!, next, self);
          }
        }
      } catch {
      } finally {
        if (!cancelled) {
          setLoaded(true);
          const keepGoing = missing ? activeRef.current : shouldPollDesign(designRef.current, activeRef.current);
          if (keepGoing) poller.schedule(SITE_DESIGN_POLL_MS);
        }
      }
    }
    void read();
    return () => {
      cancelled = true;
      if (genRef.current === gen) genRef.current++;
      pickingRef.current = null;
      unlisten();
      unkick();
      poller.stop();
    };
  }, [runId]);

  const pick = useCallback(
    async (lookId: string) => {
      if (!runId || pickingRef.current) return;
      const prev = designRef.current;
      if (!prev || prev.chosen === lookId) return;
      const gen = genRef.current;
      const current = () => genRef.current === gen;
      pickingRef.current = lookId;
      readEpochRef.current++;
      setPicking(lookId);
      setPickError(null);
      const optimistic = { ...prev, chosen: lookId };
      designRef.current = optimistic;
      setDesign(optimistic);
      try {
        const res = await apiFetch("/api/workspace/autopilot/site-design/direction", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ run_id: runId, direction: lookId }),
        });
        const body = (await res.json().catch(() => null)) as { error?: { message?: string; reason?: string } } | null;
        if (!current()) return;
        const next = res.ok ? readSiteDesign(body) : null;
        if (next) {
          designRef.current = next;
          setDesign(next);
          shareDesign(runId, next, selfRef.current);
        } else {
          const reason = body?.error?.reason;
          const back: SiteDesign =
            res.status === 409
              ? { ...prev, locked: reason === "live" || reason === "ended" || reason === "unsupported" ? reason : "built" }
              : prev;
          designRef.current = back;
          setDesign(back);
          setPickError(body?.error?.message ?? "Your pick did not save. Try again.");
        }
      } catch {
        if (!current()) return;
        designRef.current = prev;
        setDesign(prev);
        setPickError("Your pick did not save. Check your connection and try again.");
      } finally {
        if (current()) {
          pickingRef.current = null;
          readEpochRef.current++;
          setPicking(null);
        }
      }
    },
    [runId],
  );

  const start = useCallback(
    async (lookId: string) => {
      if (!runId || pickingRef.current || startedRef.current || startingRuns.has(runId) || startedRuns.has(runId)) return;
      const prev = designRef.current;
      if (!prev || !prev.looks.some((l) => l.id === lookId)) return;
      const gen = genRef.current;
      const current = () => genRef.current === gen;
      pickingRef.current = lookId;
      startingRuns.add(runId);
      readEpochRef.current++;
      setStarting(lookId);
      setStartError(null);
      try {
        const res = await apiFetch("/api/workspace/autopilot/site-design/direction", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ run_id: runId, direction: lookId }),
        });
        const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
        if (res.ok) startedRuns.set(runId, lookId);
        if (!current()) return;
        if (res.ok) {
          startedRef.current = lookId;
          setStarted(lookId);
          const next = readSiteDesign(body) ?? { ...prev, chosen: lookId, awaiting_pick: false };
          designRef.current = next;
          setDesign(next);
          shareDesign(runId, next, selfRef.current);
        } else {
          const message = body?.error?.message;
          setStartError(typeof message === "string" && message.trim() ? message : START_FAILED);
        }
      } catch {
        if (current()) setStartError(START_OFFLINE);
      } finally {
        startingRuns.delete(runId);
        if (current()) {
          pickingRef.current = null;
          readEpochRef.current++;
          setStarting(null);
          kickDesignReads(runId);
        }
      }
    },
    [runId],
  );

  return { design, loaded, picking, pickError, pick, starting, started, startError, start };
}
