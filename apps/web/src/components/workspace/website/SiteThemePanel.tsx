"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type MouseEvent } from "react";
import { CircleAlert, Check, Clock, Loader2, RefreshCw } from "lucide-react";
import { SlidingIndicator, useSlidingIndicator } from "@/components/ui/SlidingIndicator";
import {
  LOGO_TYPE_LABEL,
  RADIUS_LABEL,
  SITE_DESIGN_SAVED,
  loadSiteDesignEdit,
  previewSiteLogo,
  saveSiteDesignEdit,
  type SiteDesignEditState,
  type SiteLogoPreview,
  type SiteDesignOp,
  type SiteThemeTokens,
  type ThemeColorKey,
} from "@/lib/workspace/siteDesignEdit";
import { registerSessionScopedCache } from "@/lib/workspace/sessionScopedCache";
import { startSiteChangeInChat, themeChangeLabel } from "@/lib/workspace/siteInlineEdits";
import { editorThemeDraftMessage } from "./editorProtocol";
import { ThemeColorField, ThemeSelect, THEME_FIELD_LABEL } from "./ThemeControls";

export type ThemeDraftMessage = ReturnType<typeof editorThemeDraftMessage>;
export type AppliedThemeChange = Extract<SiteDesignOp, { kind: "theme" }>;
type Tab = "theme" | "logo";

const LOGO_MIN = 3;
const LOGO_MAX = 400;
type LogoChoice = "icon" | "name";
const LOGO_CHOICES: ReadonlyArray<{ id: LogoChoice; label: string }> = [
  { id: "icon", label: "Icon + name" },
  { id: "name", label: "Name only" },
];
const LOGO_IDEAS: ReadonlyArray<{ label: string; text: string }> = [
  { label: "Monogram", text: "A bold monogram of the initials" },
  { label: "Line icon", text: "A simple line icon that hints at what the site does" },
  { label: "Abstract mark", text: "An abstract geometric mark made from two overlapping shapes" },
];
const BUSY_CODES = new Set(["lease_held", "preview_starting", "build_active"]);
const LOGO_COST_FREE = "Your first logo for this site is free.";
const LOGO_COST_PAID = "Each new logo uses AI credits.";

type Note = { tone: "ok" | "busy" | "error"; text: string };

function cleanLogoDescription(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const COLORS: ReadonlyArray<{ key: ThemeColorKey; label: string }> = [
  { key: "primary", label: "Brand" },
  { key: "background", label: "Page" },
  { key: "foreground", label: "Text" },
  { key: "accent", label: "Accent" },
];

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; theme: SiteThemeTokens | null; fonts: string[]; radii: string[]; logo_ai: boolean; logo_preview_free: boolean };

type LoadResult = Awaited<ReturnType<typeof loadSiteDesignEdit>>;

const loadedThemes = new Map<string, SiteDesignEditState>();
const pendingThemes = new Map<string, Promise<LoadResult>>();
registerSessionScopedCache(() => {
  loadedThemes.clear();
  pendingThemes.clear();
});

export function preloadSiteTheme(appId: string): Promise<LoadResult> {
  const pending = pendingThemes.get(appId);
  if (pending) return pending;
  const p = loadSiteDesignEdit(appId).then((r) => {
    if (pendingThemes.get(appId) === p) {
      pendingThemes.delete(appId);
      if (r.ok) loadedThemes.set(appId, r.state);
    }
    return r;
  });
  pendingThemes.set(appId, p);
  return p;
}

function readyFrom(state: SiteDesignEditState): Load {
  return { state: "ready", theme: state.theme, fonts: state.fonts, radii: state.radii, logo_ai: state.logo_ai, logo_preview_free: state.logo_preview_free };
}

export function SiteThemePanel({
  appId,
  onClose,
  onDraft,
  onApplied,
  dismissLayerRef,
}: {
  appId: string;
  onClose: () => void;
  onDraft?: (message: ThemeDraftMessage) => void;
  onApplied?: (change: AppliedThemeChange) => void;
  dismissLayerRef?: MutableRefObject<(() => boolean) | null>;
}) {
  const logoCostId = useId();
  const [load, setLoad] = useState<Load>(() => {
    const cached = loadedThemes.get(appId);
    return cached ? readyFrom(cached) : { state: "loading" };
  });
  const [draft, setDraft] = useState<SiteThemeTokens | null>(() => loadedThemes.get(appId)?.theme ?? null);
  const draftRevisionRef = useRef(0);
  const mountedRef = useRef(true);
  const [saving, setSaving] = useState(false);
  const [logoDescription, setLogoDescription] = useState("");
  const [logoPreview, setLogoPreview] = useState<SiteLogoPreview | null>(null);
  const [logoChoice, setLogoChoice] = useState<LogoChoice>("icon");
  const [making, setMaking] = useState(false);
  const [tab, setTab] = useState<Tab>("theme");
  const [note, setNote] = useState<Note | null>(null);
  const [layer, setLayer] = useState<string | null>(null);
  const layerRef = useRef<string | null>(null);
  const showLayer = useCallback((id: string | null) => {
    layerRef.current = id;
    setLayer(id);
  }, []);

  useEffect(() => {
    if (!dismissLayerRef) return;
    dismissLayerRef.current = () => {
      if (!layerRef.current) return false;
      showLayer(null);
      return true;
    };
    return () => {
      dismissLayerRef.current = null;
    };
  }, [dismissLayerRef, showLayer]);

  const onPanelMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    const id = layerRef.current;
    if (!id) return;
    const target = e.target as Element | null;
    if (target?.closest?.(`[data-theme-layer="${id}"]`)) return;
    showLayer(null);
  };
  const layerProps = (id: string) => ({ layerId: id, open: layer === id, onOpenChange: (o: boolean) => showLayer(o ? id : null) });

  const fetchState = useCallback(async () => {
    setLoad({ state: "loading" });
    const r = await preloadSiteTheme(appId);
    if (!r.ok) {
      setLoad({ state: "error", message: r.message });
      return;
    }
    setLoad(readyFrom(r.state));
    draftRevisionRef.current = 0;
    setDraft(r.state.theme);
  }, [appId]);

  useEffect(() => {
    if (pendingThemes.has(appId) || !loadedThemes.has(appId)) void fetchState();
  }, [appId, fetchState]);

  const current = load.state === "ready" ? load.theme : null;
  const changes = useMemo(() => {
    if (!current || !draft) return null;
    const colors: Partial<Record<ThemeColorKey, string>> = {};
    for (const { key } of COLORS) if (draft.colors[key].toLowerCase() !== current.colors[key].toLowerCase()) colors[key] = draft.colors[key];
    const fonts: { display?: string; body?: string } = {};
    if (draft.fonts.display !== current.fonts.display) fonts.display = draft.fonts.display;
    if (draft.fonts.body !== current.fonts.body) fonts.body = draft.fonts.body;
    const op = {
      kind: "theme" as const,
      ...(Object.keys(colors).length ? { colors } : {}),
      ...(Object.keys(fonts).length ? { fonts } : {}),
      ...(draft.radius !== current.radius ? { radius: draft.radius } : {}),
    };
    return Object.keys(op).length > 1 ? op : null;
  }, [current, draft]);

  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const liveDraftRef = useRef(false);
  const pendingDraftRef = useRef<ThemeDraftMessage | null>(null);
  const draftFrameRef = useRef<number | null>(null);
  const allowedFonts = load.state === "ready" ? load.fonts : null;
  const allowedRadii = load.state === "ready" ? load.radii : null;

  useEffect(() => {
    if (!allowedFonts || !allowedRadii) return;
    if (!changes && !liveDraftRef.current) return;
    pendingDraftRef.current = editorThemeDraftMessage(changes, { fonts: allowedFonts, radii: allowedRadii });
    liveDraftRef.current = changes !== null;
    if (draftFrameRef.current !== null) return;
    draftFrameRef.current = requestAnimationFrame(() => {
      draftFrameRef.current = null;
      const message = pendingDraftRef.current;
      pendingDraftRef.current = null;
      if (message) onDraftRef.current?.(message);
    });
  }, [changes, allowedFonts, allowedRadii]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (draftFrameRef.current !== null) cancelAnimationFrame(draftFrameRef.current);
      draftFrameRef.current = null;
      pendingDraftRef.current = null;
      if (liveDraftRef.current) {
        liveDraftRef.current = false;
        onDraftRef.current?.(editorThemeDraftMessage(null, { fonts: [], radii: [] }));
      }
    };
  }, []);

  const logo = load.state === "ready" && load.logo_ai ? cleanLogoDescription(logoDescription) : "";
  const logoReady = logo.length >= LOGO_MIN && logo.length <= LOGO_MAX;
  const nameOnly = load.state === "ready" && load.logo_ai && logoChoice === "name";
  const logoToApply = load.state === "ready" && load.logo_ai && !nameOnly ? logoPreview : null;
  const pending = changes !== null || logoToApply !== null || nameOnly;

  const makeLogo = async () => {
    if (!logoReady || making || saving) return;
    setMaking(true);
    setNote(null);
    const colors = draft ? { primary: draft.colors.primary, accent: draft.colors.accent } : null;
    const r = await previewSiteLogo(appId, { description: logo, colors });
    if (!mountedRef.current) return;
    setMaking(false);
    if (!r.ok) {
      setNote({ tone: r.code && BUSY_CODES.has(r.code) ? "busy" : "error", text: r.message });
      return;
    }
    setLogoPreview(r.preview);
    if (load.state === "ready" && load.logo_preview_free) {
      const cached = loadedThemes.get(appId);
      if (cached) loadedThemes.set(appId, { ...cached, logo_preview_free: false });
      setLoad({ ...load, logo_preview_free: false });
    }
  };

  const apply = async () => {
    if (!pending || saving || making) return;
    const submitted: AppliedThemeChange = {
      ...(changes ?? { kind: "theme" as const }),
      ...(nameOnly ? { logo: { name_only: true as const } } : logoToApply ? { logo: { preview_id: logoToApply.id } } : {}),
    };
    const submittedRevision = draftRevisionRef.current;
    const submittedPreview = logoToApply;
    setSaving(true);
    setNote(null);
    const settleChat = startSiteChangeInChat(appId, themeChangeLabel(submitted));
    const r = await saveSiteDesignEdit(appId, submitted);
    settleChat(r.ok ? (r.changeId ?? null) : { error: r.message });
    if (!mountedRef.current) return;
    setSaving(false);
    if (!r.ok) {
      setNote({ tone: r.code && BUSY_CODES.has(r.code) ? "busy" : "error", text: r.message });
      return;
    }
    if (r.theme && load.state === "ready") {
      const cached = loadedThemes.get(appId);
      if (cached) loadedThemes.set(appId, { ...cached, theme: r.theme });
      setLoad({ ...load, theme: r.theme });
    }
    if (submittedPreview) {
      setLogoPreview((p) => (p === submittedPreview ? null : p));
      setLogoDescription("");
    }
    if (nameOnly) setLogoChoice("icon");
    setNote({ tone: "ok", text: SITE_DESIGN_SAVED });
    if (draftRevisionRef.current !== submittedRevision) return;
    onApplied?.(submitted);
    if (draftFrameRef.current !== null) cancelAnimationFrame(draftFrameRef.current);
    draftFrameRef.current = null;
    pendingDraftRef.current = null;
    if (liveDraftRef.current) {
      liveDraftRef.current = false;
      onDraftRef.current?.(editorThemeDraftMessage(null, { fonts: allowedFonts ?? [], radii: allowedRadii ?? [] }));
    }
    if (r.theme) setDraft(r.theme);
    onClose();
  };

  const reset = () => {
    setNote(null);
    if (tab === "logo") {
      setLogoDescription("");
      setLogoPreview(null);
      setLogoChoice("icon");
      return;
    }
    draftRevisionRef.current += 1;
    setDraft(load.state === "ready" ? load.theme : null);
  };

  const set = (patch: Partial<SiteThemeTokens>) => {
    setNote(null);
    draftRevisionRef.current += 1;
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  const tabs = load.state === "ready" && load.logo_ai;
  const shown: Tab = tabs ? tab : "theme";
  const themeDirty = changes !== null;
  const { listRef: tabsRef, box: tabsBox } = useSlidingIndicator<HTMLDivElement>(tabs ? shown : null);
  const tabButton = (id: Tab, label: string, dirty: boolean) => (
    <button
      type="button"
      role="tab"
      id={`site-theme-tab-${id}`}
      aria-selected={shown === id}
      aria-controls={`site-theme-panel-${id}`}
      data-testid={`site-theme-tab-${id}`}
      onClick={() => {
        showLayer(null);
        setTab(id);
      }}
      className={`site-theme-tab relative inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${
        shown === id ? "text-ink" : "text-inkMuted hover:text-ink"
      }`}
    >
      {label}
      {dirty && <span data-testid={`site-theme-tab-${id}-draft`} aria-label="(not applied yet)" className="site-theme-tab-dot h-1.5 w-1.5 rounded-full bg-ink/60" />}
    </button>
  );

  return (
    <div
      role="dialog"
      aria-label="Site theme"
      onMouseDownCapture={onPanelMouseDown}
      className="site-theme-panel raised-surface max-h-[calc(100dvh-96px)] w-[340px] max-w-[calc(100vw-48px)] overflow-y-auto overscroll-contain rounded-[16px] border border-rule bg-white p-4 text-[14px] text-ink shadow-pop"
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        {tabs ? (
          <div ref={tabsRef} role="tablist" aria-label="Theme or logo" className="site-theme-tabs relative flex min-w-0 flex-1 items-center gap-0.5 rounded-full bg-bone p-0.5">
            <SlidingIndicator box={tabsBox} className="site-theme-indicator rounded-full bg-white shadow-[0_1px_2px_rgb(14_15_17/0.12)]" />
            {tabButton("theme", "Theme", themeDirty)}
            {tabButton("logo", "Logo", logoToApply !== null)}
          </div>
        ) : (
          <span className="text-[16px] font-semibold leading-[20px]">Theme</span>
        )}
      </div>

      {load.state === "loading" && (
        <p role="status" className="flex items-center gap-2 py-4 text-inkSoft">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          Loading the site's look…
        </p>
      )}

      {load.state === "error" && (
        <div role="alert" className="space-y-2 py-2">
          <p className="text-[#cb2029]">{load.message}</p>
          <button type="button" onClick={() => void fetchState()} className="rounded-full border border-rule px-3 py-1 text-[12px] font-medium hover:bg-bone">
            Try again
          </button>
        </div>
      )}

      {load.state === "ready" && shown === "theme" && !load.theme && (
        <p className="py-2 text-inkSoft">This site's colours and fonts can't be changed here. Ask for the change in the chat.</p>
      )}

      {load.state === "ready" && shown === "theme" && load.theme && draft && (
        <fieldset
          disabled={saving}
          {...(tabs ? { role: "tabpanel", id: "site-theme-panel-theme", "aria-labelledby": "site-theme-tab-theme" } : {})}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <p className={`col-span-2 ${THEME_FIELD_LABEL}`}>Colours</p>
            {COLORS.map(({ key, label }) => (
              <ThemeColorField
                key={key}
                {...layerProps(`color:${key}`)}
                label={label}
                value={draft.colors[key]}
                onChange={(hex) => set({ colors: { ...draft.colors, [key]: hex } })}
              />
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <ThemeSelect
              {...layerProps("font:display")}
              label="Headings"
              ariaLabel="Headings font"
              value={draft.fonts.display}
              options={[...new Set([draft.fonts.display, ...load.fonts])].map((f) => ({ value: f, label: f, font: f }))}
              onChange={(v) => set({ fonts: { ...draft.fonts, display: v } })}
              placement="up"
            />
            <ThemeSelect
              {...layerProps("font:body")}
              label="Body"
              ariaLabel="Body font"
              value={draft.fonts.body}
              options={[...new Set([draft.fonts.body, ...load.fonts])].map((f) => ({ value: f, label: f, font: f }))}
              onChange={(v) => set({ fonts: { ...draft.fonts, body: v } })}
              placement="up"
            />
          </div>

          <ThemeSelect
            {...layerProps("radius")}
            label="Corners"
            ariaLabel="Corners"
            value={draft.radius}
            options={[...new Set([draft.radius, ...load.radii])].map((r) => ({ value: r, label: RADIUS_LABEL[r] ?? r }))}
            onChange={(v) => set({ radius: v })}
            placement="up"
          />
        </fieldset>
      )}

      {load.state === "ready" && shown === "logo" && (
        <fieldset disabled={saving} role="tabpanel" id="site-theme-panel-logo" aria-labelledby="site-theme-tab-logo" className="space-y-3">
          <div role="radiogroup" aria-label="Logo type" data-testid="site-logo-layout" className="flex items-center gap-0.5 rounded-full bg-bone p-0.5">
            {LOGO_CHOICES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={logoChoice === option.id}
                data-testid={`site-logo-layout-${option.id}`}
                onClick={() => {
                  setLogoChoice(option.id);
                  setNote(null);
                }}
                className={`inline-flex h-7 flex-1 items-center justify-center rounded-full px-2 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${
                  logoChoice === option.id ? "bg-white text-ink shadow-[0_1px_2px_rgb(14_15_17/0.12)]" : "text-inkMuted hover:text-ink"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {nameOnly ? (
            <p data-testid="site-logo-name-only" className="rounded-[12px] border border-rule bg-bone/60 p-3 text-[12px] leading-4 text-inkMuted">
              The header shows your site&apos;s name as text, with no logo image. Nothing is designed or charged. Press Apply to use it.
            </p>
          ) : (
          <>
          {logoPreview && (
            <div data-testid="site-logo-preview" className="flex items-center gap-3 rounded-[12px] border border-rule bg-bone/60 p-3">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[10px] border border-rule bg-white p-2">
                {}
                <img src={logoPreview.src} alt="Logo preview" className="h-full w-full object-contain" />
              </div>
              <p className="min-w-0 text-[12px] leading-4 text-inkMuted">
                Press Apply to put this logo on the site.
                {logoPreview.design && (
                  <span data-testid="site-logo-design" className="mt-0.5 block text-inkSoft">
                    {LOGO_TYPE_LABEL[logoPreview.design.type] ?? "Mark"}: {logoPreview.design.rationale}
                  </span>
                )}
                <span className="mt-0.5 block text-inkLight">{logoPreview.free ? "This one was free." : "This one used AI credits."}</span>
              </p>
            </div>
          )}
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[14px] font-medium leading-5 text-inkMuted">Describe the logo</p>
              <span data-testid="site-logo-count" className="text-[11px] tabular-nums leading-[18px] text-inkLight">
                {logoDescription.length}/{LOGO_MAX}
              </span>
            </div>
            <textarea
              aria-label="Describe the logo"
              value={logoDescription}
              maxLength={LOGO_MAX}
              rows={3}
              onChange={(event) => {
                setLogoDescription(event.target.value);
                setNote(null);
              }}
              placeholder="A geometric hummingbird made from two flowing shapes"
              className="site-theme-field w-full resize-none rounded-[12px] border border-rule bg-white px-3 py-2.5 text-[13px] leading-5 text-ink outline-none transition-colors placeholder:text-inkLight focus:border-ink/40 focus-visible:ring-2 focus-visible:ring-ink/15"
            />
          </div>
          <div className="flex flex-wrap gap-1.5" aria-label="Logo ideas">
            {LOGO_IDEAS.map((idea) => (
              <button
                key={idea.label}
                type="button"
                onClick={() => {
                  setLogoDescription(idea.text);
                  setNote(null);
                }}
                className="site-theme-chip inline-flex h-7 items-center rounded-full border border-rule px-2.5 text-[12px] font-medium text-inkSoft transition-colors hover:bg-bone hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
              >
                {idea.label}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            {(draft ?? current) ? (
              <div data-testid="site-logo-swatches" role="img" aria-label="Logo colours from the Theme tab" className="flex shrink-0 -space-x-1.5">
                {COLORS.map(({ key, label }) => (
                  <span
                    key={key}
                    title={label}
                    style={{ backgroundColor: (draft ?? current)!.colors[key] }}
                    className="site-theme-swatch h-5 w-5 rounded-full border-2 border-cream"
                  />
                ))}
              </div>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => void makeLogo()}
              disabled={!logoReady || making || saving}
              aria-describedby={logoCostId}
              className="site-theme-secondary inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-rule bg-white px-3.5 text-[13px] font-semibold text-ink transition-colors hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-50"
            >
              {making ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : logoPreview ? (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              ) : null}
              {making ? "Designing…" : logoPreview ? "Make another" : "Make logo"}
            </button>
          </div>
          <p id={logoCostId} data-testid="site-logo-cost" className="text-right text-[12px] leading-4 text-inkMuted">
            {load.logo_preview_free ? LOGO_COST_FREE : LOGO_COST_PAID}
          </p>
          </div>
          </>
          )}
        </fieldset>
      )}

      {load.state === "ready" && (load.theme || tabs) && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={saving || making || (shown === "logo" ? !logoDescription && !logoPreview && !nameOnly : !themeDirty)}
            className="site-theme-secondary inline-flex h-10 items-center rounded-cta border border-rule bg-white px-3.5 text-[14px] font-semibold text-ink transition-colors hover:bg-creamDeep disabled:opacity-50"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={!pending || saving || making}
            className="inline-flex h-10 items-center gap-1.5 rounded-cta bg-ink px-4 text-[14px] font-semibold text-cream transition-colors hover:bg-inkSoft disabled:cursor-not-allowed disabled:opacity-35"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
            {saving ? "Applying…" : "Apply"}
          </button>
        </div>
      )}

      {load.state === "ready" && note && (
        <p
          role={note.tone === "ok" ? "status" : "alert"}
          data-tone={note.tone}
          className={`site-theme-note site-theme-note-${note.tone} mt-3 flex items-start gap-2 rounded-[10px] px-3 py-2 text-[12px] leading-[18px] ${
            note.tone === "ok" ? "bg-bone text-inkSoft" : note.tone === "busy" ? "bg-[#fbf3e2] text-[#7a5200]" : "bg-[#fdeceb] text-[#b42318]"
          }`}
        >
          {note.tone === "ok" ? (
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : note.tone === "busy" ? (
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          {note.text}
        </p>
      )}
    </div>
  );
}
