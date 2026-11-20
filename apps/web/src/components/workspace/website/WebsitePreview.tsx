"use client";

import { liveFrameSrc } from "@/lib/workspace/sitePreviewCookie";
import { askAiFailureMessage, siteChangeOfferFrom, type EditFailureBody, type SiteChangeResult } from "./websiteChatEdit";
import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  RotateCw,
  ChevronDown,
  Monitor,
  Tablet,
  Smartphone,
  ExternalLink,
  Check,
  PenLine,
  Search,
  SquareDashedMousePointer,
  X,
  Pause,
  Clock,
  Type,
  Palette,
  Eye,
  Ellipsis,
} from "lucide-react";
import {
  AnnotationBar,
  AnnotationCanvas,
  EMPTY_ANNOTATIONS,
  annotationReducer,
  type Stroke,
} from "./PreviewAnnotation";

function CursorMagicIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 14.334 14.3337" fill="none" className={className} aria-hidden>
      <path
        d="M5.37305 4.01758C5.74826 3.98141 6.19237 4.00566 6.66309 4.06738C7.60832 4.19136 8.74596 4.47759 9.83496 4.82812C10.9249 5.17895 11.9899 5.60111 12.79 6.00781C13.1875 6.20985 13.5376 6.41779 13.7959 6.62012C13.9243 6.72073 14.0473 6.83268 14.1416 6.95605C14.2305 7.07243 14.3353 7.25188 14.334 7.47559C14.3305 8.0193 13.9594 8.39162 13.5996 8.62695C13.2302 8.86858 12.7554 9.04695 12.2939 9.18457C11.8259 9.32414 11.3348 9.43179 10.916 9.51855C10.8123 9.54004 10.7142 9.56052 10.623 9.5791C10.3315 9.63853 10.1057 9.68391 9.95703 9.72559C9.71187 9.79437 9.66154 9.83916 9.64551 9.85645C9.62703 9.87644 9.5846 9.93687 9.52734 10.1973L9.52441 10.207C9.25563 11.4294 9.04436 12.3901 8.81836 13.0449C8.70545 13.3721 8.5743 13.6674 8.40234 13.8906C8.22097 14.126 7.96319 14.3177 7.61621 14.333C7.38788 14.343 7.20475 14.2384 7.08887 14.1523C6.9653 14.0606 6.8524 13.9409 6.75195 13.8154C6.54973 13.5628 6.34074 13.2179 6.13574 12.8262C5.72303 12.0374 5.28759 10.9831 4.91992 9.90137C4.55253 8.82038 4.24515 7.68952 4.09668 6.74609C4.02269 6.27596 3.98498 5.8332 4.00586 5.45801C4.02533 5.10824 4.10069 4.70706 4.35645 4.43164C4.6202 4.14777 5.02162 4.0515 5.37305 4.01758ZM5.46973 5.0127C5.33591 5.02559 5.23791 5.04722 5.1709 5.07129C5.11361 5.09191 5.09209 5.10952 5.08887 5.1123C5.08612 5.11608 5.0692 5.14017 5.05078 5.20215C5.02949 5.27392 5.01253 5.37628 5.00488 5.51367C4.98951 5.79 5.01642 6.1553 5.08496 6.59082C5.22154 7.45856 5.51061 8.53097 5.86719 9.58008C6.22353 10.6285 6.63931 11.6319 7.02148 12.3623C7.21389 12.73 7.38831 13.0106 7.53223 13.1904C7.56174 13.2273 7.588 13.2575 7.61035 13.2812C7.68244 13.1877 7.7712 13.0138 7.87305 12.7188C8.07596 12.1308 8.27395 11.2369 8.5498 9.98242C8.6129 9.69546 8.70073 9.40572 8.91309 9.17676C9.12775 8.94534 9.40917 8.8415 9.68652 8.76367C9.87357 8.71119 10.1528 8.6543 10.4551 8.59277C10.5396 8.57556 10.6262 8.55801 10.7129 8.54004C11.1265 8.45434 11.5827 8.35334 12.0078 8.22656C12.4395 8.09783 12.8041 7.95195 13.0518 7.79004C13.2252 7.6766 13.2927 7.58873 13.3184 7.53125C13.2896 7.50056 13.2453 7.45867 13.1797 7.40723C12.995 7.26251 12.7096 7.08884 12.3369 6.89941C11.5965 6.52308 10.5833 6.11888 9.52832 5.7793C8.47256 5.43948 7.39756 5.17197 6.5332 5.05859C6.09944 5.00171 5.73923 4.98676 5.46973 5.0127ZM2.14648 7.48047C2.34175 7.28521 2.65825 7.28521 2.85352 7.48047C3.04878 7.67573 3.04878 7.99224 2.85352 8.1875L2.1875 8.85352C1.99224 9.04878 1.67573 9.04878 1.48047 8.85352C1.28521 8.65825 1.28521 8.34175 1.48047 8.14648L2.14648 7.48047ZM1.5 4.68652C1.77604 4.68652 1.99984 4.91052 2 5.18652C2 5.46267 1.77614 5.68652 1.5 5.68652H0.5C0.224007 5.68635 0 5.46256 0 5.18652C0.000162718 4.91063 0.224108 4.6867 0.5 4.68652H1.5ZM1.48047 1.48047C1.67573 1.28521 1.99224 1.28521 2.1875 1.48047L2.85352 2.14648C3.04878 2.34175 3.04878 2.65825 2.85352 2.85352C2.65825 3.04878 2.34175 3.04878 2.14648 2.85352L1.48047 2.1875C1.28521 1.99224 1.28521 1.67573 1.48047 1.48047ZM8.14648 1.48047C8.34175 1.28521 8.65825 1.28521 8.85352 1.48047C9.04878 1.67573 9.04878 1.99224 8.85352 2.1875L8.1875 2.85352C7.99224 3.04878 7.67573 3.04878 7.48047 2.85352C7.28521 2.65825 7.28521 2.34175 7.48047 2.14648L8.14648 1.48047ZM5.18652 0C5.46256 0 5.68635 0.224007 5.68652 0.5V1.5C5.68652 1.77614 5.46267 2 5.18652 2C4.9105 1.99986 4.68652 1.77606 4.68652 1.5V0.5C4.6867 0.224093 4.91061 0.00013871 5.18652 0Z"
        fill="currentColor"
      />
    </svg>
  );
}
import {
  originOf,
  parsePickedMessage,
  isPickerReadyMessage,
  PICKER_SET_TYPE,
  type PickedElement,
} from "../home/previewPicker";
import {
  isEditorReady,
  isEditorDeselected,
  parseEditorSelected,
  parseEditorHistory,
  parseEditorRoutes,
  parseEditorLocation,
  parseEditorApplied,
  parseEditorTextEdited,
  isEditorTextSubmit,
  runtimeProtocol,
  TEXT_TOOL_PROTOCOL,
  TEXT_REVERT_PROTOCOL,
  editorTextRevertMessage,
  type TextEdited,
  editorModeMessage,
  editorApplyMessage,
  editorDeleteMessage,
  editorUndoMessage,
  editorRedoMessage,
  editorDeselectMessage,
  editorRectsRequestMessage,
  parseEditorRects,
  parseEditorKey,
  type SelectedElement,
  type EditPatch,
} from "./editorProtocol";
import { WebsiteEditorToolbar } from "./WebsiteEditorToolbar";
import { SiteElementDesignControls, isSitePhoto } from "./SiteElementDesignControls";
import { SiteThemePanel, preloadSiteTheme } from "./SiteThemePanel";
import { PreviewErrorPill } from "./PreviewErrorPill";
import { PreviewToolsMenu } from "./PreviewToolsMenu";
import { hiddenToolsHint, isTypingTarget, previewShortcutFor, usePreviewToolsPrefs, type ShortcutKey } from "./previewTools";
import { clearSentTextEdits, forgetSentTextEdit, markTextEditsSent, unsentTextEdits } from "./sentTextEdits";
import { BuildLottie, Field, WAITING_ICON_CLASS, WaitingCard, WaitingMeter } from "./WebsiteBuildProgress";
import { apiFetch } from "@/lib/api";
import { useAppReadiness, type AppReadiness } from "@/lib/workspace/useAppReadiness";
import { usePreviewSnapshot, type PreviewSnapshot } from "@/lib/workspace/usePreviewSnapshot";
import {
  STILL_BUILDING_BODY,
  STILL_BUILDING_TITLE,
} from "@/lib/workspace/stillBuilding";
import { FIRST_DRAFT_SILENCE_MS, firstDraftShownMessage } from "@/lib/workspace/firstView";
import { safePreviewPath } from "@/lib/workspace/useBuildSession";
import {
  PREVIEW_RENDER_GAVE_UP,
  PREVIEW_RENDER_HELLO,
  awaitingPreviewRender,
  previewRenderGaveUp,
  previewRenderMessage,
  previewRenderReloadDelay,
  type PreviewRenderState,
} from "@/lib/workspace/previewRender";
import { setUnappliedEditGuard } from "@/lib/workspace/unappliedEdits";
import { createPortal } from "react-dom";

type Device = "desktop" | "tablet" | "mobile";

const DEVICE: Record<Device, { width: number | null; label: string; icon: typeof Monitor }> = {
  desktop: { width: null, label: "Desktop", icon: Monitor },
  tablet: { width: 768, label: "Tablet", icon: Tablet },
  mobile: { width: 425, label: "Mobile", icon: Smartphone },
};

export const DEVICE_ORDER: Device[] = ["desktop", "tablet", "mobile"];

export function nextDevice(current: Device): Device {
  const at = DEVICE_ORDER.indexOf(current);
  return DEVICE_ORDER[(at + 1) % DEVICE_ORDER.length];
}

const LOAD_TIMEOUT_MS = 30000;

export const EDIT_ARM_GRACE_MS = 3000;
export const EDIT_SWAP_GRACE_MS = 20_000;
export const NOT_LIVE_YET = "Not live yet";
export const APPLY_ACK_TIMEOUT_MS = 2000;
export const ASK_AI_NOT_APPLIED =
  "That change didn't fit this element on the page, so nothing was saved. Try again, or click a smaller part of it.";

type PriorDraft = { patch: EditPatch; removed: boolean } | null;

function originFrom(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function routeLabelFromPath(path: string): string {
  return !path || path === "/" ? "Home" : path;
}

export function pathFromUrl(url: string | null): string {
  if (!url) return "/";
  try {
    const u = new URL(url);
    const prefix = engineerPreviewPrefix(u);
    const path = prefix ? u.pathname.slice(prefix.length) || "/" : u.pathname || "/";
    if (prefix) u.searchParams.delete("__pt");
    const search = u.searchParams.toString();
    return `${path}${search ? `?${search}` : ""}`;
  } catch {
    return "/";
  }
}

function engineerPreviewPrefix(u: URL): string {
  return u.pathname.match(/^(.*\/engineer-preview\/[^/]+)(?:\/|$)/)?.[1] ?? "";
}

export function resolveNav(input: string, appOrigin: string | null, current?: string | null): string | null {
  const t = input.trim();
  if (!t) return null;
  if (t.startsWith("/") && current) {
    try {
      const base = new URL(current);
      const prefix = engineerPreviewPrefix(base);
      if (prefix) {
        if (t.split(/[?#]/)[0] !== "/") return previewUrlAtPath(current, t);
        const root = new URL(`${prefix}/`, base.origin);
        const token = base.searchParams.get("__pt");
        if (token) root.searchParams.set("__pt", token);
        return root.toString();
      }
    } catch {
    }
  }
  if (t.startsWith("/")) return appOrigin ? `${appOrigin}${t}` : null;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export function previewUrlAtPath(liveUrl: string | null, path: string | null | undefined): string | null {
  const safe = safePreviewPath(path);
  if (!liveUrl || !safe || safe === "/") return null;
  try {
    const base = new URL(liveUrl);
    const prefix = base.pathname.match(/^(.*\/engineer-preview\/[^/]+)(?:\/|$)/)?.[1] ?? "";
    const next = new URL(`${prefix}${safe}`, base.origin);
    if (next.origin !== base.origin || !next.pathname.startsWith(`${prefix}/`)) return null;
    const params = new URLSearchParams(base.search);
    next.searchParams.forEach((v, k) => {
      if (k !== "__pt") params.set(k, v);
    });
    const token = base.searchParams.get("__pt");
    if (token) params.set("__pt", token);
    next.search = params.toString();
    return next.toString();
  } catch {
    return null;
  }
}

export type PreviewPick = {
  id: number;
  selector: string;
  tag: string;
  text: string;
  path: string;
  src: string | null;
};

type Props = {
  liveUrl: string | null;
  cacheKey?: string | null;
  appId?: string | null;
  onElementPicked?: (picked: PickedElement) => void;
  onSelectionChange?: (pick: PreviewPick | null) => void;
  clearSelectionKey?: number;
  surfaceActive?: boolean;
  onEditFallback?: () => void;
  onEditUnavailable?: () => boolean;
  armEditOnLoad?: boolean;
  builtApp?: boolean;
  siteApp?: boolean;
  headerActions?: ReactNode;
  narrowLeading?: ReactNode;
  narrowTrailing?: ReactNode;
  leading?: ReactNode;
  editPlacement?: "header" | "dock";
  chromeOverride?: ReactNode;
  flush?: boolean;
  body?: ReactNode;
  openPath?: { path: string; nonce: string } | null;
  keepPreviewCookie?: boolean;
  notLiveAddress?: { host: string | null; label?: string } | null;
  guardWhileBuilding?: boolean;
  buildingNote?: string | null;
  readOnly?: boolean;
  onSendEdits?: (
    count: number,
    edits?: ReadonlyArray<{ selector: string; text?: string; id?: string; updated_at?: string }>,
  ) => Promise<{ ok: true; direct?: true; applied?: number; appliedSelectors?: string[] } | { ok: false; message: string }>;
  editsBusy?: boolean;
  onRequestSiteChange?: (request: string) => Promise<SiteChangeResult>;
};

export const TEXT_EDITS_BUSY = "Wait for the current change to finish, then send.";
export const TEXT_EDIT_NOT_SAVED = "A text change couldn't be saved, so it won't be sent. Type it again.";
export const TEXT_EDITS_CLEAR_FAILED = "Some changes couldn't be cleared. Try again.";
export const TEXT_EDITS_SAVED = "Text updated";
export const TEXT_EDITS_SAVED_MS = 4000;

type TextEditSnapshot = { selector: string; text?: string; id?: string; updated_at?: string; text_only?: boolean };
type TextEditSaveResult = { ok: boolean; snapshot?: TextEditSnapshot };

export const STALE_RUNTIME_RELOAD_MS = 10_000;
export const RUNTIME_WAIT_MS = 10_000;
export const RUNTIME_RELOADS = 2;
export const RUNTIME_MISSING_HINT =
  "The editing tools didn't load with the preview. A browser extension or network filter may be blocking zaviagent.com. Reload the preview to try again.";
export const COMMENT_RECTS_POLL_MS = 1500;

export type AnchoredToolbar = { chip: { left: number; top: number }; toolbar: { left: number; top: number } };

export function anchorEditToolbar(input: {
  rect: { x: number; y: number; w: number; h: number };
  scale: number;
  frame: { w: number; h: number };
  toolbar: { w: number; h: number };
}): AnchoredToolbar | null {
  const gap = 8;
  const chipH = 24;
  const { rect, scale, frame, toolbar } = input;
  const x = rect.x * scale;
  const y = rect.y * scale;
  const h = rect.h * scale;
  if (y + h <= 0 || y >= frame.h) return null;
  const maxLeft = Math.max(gap, frame.w - toolbar.w - gap);
  const left = Math.min(Math.max(x, gap), maxLeft);
  const below = y + h + gap;
  const above = y - chipH - toolbar.h - gap;
  const top =
    below + toolbar.h <= frame.h - gap
      ? below
      : above >= gap
        ? above
        : Math.max(gap, Math.min(frame.h - toolbar.h - gap, below));
  const chipTop = y - chipH - 4 >= 2 ? y - chipH - 4 : Math.max(2, y + 4);
  return { chip: { left: Math.min(Math.max(x, 2), Math.max(2, frame.w - 80)), top: chipTop }, toolbar: { left, top } };
}
export const PREVIEW_OVERLAY_FADE_MS = 320;
export const STALE_RUNTIME_RELOADS = 3;

export function textChangeLabel(count: number): string {
  return `${count} text change${count === 1 ? "" : "s"}`;
}

export function elementBefore(selected: SelectedElement): Record<string, unknown> {
  return {
    text: selected.text,
    ...(selected.segments ? { segments: selected.segments } : {}),
    style: selected.style,
    ...(selected.attrs ? { attrs: selected.attrs } : {}),
  };
}

export function patchTouchesMoreThanText(patch: unknown): boolean {
  if (!patch || typeof patch !== "object") return false;
  return Object.keys(patch).some((key) => key !== "text" && key !== "before");
}

export const READ_ONLY_PREVIEW_HINT =
  "This is a first draft while Zavi builds your site. You can edit it here once the build is ready, or describe a change in the chat.";

export const SITE_PICKER_MISSING_HINT =
  "Click-to-edit isn’t ready on this preview yet. Describe the change in the chat and Zavi will make it.";

export function WebsitePreview({
  liveUrl,
  cacheKey,
  appId,
  onElementPicked,
  onSelectionChange,
  clearSelectionKey,
  surfaceActive = true,
  onEditFallback,
  onEditUnavailable,
  armEditOnLoad = false,
  builtApp = false,
  siteApp = false,
  headerActions,
  narrowLeading,
  leading,
  editPlacement = "header",
  chromeOverride,
  narrowTrailing,
  flush = false,
  body,
  openPath = null,
  keepPreviewCookie = false,
  notLiveAddress = null,
  guardWhileBuilding = false,
  buildingNote = null,
  readOnly: readOnlyProp = false,
  onSendEdits,
  editsBusy = false,
  onRequestSiteChange,
}: Props) {
  const [url, setUrl] = useState<string | null>(() => previewUrlAtPath(liveUrl, openPath?.path) ?? liveUrl);
  const [device, setDevice] = useState<Device>("desktop");
  const [nonce, setNonce] = useState(0);
  const [routes, setRoutes] = useState<string[]>([]);
  const [livePath, setLivePath] = useState<string | null>(null);
  const [routeMenuOpen, setRouteMenuOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [renderState, setRenderState] = useState<PreviewRenderState | null>(null);
  const [renderReloads, setRenderReloads] = useState(0);
  const readiness = useAppReadiness(url);
  const appReady = readiness.state === "ready";
  const stillBuilding = guardWhileBuilding;
  const renderAt = { building: !!buildingNote, reloads: renderReloads };
  const renderGaveUp = previewRenderGaveUp(renderState, renderReloads);
  const awaitingRender = awaitingPreviewRender(renderState, renderAt) && !renderGaveUp;
  const overlayShown = !stillBuilding && (!appReady || (!loaded && !blocked) || awaitingRender);
  const [overlayGone, setOverlayGone] = useState(false);
  useEffect(() => {
    if (overlayShown) {
      setOverlayGone(false);
      return;
    }
    const timer = window.setTimeout(() => setOverlayGone(true), PREVIEW_OVERLAY_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [overlayShown]);
  const snapshots = usePreviewSnapshot(appId);
  const [liveSeen, setLiveSeen] = useState(false);
  useEffect(() => {
    if (!overlayShown && appReady) setLiveSeen(true);
  }, [overlayShown, appReady]);
  const [editHint, setEditHint] = useState<string | null>(null);
  const editHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pickerReady, setPickerReady] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickerReadyRef = useRef(false);
  pickerReadyRef.current = pickerReady;
  const armDeadlineRef = useRef(0);

  const [editorReady, setEditorReady] = useState(false);
  const [frameShowsDraft, setFrameShowsDraft] = useState(false);
  const draftSilenceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (draftSilenceRef.current) clearTimeout(draftSilenceRef.current);
    },
    [],
  );
  const readOnly = readOnlyProp || frameShowsDraft;
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  const draftRef = useRef<EditPatch | null>(null);
  const [leavePrompt, setLeavePrompt] = useState<{ then: () => void; afterApply: boolean; saving: boolean; error: string | null } | null>(null);
  const [draftResetKey, setDraftResetKey] = useState(0);
  const [draftAppliedKey, setDraftAppliedKey] = useState(0);
  const [hasDraft, setHasDraft] = useState(false);
  const selectedSelectorRef = useRef<string | null>(null);
  selectedSelectorRef.current = selected?.selector ?? null;
  const askBeforeDropping = useCallback((then: () => void, opts?: { afterApply?: boolean }): boolean => {
    if (!draftRef.current) return false;
    setLeavePrompt({ then, afterApply: opts?.afterApply ?? true, saving: false, error: null });
    return true;
  }, []);
  const askBeforeDroppingRef = useRef(askBeforeDropping);
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!draftRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    const clear = setUnappliedEditGuard((proceed) => askBeforeDropping(proceed));
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      clear();
    };
  }, [askBeforeDropping]);
  const [annotating, setAnnotating] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const themeRef = useRef<HTMLDivElement | null>(null);
  const themeLayerRef = useRef<(() => boolean) | null>(null);
  const [notes, dispatchNotes] = useReducer(annotationReducer, EMPTY_ANNOTATIONS);
  const [history, setHistory] = useState<{ canUndo: boolean; canRedo: boolean }>({
    canUndo: false,
    canRedo: false,
  });

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pendingAppliedRef = useRef<Array<{ selector: string; resolve: (ok: boolean) => void }>>([]);
  const runtimeProtocolRef = useRef(1);
  const [runtimeProto, setRuntimeProto] = useState(1);
  const [textMode, setTextMode] = useState(false);
  const [pendingEdits, setPendingEdits] = useState<string[]>([]);
  const [sendingEdits, setSendingEdits] = useState(false);
  const [clearingEdits, setClearingEdits] = useState(false);
  const [textSaved, setTextSaved] = useState(false);
  const [savingEdits, setSavingEdits] = useState(0);
  const [savingSelectors, setSavingSelectors] = useState<string[]>([]);
  const [sendQueued, setSendQueued] = useState(false);
  const [editorBoot, setEditorBoot] = useState(0);
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [previewBroken, setPreviewBroken] = useState(false);
  const [unsavedEdits, setUnsavedEdits] = useState<string[]>([]);
  const editRevRef = useRef(new Map<string, number>());
  const saveChainRef = useRef(new Map<string, Promise<TextEditSaveResult>>());
  const textClearBarrierRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  const originalTextRef = useRef(new Map<string, string>());
  const unknownTextRef = useRef(new Set<string>());
  const publishedTextRef = useRef(new Set<string>());
  const pendingSnapshotRef = useRef(new Map<string, TextEditSnapshot>());
  const queuedSnapshotRef = useRef<TextEditSnapshot[] | null>(null);
  const nonTextRowsRef = useRef(new Set<string>());
  const onTextEditedRef = useRef<(edit: TextEdited) => void>(() => {});
  const onTextSubmitRef = useRef<() => void>(() => {});
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const routeMenuRef = useRef<HTMLDivElement | null>(null);
  const loadedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [toolsPrefs, setToolsPrefs] = usePreviewToolsPrefs();
  const shortcutRef = useRef<(key: ShortcutKey, forwarded?: boolean) => boolean>(() => false);
  const reportedPickRef = useRef<PreviewPick | null>(null);
  const pickSeqRef = useRef(0);
  const pickDroppedByReloadRef = useRef(false);
  const toolbarWrapRef = useRef<HTMLDivElement | null>(null);
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedBox, setSelectedBox] = useState<{ selector: string; x: number; y: number; w: number; h: number } | null>(null);
  const [toolbarSize, setToolbarSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const frameBoxRef = useRef<HTMLDivElement | null>(null);
  const [frameOffset, setFrameOffset] = useState({ x: 0, y: 0 });
  const selectedWatchRef = useRef<string | null>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setStage((prev) =>
        Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
          ? prev
          : { w: r.width, h: r.height },
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [url, appReady, stillBuilding]);

  const onToolbarHandlePointerDown = useCallback((e: ReactPointerEvent) => {
    const body = bodyRef.current;
    const wrap = toolbarWrapRef.current;
    if (!body || !wrap) return;
    e.preventDefault();
    const bodyRect = body.getBoundingClientRect();
    const barRect = wrap.getBoundingClientRect();
    const origX = barRect.left - bodyRect.left;
    const origY = barRect.top - bodyRect.top;
    const startX = e.clientX;
    const startY = e.clientY;
    const maxX = Math.max(0, bodyRect.width - barRect.width);
    const maxY = Math.max(0, bodyRect.height - barRect.height);
    if (iframeRef.current) iframeRef.current.style.pointerEvents = "none";

    const onMove = (ev: PointerEvent) => {
      const nx = Math.max(0, Math.min(maxX, origX + (ev.clientX - startX)));
      const ny = Math.max(0, Math.min(maxY, origY + (ev.clientY - startY)));
      setToolbarPos({ x: nx, y: ny });
    };
    const onUp = () => {
      if (iframeRef.current) iframeRef.current.style.pointerEvents = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  useEffect(() => {
    if (!editMode) setToolbarPos(null);
  }, [editMode]);

  useEffect(() => {
    setUrl(previewUrlAtPath(liveUrl, openPath?.path) ?? liveUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveUrl]);

  const openPathNonce = openPath?.nonce ?? null;
  const openPathUrl = previewUrlAtPath(liveUrl, openPath?.path);
  useEffect(() => {
    if (openPathNonce && openPathUrl) setUrl(openPathUrl);
  }, [openPathNonce, openPathUrl]);

  useEffect(() => {
    if (!url) return;
    const expectedOrigin = originOf(url);
    if (!expectedOrigin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const d = event.data;
      const o = event.origin;
      if (o === expectedOrigin && !loadedRef.current) {
        loadedRef.current = true;
        setLoaded(true);
        setBlocked(false);
      }

      const rendered = previewRenderMessage(d, o, expectedOrigin);
      if (rendered !== null) {
        setRenderState(rendered);
        if (rendered === "rendered") setRenderReloads(0);
        return;
      }

      const shown = firstDraftShownMessage(d, o, expectedOrigin);
      if (shown !== null) {
        if (draftSilenceRef.current) clearTimeout(draftSilenceRef.current);
        draftSilenceRef.current = shown ? setTimeout(() => setFrameShowsDraft(false), FIRST_DRAFT_SILENCE_MS) : null;
        setFrameShowsDraft(shown);
        return;
      }

      if (isEditorReady(d, o, expectedOrigin)) {
        runtimeProtocolRef.current = runtimeProtocol(d);
        setRuntimeProto(runtimeProtocolRef.current);
        setEditorReady(true);
        setEditorBoot((n) => n + 1);
        return;
      }
      const forwardedKey = parseEditorKey(d, o, expectedOrigin);
      if (forwardedKey) {
        shortcutRef.current(forwardedKey, true);
        return;
      }
      const rects = parseEditorRects(d, o, expectedOrigin);
      if (rects) {
        const watched = selectedWatchRef.current;
        const box = watched ? rects.rects[watched] : null;
        if (watched && box) {
          setSelectedBox((prev) =>
            prev && prev.selector === watched && prev.x === box.x && prev.y === box.y && prev.w === box.w && prev.h === box.h ? prev : { selector: watched, ...box },
          );
        }
        return;
      }
      const textEdited = parseEditorTextEdited(d, o, expectedOrigin);
      if (textEdited) {
        onTextEditedRef.current(textEdited);
        return;
      }
      if (isEditorTextSubmit(d, o, expectedOrigin)) {
        onTextSubmitRef.current();
        return;
      }
      if (isEditorDeselected(d, o, expectedOrigin)) {
        if (!askBeforeDroppingRef.current(() => setSelected(null))) setSelected(null);
        return;
      }
      const sel = parseEditorSelected(d, o, expectedOrigin);
      if (sel) {
        if (sel.protocol) runtimeProtocolRef.current = Math.max(runtimeProtocolRef.current, sel.protocol);
        if (sel.selector === selectedSelectorRef.current || !askBeforeDroppingRef.current(() => setSelected(sel))) setSelected(sel);
        return;
      }
      const hist = parseEditorHistory(d, o, expectedOrigin);
      if (hist) {
        setHistory(hist);
        return;
      }
      const routeList = parseEditorRoutes(d, o, expectedOrigin);
      if (routeList) {
        setRoutes(routeList);
        return;
      }
      const loc = parseEditorLocation(d, o, expectedOrigin);
      if (loc) {
        setLivePath(loc);
        return;
      }
      const applied = parseEditorApplied(d, o, expectedOrigin);
      if (applied) {
        const index = pendingAppliedRef.current.findIndex((p) => p.selector === applied.selector);
        if (index >= 0) {
          const [pending] = pendingAppliedRef.current.splice(index, 1);
          pending!.resolve(applied.ok);
        }
        return;
      }

      if (isPickerReadyMessage(d, o, expectedOrigin)) {
        setPickerReady(true);
        return;
      }
      if (onElementPicked) {
        const picked = parsePickedMessage(d, o, expectedOrigin);
        if (picked) {
          onElementPicked(picked);
          setPicking(false);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onElementPicked, url]);

  useEffect(() => {
    pickDroppedByReloadRef.current = true;
    setRenderState(null);
    setFrameShowsDraft(false);
    setPickerReady(false);
    setPicking(false);
    setEditorReady(false);
    setEditMode(false);
    setTextMode(false);
    setRuntimeProto(1);
    setUnsavedEdits([]);
    setSavingSelectors([]);
    setClearingEdits(false);
    editRevRef.current.clear();
    originalTextRef.current.clear();
    unknownTextRef.current.clear();
    publishedTextRef.current.clear();
    pendingSnapshotRef.current.clear();
    queuedSnapshotRef.current = null;
    nonTextRowsRef.current.clear();
    setSelected(null);
    setHistory({ canUndo: false, canRedo: false });
    setRoutes([]);
    setLivePath(null);
    runtimeProtocolRef.current = 1;
    setRouteMenuOpen(false);
    setToolbarPos(null);
    setAnnotating(false);
    dispatchNotes({ type: "reset" });
  }, [url, cacheKey, nonce]);

  useEffect(() => {
    if (!armEditOnLoad) return;
    armDeadlineRef.current = Date.now() + EDIT_SWAP_GRACE_MS;
    setEditMode(true);
  }, [armEditOnLoad]);

  useEffect(() => {
    dispatchNotes({ type: "reset" });
  }, [device]);

  const postToChild = useCallback(
    (msg: unknown) => {
      const expectedOrigin = originOf(url);
      const target = iframeRef.current?.contentWindow;
      if (!expectedOrigin || !target) return;
      target.postMessage(msg, expectedOrigin);
    },
    [url],
  );

  const persistEdit = useCallback(
    (body: Record<string, unknown>) => {
      if (!appId) return;
      void apiFetch("/api/website/edits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, ...body }),
      }).catch(() => {
      });
    },
    [appId],
  );

  onTextEditedRef.current = (edit: TextEdited) => {
    if (!appId) return;
    const observedSnapshot = pendingSnapshotRef.current.get(edit.selector);
    const reverting =
      !publishedTextRef.current.has(edit.selector) &&
      originalTextRef.current.has(edit.selector) &&
      originalTextRef.current.get(edit.selector) === edit.text;
    if (!originalTextRef.current.has(edit.selector) && !unknownTextRef.current.has(edit.selector)) originalTextRef.current.set(edit.selector, edit.before);
    const rev = (editRevRef.current.get(edit.selector) ?? 0) + 1;
    editRevRef.current.set(edit.selector, rev);
    pendingSnapshotRef.current.set(edit.selector, { selector: edit.selector, text: edit.text });
    setSavingEdits((n) => n + 1);
    setSavingSelectors((prev) => (prev.includes(edit.selector) ? prev : [...prev, edit.selector]));
    const previous = saveChainRef.current.get(edit.selector) ?? Promise.resolve<TextEditSaveResult>({ ok: true });
    const clearBarrier = textClearBarrierRef.current?.promise ?? Promise.resolve();
    const save = Promise.all([previous.catch(() => undefined), clearBarrier])
      .then(async ([previousResult]): Promise<TextEditSaveResult> => {
        if (reverting) {
          const expected =
            observedSnapshot?.id && observedSnapshot.updated_at
              ? observedSnapshot
              : previousResult?.snapshot?.id && previousResult.snapshot.updated_at
                ? previousResult.snapshot
                : null;
          if (!expected) return { ok: false };
          const res = await apiFetch("/api/website/discard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              app_id: appId,
              selector: edit.selector,
              only: "text",
              expected: { id: expected.id, updated_at: expected.updated_at },
            }),
          });
          return { ok: res.ok };
        }
        const res = await apiFetch("/api/website/edits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app_id: appId, selector: edit.selector, patch: { text: edit.text }, before: { text: edit.before } }),
        });
        if (!res.ok) return { ok: false };
        const payload = (await res.json().catch(() => null)) as { edit?: TextEditSnapshot } | null;
        const snapshot = payload?.edit;
        if (
          snapshot?.selector !== edit.selector ||
          typeof snapshot.id !== "string" ||
          typeof snapshot.updated_at !== "string"
        ) return { ok: false };
        return { ok: true, snapshot: { ...snapshot, text: edit.text } };
      })
      .catch((): TextEditSaveResult => ({ ok: false }));
    saveChainRef.current.set(edit.selector, save);
    void save
      .then((result) => {
        if (editRevRef.current.get(edit.selector) !== rev) return;
        const saved = result.ok;
        if (saved && reverting) {
          originalTextRef.current.delete(edit.selector);
          pendingSnapshotRef.current.delete(edit.selector);
          if (nonTextRowsRef.current.has(edit.selector)) {
            setPendingEdits((prev) => (prev.includes(edit.selector) ? prev : [...prev, edit.selector]));
          } else {
            setPendingEdits((prev) => prev.filter((s) => s !== edit.selector));
          }
          setUnsavedEdits((prev) => prev.filter((s) => s !== edit.selector));
        } else if (saved) {
          pendingSnapshotRef.current.set(edit.selector, result.snapshot!);
          forgetSentTextEdit(appId, edit.selector);
          setPendingEdits((prev) => (prev.includes(edit.selector) ? prev : [...prev, edit.selector]));
          setUnsavedEdits((prev) => prev.filter((s) => s !== edit.selector));
        } else {
          setUnsavedEdits((prev) => (prev.includes(edit.selector) ? prev : [...prev, edit.selector]));
          setEditHint(TEXT_EDIT_NOT_SAVED);
        }
      })
      .finally(() => {
        if (saveChainRef.current.get(edit.selector) === save) {
          saveChainRef.current.delete(edit.selector);
          setSavingSelectors((prev) => prev.filter((s) => s !== edit.selector));
        }
        setSavingEdits((n) => Math.max(0, n - 1));
      });
  };
  onTextSubmitRef.current = () => {
    if (!onSendEdits || clearingEdits || sendingEdits) return;
    queuedSnapshotRef.current = [...pendingSnapshotRef.current.values()].map((snapshot) => ({ ...snapshot }));
    setSendQueued(true);
  };

  const applyEdit = useCallback(
    (patch: EditPatch) => {
      if (!selected || clearingEdits) return;
      if (patchTouchesMoreThanText(patch)) nonTextRowsRef.current.add(selected.selector);
      postToChild(editorApplyMessage(selected.selector, patch));
      persistEdit({ selector: selected.selector, patch, before: elementBefore(selected) });
    },
    [selected, postToChild, persistEdit, clearingEdits],
  );
  const applyDraftConfirmed = useCallback(
    async (patch: EditPatch): Promise<boolean> => {
      if (!selected || clearingEdits) return false;
      if (appId) {
        try {
          const res = await apiFetch("/api/website/edits", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ app_id: appId, selector: selected.selector, patch, before: elementBefore(selected) }),
          });
          if (!res.ok) return false;
        } catch {
          return false;
        }
      }
      if (patchTouchesMoreThanText(patch)) nonTextRowsRef.current.add(selected.selector);
      postToChild(editorApplyMessage(selected.selector, patch));
      return true;
    },
    [selected, clearingEdits, appId, postToChild],
  );
  const applyAndConfirm = useCallback(
    (selector: string, patch: EditPatch, reveal: boolean): Promise<boolean | null> => {
      const confirms = runtimeProtocolRef.current >= 2;
      if (!reveal && !confirms) {
        postToChild(editorApplyMessage(selector, patch));
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const pending = { selector, resolve };
        pendingAppliedRef.current.push(pending);
        postToChild(editorApplyMessage(selector, patch, reveal, confirms));
        window.setTimeout(() => {
          const index = pendingAppliedRef.current.indexOf(pending);
          if (index >= 0) {
            pendingAppliedRef.current.splice(index, 1);
            resolve(confirms ? false : null);
          }
        }, APPLY_ACK_TIMEOUT_MS);
      });
    },
    [postToChild],
  );
  const revertDraft = useCallback(
    (selector: string, prior: PriorDraft | undefined, expected: { id: string; updated_at: string } | undefined) => {
      if (!appId) return;
      if (!expected) return;
      void apiFetch("/api/website/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          prior ? { app_id: appId, selector, restore: prior, expected } : { app_id: appId, selector, expected },
        ),
      }).catch(() => {});
    },
    [appId],
  );
  const askAiEdit = useCallback(
    async (message: string) => {
      if (!selected || !appId) return;
      const res = await apiFetch("/api/website/resolve-edit", {
        method: "POST",
        idempotent: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: appId,
          selector: selected.selector,
          tag: selected.tag,
          text: selected.text,
          style: selected.style,
          ...(selected.attrs ? { attrs: selected.attrs } : {}),
          ...(selected.segments ? { segments: selected.segments } : {}),
          ...(selected.segments && (selected.protocol ?? 1) >= 2 ? { sparse: true } : {}),
          message,
          path: (livePath ?? pathFromUrl(url)).split("?")[0] || "/",
        }),
      });
      if (!res.ok) {
        const err = await res
          .json()
          .then((b: { error?: EditFailureBody }) => b?.error)
          .catch(() => undefined);
        throw siteChangeOfferFrom(err) ?? new Error(askAiFailureMessage(res.status, err));
      }
      const data = (await res.json()) as { patch?: EditPatch; prior?: PriorDraft; version?: { id: string; updated_at: string } };
      if (!data.patch) return;
      if (patchTouchesMoreThanText(data.patch)) nonTextRowsRef.current.add(selected.selector);
      const shown = await applyAndConfirm(selected.selector, data.patch, false);
      if (shown === false) {
        revertDraft(selected.selector, data.prior ?? undefined, data.version);
        throw new Error(ASK_AI_NOT_APPLIED);
      }
    },
    [selected, appId, applyAndConfirm, revertDraft, livePath, url],
  );
  const deleteEdit = useCallback(() => {
    if (!selected || clearingEdits) return;
    const target = selected;
    const remove = () => {
      nonTextRowsRef.current.add(target.selector);
      postToChild(editorDeleteMessage(target.selector));
      persistEdit({ selector: target.selector, remove: true, before: elementBefore(target) });
      setSelected(null);
    };
    if (!askBeforeDropping(remove)) remove();
  }, [selected, postToChild, persistEdit, clearingEdits, askBeforeDropping]);
  const undoEdit = useCallback(() => {
    const undo = () => postToChild(editorUndoMessage());
    if (!askBeforeDropping(undo, { afterApply: false })) undo();
  }, [postToChild, askBeforeDropping]);
  const redoEdit = useCallback(() => {
    const redo = () => postToChild(editorRedoMessage());
    if (!askBeforeDropping(redo, { afterApply: false })) redo();
  }, [postToChild, askBeforeDropping]);
  const exitSelection = useCallback(() => {
    const exit = () => {
      postToChild(editorDeselectMessage());
      setSelected(null);
    };
    if (!askBeforeDropping(exit)) exit();
  }, [postToChild, askBeforeDropping]);

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const pickPath = (livePath ?? pathFromUrl(url)).split("?")[0] || "/";
  useEffect(() => {
    const report = onSelectionChangeRef.current;
    if (!report) return;
    if (selected) {
      pickDroppedByReloadRef.current = false;
      const prev = reportedPickRef.current;
      if (prev && prev.selector === selected.selector && prev.path === pickPath) return;
      let src: string | null = null;
      if (selected.attrs?.src && url) {
        try {
          src = new URL(selected.attrs.src, url).toString();
        } catch {
          src = null;
        }
      }
      pickSeqRef.current += 1;
      const pick: PreviewPick = {
        id: pickSeqRef.current,
        selector: selected.selector,
        tag: selected.tag,
        text: selected.text.slice(0, 200),
        path: pickPath,
        src,
      };
      reportedPickRef.current = pick;
      report(pick);
      return;
    }
    if (pickDroppedByReloadRef.current) return;
    if (reportedPickRef.current) {
      reportedPickRef.current = null;
      report(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  useEffect(() => {
    const prev = reportedPickRef.current;
    if (!prev || prev.path === pickPath) return;
    reportedPickRef.current = null;
    onSelectionChangeRef.current?.(null);
    if (selected) exitSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickPath]);
  const clearKeySeen = useRef(clearSelectionKey);
  useEffect(() => {
    if (clearKeySeen.current === clearSelectionKey) return;
    clearKeySeen.current = clearSelectionKey;
    reportedPickRef.current = null;
    exitSelection();
  }, [clearSelectionKey, exitSelection]);

  useEffect(() => {
    if (!editorReady || !appId) return;
    let cancelled = false;
    const hydrationRevisions = new Map(editRevRef.current);
    void (async () => {
      try {
        const res = await apiFetch(`/api/website/edits?app=${encodeURIComponent(appId)}`);
        if (cancelled || !res.ok) return;
        const j = (await res.json()) as {
          edits?: Array<{ id?: string; selector: string; patch: EditPatch; removed: boolean; updated_at?: string; published_at?: string | null; published_patch?: EditPatch | null }>;
        };
        for (const e of j.edits ?? []) {
          const changedDuringHydration = editRevRef.current.get(e.selector) !== hydrationRevisions.get(e.selector);
          if (!changedDuringHydration) {
            if (e.removed) postToChild(editorDeleteMessage(e.selector));
            else postToChild(editorApplyMessage(e.selector, e.patch));
            if (e.removed || patchTouchesMoreThanText(e.patch)) nonTextRowsRef.current.add(e.selector);
            else nonTextRowsRef.current.delete(e.selector);
            if (e.published_at && (typeof e.published_patch?.text === "string" || Array.isArray(e.published_patch?.segments))) publishedTextRef.current.add(e.selector);
            else publishedTextRef.current.delete(e.selector);
            if (typeof e.id === "string" && typeof e.updated_at === "string") {
              pendingSnapshotRef.current.set(e.selector, { selector: e.selector, id: e.id, updated_at: e.updated_at });
            }
          }
          const savedBefore = (e.patch as { before?: { text?: unknown } } | null)?.before?.text;
          if (typeof savedBefore === "string") {
            originalTextRef.current.set(e.selector, savedBefore);
            unknownTextRef.current.delete(e.selector);
          } else {
            originalTextRef.current.delete(e.selector);
            unknownTextRef.current.add(e.selector);
          }
        }
        setPendingEdits((prev) => unsentTextEdits(appId, [...prev, ...(j.edits ?? []).map((e) => e.selector)]));
      } catch {
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editorReady, editorBoot, appId, postToChild]);

  useEffect(() => {
    setLoaded(false);
    loadedRef.current = false;
    setBlocked(false);
    if (!url || !appReady || stillBuilding) return;
    timerRef.current = setTimeout(() => {
      setBlocked((prev) => (prev ? prev : !loadedRef.current));
    }, LOAD_TIMEOUT_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [url, cacheKey, nonce, appReady, stillBuilding]);

  useEffect(() => {
    if (!routeMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (routeMenuRef.current && !routeMenuRef.current.contains(e.target as Node)) {
        setRouteMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRouteMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [routeMenuOpen]);

  const togglePicking = useCallback(() => {
    const expectedOrigin = originOf(url);
    const target = iframeRef.current?.contentWindow;
    if (!expectedOrigin || !target) return;
    const next = !picking;
    target.postMessage({ type: PICKER_SET_TYPE, enabled: next }, expectedOrigin);
    setPicking(next);
  }, [url, picking]);

  const showEditHint = useCallback((msg: string) => {
    setEditHint(msg);
    if (editHintTimer.current) clearTimeout(editHintTimer.current);
    editHintTimer.current = setTimeout(() => setEditHint(null), 6000);
  }, []);

  useEffect(() => {
    if (!editorReady) return;
    postToChild(editorModeMessage(editMode || textMode, textMode ? "text" : undefined));
    if (!editMode) setSelected(null);
  }, [editMode, textMode, editorReady, editorBoot, postToChild]);

  const textToolAvailable = editorReady && runtimeProto >= TEXT_TOOL_PROTOCOL && !!onSendEdits && !!appId && !readOnly && !clearingEdits;
  const siteDesignAvailable = editorReady && !!appId && appId.startsWith("site:") && !readOnly && !clearingEdits;
  const shownTextChanges = new Set([...pendingEdits, ...savingSelectors]).size;
  useEffect(() => {
    if (siteDesignAvailable && loaded && appId) void preloadSiteTheme(appId);
  }, [siteDesignAvailable, loaded, appId]);
  useEffect(() => {
    setRenderReloads(0);
  }, [url, cacheKey]);
  const renderEditing =
    editMode ||
    textMode ||
    annotating ||
    picking ||
    selected !== null ||
    sendingEdits ||
    errorLogOpen ||
    shownTextChanges > 0 ||
    unsavedEdits.length > 0;
  useEffect(() => {
    if (renderEditing) return;
    const delay = previewRenderReloadDelay(renderState, renderReloads);
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      setRenderReloads((n) => n + 1);
      setNonce((n) => n + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [renderState, renderReloads, renderEditing, nonce]);
  const retryRender = useCallback(() => {
    setRenderReloads(0);
    setNonce((n) => n + 1);
  }, []);
  const staleRuntimeReloadsRef = useRef(0);
  useEffect(() => {
    staleRuntimeReloadsRef.current = 0;
  }, [url, cacheKey]);
  useEffect(() => {
    if (!editorReady || runtimeProto >= TEXT_TOOL_PROTOCOL || !onSendEdits || !appId) return;
    if (staleRuntimeReloadsRef.current >= STALE_RUNTIME_RELOADS) return;
    if (shownTextChanges > 0 || unsavedEdits.length > 0 || sendingEdits || errorLogOpen || awaitingRender) return;
    if (renderEditing || hasDraft) return;
    const timer = window.setTimeout(() => {
      staleRuntimeReloadsRef.current += 1;
      setNonce((n) => n + 1);
    }, STALE_RUNTIME_RELOAD_MS);
    return () => window.clearTimeout(timer);
  }, [editorReady, runtimeProto, onSendEdits, appId, editorBoot, shownTextChanges, unsavedEdits.length, sendingEdits, errorLogOpen, awaitingRender, renderEditing, hasDraft]);
  const runtimeReloadsRef = useRef(0);
  const [runtimeRecheck, setRuntimeRecheck] = useState(0);
  useEffect(() => {
    runtimeReloadsRef.current = 0;
  }, [url, cacheKey]);
  useEffect(() => {
    if (!siteApp || !appId || editorReady || !loaded || blocked || awaitingRender || readOnly) return;
    if (renderEditing || hasDraft) return;
    const timer = window.setTimeout(() => {
      if (runtimeReloadsRef.current >= RUNTIME_RELOADS) {
        showEditHint(RUNTIME_MISSING_HINT);
        return;
      }
      if (document.activeElement === iframeRef.current) {
        setRuntimeRecheck((n) => n + 1);
        return;
      }
      runtimeReloadsRef.current += 1;
      setNonce((n) => n + 1);
    }, RUNTIME_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [siteApp, appId, editorReady, loaded, blocked, awaitingRender, readOnly, renderEditing, hasDraft, nonce, runtimeRecheck, showEditHint]);

  const toggleTextModeNow = useCallback(() => {
    setAnnotating(false);
    setEditMode(false);
    setEditHint(null);
    setTextMode((v) => !v);
  }, []);
  const toggleTextMode = useCallback(() => {
    if (!askBeforeDropping(toggleTextModeNow)) toggleTextModeNow();
  }, [toggleTextModeNow, askBeforeDropping]);

  const clearTextEdits = useCallback(async () => {
    if (!appId || textClearBarrierRef.current) return;
    setSendQueued(false);
    queuedSnapshotRef.current = null;
    const originals = new Map(originalTextRef.current);
    const selectors = [...new Set([...pendingEdits, ...savingSelectors, ...unsavedEdits, ...originals.keys()])];
    if (selectors.length === 0) return;
    setClearingEdits(true);
    let releaseClear: () => void = () => {};
    const clearBarrier = {
      promise: new Promise<void>((resolve) => (releaseClear = resolve)),
      resolve: () => releaseClear(),
    };
    textClearBarrierRef.current = clearBarrier;
    const clearRevisions = new Map<string, number>();
    for (const selector of selectors) {
      const revision = (editRevRef.current.get(selector) ?? 0) + 1;
      editRevRef.current.set(selector, revision);
      clearRevisions.set(selector, revision);
    }
    const revertInPlace =
      runtimeProtocolRef.current >= TEXT_REVERT_PROTOCOL &&
      selectors.every(
        (selector) => originals.has(selector) && !nonTextRowsRef.current.has(selector) && !publishedTextRef.current.has(selector),
      );
    if (revertInPlace) {
      postToChild(
        editorTextRevertMessage(
          selectors.flatMap((selector) => {
            const text = originals.get(selector);
            return text === undefined ? [] : [{ selector, text }];
          }),
        ),
      );
    }
    originalTextRef.current.clear();
    unknownTextRef.current.clear();
    setPendingEdits((prev) => prev.filter((selector) => !selectors.includes(selector)));
    setUnsavedEdits((prev) => prev.filter((selector) => !selectors.includes(selector)));
    setTextMode(false);
    const savesBeforeClear = new Map(saveChainRef.current);
    let shouldReload = !revertInPlace;
    try {
      const savedVersions = new Map<string, TextEditSnapshot>();
      await Promise.all(
        [...savesBeforeClear.entries()].map(async ([selector, save]) => {
          const result = await save.catch(() => undefined);
          if (result?.snapshot?.id && result.snapshot.updated_at) savedVersions.set(selector, result.snapshot);
        }),
      );
      const results = await Promise.all(
        selectors.map((selector) => {
          const current = pendingSnapshotRef.current.get(selector);
          const expected = current?.id && current.updated_at ? current : savedVersions.get(selector);
          if (!expected?.id || !expected.updated_at) return Promise.resolve(false);
          return apiFetch("/api/website/discard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ app_id: appId, selector, expected: { id: expected.id, updated_at: expected.updated_at } }),
          })
            .then((r) => r.ok)
            .catch(() => false);
        }),
      );
      const failed = selectors.filter((_, index) => !results[index]);
      const clearedWithoutLaterEdit = selectors.filter(
        (selector, index) => results[index] && editRevRef.current.get(selector) === clearRevisions.get(selector),
      );
      selectors.forEach((selector, index) => {
        if (results[index] && editRevRef.current.get(selector) === clearRevisions.get(selector)) {
          nonTextRowsRef.current.delete(selector);
          pendingSnapshotRef.current.delete(selector);
          editRevRef.current.delete(selector);
        }
      });
      if (failed.length > 0) setEditHint(TEXT_EDITS_CLEAR_FAILED);
      const cleared = new Set(clearedWithoutLaterEdit);
      setPendingEdits((prev) => [...new Set([...prev.filter((selector) => !cleared.has(selector)), ...failed])]);
      setUnsavedEdits((prev) => prev.filter((selector) => !cleared.has(selector)));
      shouldReload ||= failed.length > 0;
    } catch {
      setEditHint(TEXT_EDITS_CLEAR_FAILED);
      shouldReload = true;
    } finally {
      clearBarrier.resolve();
      if (textClearBarrierRef.current === clearBarrier) textClearBarrierRef.current = null;
    }
    if (shouldReload) {
      await Promise.all([...saveChainRef.current.values()].map((save) => save.catch(() => undefined)));
      setNonce((n) => n + 1);
    }
    setClearingEdits(false);
  }, [appId, pendingEdits, savingSelectors, unsavedEdits, postToChild]);

  const sendTextEdits = useCallback(async (requested?: readonly TextEditSnapshot[]) => {
    if (!onSendEdits || sendingEdits || savingEdits > 0 || pendingEdits.length === 0) return;
    if (unsavedEdits.length > 0) {
      setEditHint(TEXT_EDIT_NOT_SAVED);
      return;
    }
    if (editsBusy) {
      setEditHint(TEXT_EDITS_BUSY);
      return;
    }
    const requestedBySelector = new Map((requested ?? []).map((snapshot) => [snapshot.selector, snapshot]));
    const sending = requested
      ? [...new Set(requested.map((snapshot) => snapshot.selector))].filter((selector) => pendingEdits.includes(selector))
      : pendingEdits;
    if (sending.length === 0) return;
    const snapshots = sending.flatMap((selector) => {
      const expected = requestedBySelector.get(selector);
      const current = pendingSnapshotRef.current.get(selector);
      if (expected && (!expected.id || !expected.updated_at)) {
        return current !== undefined && current.text === expected.text && current.text_only === true ? [{ ...current }] : [];
      }
      const snapshot = expected ?? current;
      return snapshot ? [{ ...snapshot }] : [];
    });
    if (snapshots.length !== sending.length) {
      setEditHint(TEXT_EDIT_NOT_SAVED);
      return;
    }
    const submittedBySelector = new Map(snapshots.map((snapshot) => [snapshot.selector, snapshot]));
    setSendingEdits(true);
    setTextSaved(true);
    setEditHint(null);
    setPendingEdits((prev) => prev.filter((selector) => !sending.includes(selector)));
    setTextMode(false);
    if (appId) markTextEditsSent(appId, sending);
    const sentOriginals = sending.flatMap((selector) => {
      const text = originalTextRef.current.get(selector);
      return text === undefined ? [] : [[selector, text] as const];
    });
    for (const selector of sending) {
      originalTextRef.current.delete(selector);
      unknownTextRef.current.delete(selector);
    }
    try {
      const submittedEdits = snapshots.map(({ text_only: _textOnly, ...snapshot }) => snapshot);
      const result = await onSendEdits(sending.length, submittedEdits);
      if (!result.ok) {
        for (const [selector, text] of sentOriginals) {
          originalTextRef.current.set(selector, text);
        }
        if (appId) for (const selector of sending) forgetSentTextEdit(appId, selector);
        setTextSaved(false);
        setSendQueued(false);
        setPendingEdits((prev) => [...new Set([...sending, ...prev])]);
        setEditHint(result.message);
      } else if (!result.direct) {
        setTextSaved(false);
      }
      if (result.ok) {
        const appliedSelectors = new Set(result.appliedSelectors ?? sending);
        const kept: string[] = [];
        for (const selector of sending) {
          const submitted = submittedBySelector.get(selector);
          const current = pendingSnapshotRef.current.get(selector);
          if (appliedSelectors.has(selector) && submitted && current && current.id === submitted.id && current.updated_at === submitted.updated_at && current.text === submitted.text) {
            pendingSnapshotRef.current.delete(selector);
          } else {
            kept.push(selector);
            if (appId) forgetSentTextEdit(appId, selector);
          }
        }
        if (kept.length > 0) setPendingEdits((prev) => [...new Set([...kept, ...prev])]);
      }
    } finally {
      setSendingEdits(false);
    }
  }, [onSendEdits, sendingEdits, savingEdits, unsavedEdits.length, pendingEdits, editsBusy, appId]);

  useEffect(() => {
    if (!sendQueued || savingEdits > 0 || sendingEdits) return;
    if (pendingEdits.length === 0) {
      if (unsavedEdits.length > 0) {
        setSendQueued(false);
        setEditHint(TEXT_EDIT_NOT_SAVED);
      }
      return;
    }
    setSendQueued(false);
    const queued = queuedSnapshotRef.current;
    queuedSnapshotRef.current = null;
    void sendTextEdits(queued ?? undefined);
  }, [sendQueued, savingEdits, sendingEdits, pendingEdits.length, unsavedEdits.length, sendTextEdits]);

  useEffect(() => {
    if (appId && !editsBusy) clearSentTextEdits(appId);
  }, [appId, editsBusy]);

  useEffect(() => {
    if (!textSaved) return;
    const timer = window.setTimeout(() => setTextSaved(false), TEXT_EDITS_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [textSaved]);

  const onEditNow = useCallback(() => {
    if (clearingEdits) return;
    setAnnotating(false);
    setTextMode(false);
    if (readOnly) {
      setEditMode(false);
      showEditHint(READ_ONLY_PREVIEW_HINT);
      return;
    }
    if (editorReady) {
      setEditHint(null);
      armDeadlineRef.current = 0;
      if (picking) togglePicking();
      setEditMode((v) => !v);
      return;
    }
    if (editMode) {
      armDeadlineRef.current = 0;
      setEditMode(false);
      return;
    }
    if (pickerReady || picking) {
      setEditHint(null);
      togglePicking();
      return;
    }
    if (builtApp) {
      setEditHint(null);
      armDeadlineRef.current = Date.now() + EDIT_ARM_GRACE_MS;
      setEditMode(true);
      return;
    }
    if (onEditUnavailable?.()) return;
    showEditHint(
      builtApp
        ? "The inline editor isn’t loaded on this app yet. It’s added to newly built apps; an older app needs a rebuild to enable it. For now, describe your change in the chat."
        : siteApp
          ? SITE_PICKER_MISSING_HINT
          : "This is your external site, not a Zavi-built app, so it can’t be edited inline. Describe the change in the chat and your team will make it.",
    );
    onEditFallback?.();
  }, [
    readOnly,
    editorReady,
    editMode,
    picking,
    pickerReady,
    togglePicking,
    onEditFallback,
    onEditUnavailable,
    builtApp,
    siteApp,
    showEditHint,
    clearingEdits,
  ]);
  const onEdit = useCallback(() => {
    if (!askBeforeDropping(onEditNow)) onEditNow();
  }, [onEditNow, askBeforeDropping]);

  useEffect(() => {
    if (!editMode || editorReady) return;
    const left = armDeadlineRef.current - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => {
      armDeadlineRef.current = 0;
      setEditMode(false);
      if (pickerReadyRef.current) {
        togglePicking();
        return;
      }
      if (onEditUnavailable?.()) return;
      showEditHint(
        siteApp
          ? SITE_PICKER_MISSING_HINT
          : builtApp
            ? "The inline editor didn’t load on this app. Reload the preview, or describe your change in the chat."
            : "This is your external site, not a Zavi-built app, so it can’t be edited inline. Describe the change in the chat and your team will make it.",
      );
      onEditFallback?.();
    }, left);
    return () => clearTimeout(timer);
  }, [
    editMode,
    editorReady,
    builtApp,
    siteApp,
    togglePicking,
    showEditHint,
    onEditFallback,
    onEditUnavailable,
  ]);

  const exitEdit = useCallback(() => {
    const exit = () => {
      if (editMode) setEditMode(false);
      if (picking) togglePicking();
      setSelected(null);
      setEditHint(null);
    };
    if (!askBeforeDropping(exit)) exit();
  }, [editMode, picking, togglePicking, askBeforeDropping]);

  const editActive = editMode || picking;
  const themeBlocked = editActive || textMode || shownTextChanges > 0;
  useEffect(() => {
    if (themeBlocked) setThemeOpen(false);
  }, [themeBlocked]);
  useEffect(() => {
    if (!themeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!themeRef.current || themeRef.current.contains(e.target as Node)) return;
      if (themeLayerRef.current?.()) return;
      setThemeOpen(false);
    };
    const onBlur = () => {
      if (!iframeRef.current || document.activeElement !== iframeRef.current) return;
      if (themeLayerRef.current?.()) {
        iframeRef.current.blur();
        return;
      }
      setThemeOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [themeOpen]);
  const toggleTheme = useCallback(() => {
    setTextMode(false);
    setThemeOpen((o) => !o);
  }, []);

  const startAnnotatingNow = useCallback(() => {
    exitEdit();
    setTextMode(false);
    if (readOnly) {
      showEditHint(READ_ONLY_PREVIEW_HINT);
      return;
    }
    setAnnotating(true);
  }, [exitEdit, readOnly, showEditHint]);
  const startAnnotating = useCallback(() => {
    if (!askBeforeDropping(startAnnotatingNow)) startAnnotatingNow();
  }, [startAnnotatingNow, askBeforeDropping]);
  useEffect(() => {
    if (!readOnly) return;
    setEditMode(false);
    setTextMode(false);
    setAnnotating(false);
    setSelected(null);
    if (picking) togglePicking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);
  useEffect(() => {
    if (!previewBroken) return;
    if (editMode) setEditMode(false);
    if (textMode) setTextMode(false);
    if (annotating) setAnnotating(false);
    if (picking) togglePicking();
    setSelected(null);
  }, [previewBroken, editMode, textMode, annotating, picking, togglePicking]);
  const addStroke = useCallback((stroke: Stroke) => dispatchNotes({ type: "add", stroke }), []);

  useEffect(() => {
    if (!annotating) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.key === "Escape") {
        setAnnotating(false);
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        dispatchNotes({ type: "undo" });
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        dispatchNotes({ type: "redo" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [annotating]);

  const appOrigin = originFrom(liveUrl);

  const navigateTo = useCallback(
    (value: string) => {
      const next = resolveNav(value, appOrigin, url);
      setRouteMenuOpen(false);
      if (!next) return;
      if (!askBeforeDropping(() => setUrl(next))) setUrl(next);
    },
    [appOrigin, url, askBeforeDropping],
  );

  const displayPath = livePath ?? pathFromUrl(url);
  const currentPath = displayPath.split("?")[0] || "/";

  const pickedSelector = selected?.selector ?? null;
  useEffect(() => {
    setToolbarPos(null);
  }, [pickedSelector]);
  const selectedSelector = editMode && selected && !toolbarPos ? selected.selector : null;
  selectedWatchRef.current = selectedSelector;
  useEffect(() => {
    setSelectedBox(null);
    if (!selectedSelector || !editorReady) return;
    const ask = () => postToChild(editorRectsRequestMessage([selectedSelector]));
    ask();
    const timer = window.setInterval(ask, COMMENT_RECTS_POLL_MS);
    return () => {
      window.clearInterval(timer);
      postToChild(editorRectsRequestMessage([]));
    };
  }, [selectedSelector, editorReady, editorBoot, postToChild]);

  useEffect(() => {
    const el = toolbarWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setToolbarSize((prev) => (Math.round(prev.w) === Math.round(r.width) && Math.round(prev.h) === Math.round(r.height) ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [selected, selectedBox !== null]);

  const versioned = url
    ? cacheKey
      ? `${url}${url.includes("?") ? "&" : "?"}_v=${encodeURIComponent(cacheKey)}`
      : url
    : null;
  const src = versioned && !keepPreviewCookie ? liveFrameSrc(versioned) : versioned;

  const toolsBusy =
    editActive ||
    annotating ||
    textMode ||
    themeOpen ||
    shownTextChanges > 0 ||
    unsavedEdits.length > 0 ||
    savingEdits > 0 ||
    sendQueued ||
    sendingEdits ||
    clearingEdits;
  const toolsPlacement = toolsBusy
    ? "dock"
    : toolsPrefs.placement === "hidden" && chromeOverride
      ? "minimized"
      : toolsPrefs.placement;
  const toolsUsable = editPlacement === "dock" && !!src && !previewBroken && !overlayShown && !body;

  const showTools = () => {
    setToolsPrefs({ placement: "dock" });
    setEditHint(null);
  };
  const showToolsButtonRef = useRef<HTMLButtonElement | null>(null);
  const chromeShowToolsRef = useRef<HTMLButtonElement | null>(null);
  const focusShowToolsRef = useRef(false);
  useEffect(() => {
    if (!focusShowToolsRef.current) return;
    focusShowToolsRef.current = false;
    (toolsPlacement === "hidden" ? chromeShowToolsRef.current : toolsPlacement === "minimized" ? showToolsButtonRef.current : null)?.focus();
  }, [toolsPlacement]);

  shortcutRef.current = (key: ShortcutKey, forwarded = false) => {
    if (!toolsUsable || !surfaceActive) return false;
    const shown = bodyRef.current;
    if (!shown || (typeof shown.checkVisibility === "function" && !shown.checkVisibility())) return false;
    if (forwarded && key.key === "Escape") {
      if (annotating) setAnnotating(false);
      else if (editMode && selected) exitSelection();
      else if (editActive) exitEdit();
      else if (textMode) setTextMode(false);
      else if (reportedPickRef.current) {
        reportedPickRef.current = null;
        onSelectionChangeRef.current?.(null);
      } else return false;
      return true;
    }
    if (!toolsPrefs.shortcuts) return false;
    const action = previewShortcutFor(key);
    if (!action) return false;
    switch (action) {
      case "toggleTools": {
        if (forwarded && toolsPrefs.placement === "dock") return false;
        const placement = toolsPrefs.placement === "dock" ? "hidden" : "dock";
        setToolsPrefs({ placement });
        if (placement === "hidden" && !chromeOverride) showEditHint(hiddenToolsHint(true));
        else if (placement === "dock") setEditHint(null);
        return true;
      }
      case "edit":
        if (clearingEdits) return false;
        if (editActive) exitEdit();
        else onEdit();
        return true;
      case "text":
        if (!textToolAvailable || editActive) return false;
        toggleTextMode();
        return true;
      case "annotate":
        if (annotating) setAnnotating(false);
        else startAnnotating();
        return true;
    }
  };

  useEffect(() => {
    if (editPlacement !== "dock") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      if (shortcutRef.current(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editPlacement]);

  const deviceWidth = DEVICE[device].width;
  const DeviceIcon = DEVICE[device].icon;

  const rawScale = stage.w > 0 && deviceWidth ? Math.min(1, stage.w / deviceWidth) : 1;
  const frameWidth = deviceWidth ? Math.max(1, Math.floor(deviceWidth * rawScale)) : 0;
  const scale = deviceWidth ? frameWidth / deviceWidth : 1;

  useEffect(() => {
    const body = bodyRef.current;
    const frame = frameBoxRef.current;
    if (!body || !frame) return;
    const bodyRect = body.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const next = { x: frameRect.left - bodyRect.left, y: frameRect.top - bodyRect.top };
    setFrameOffset((prev) => prev.x === next.x && prev.y === next.y ? prev : next);
  }, [stage.w, stage.h, device, appReady, stillBuilding]);

  const selectedRect = selectedBox && selected && selectedBox.selector === selected.selector ? selectedBox : null;
  const anchoredToolbar =
    editMode && selected && selectedRect && !toolbarPos && stage.h > 0
      ? anchorEditToolbar({ rect: selectedRect, scale, frame: { w: deviceWidth ? frameWidth : stage.w, h: stage.h }, toolbar: toolbarSize })
      : null;
  const toolbarLocation = toolbarPos ?? (anchoredToolbar
    ? { x: frameOffset.x + anchoredToolbar.toolbar.left, y: frameOffset.y + anchoredToolbar.toolbar.top }
    : null);
  const answerLeavePrompt = async (apply: boolean) => {
    const prompt = leavePrompt;
    if (!prompt || prompt.saving) return;
    const draft = draftRef.current;
    if (apply && draft) {
      setLeavePrompt({ ...prompt, saving: true, error: null });
      const saved = await applyDraftConfirmed(draft);
      if (!saved) {
        setLeavePrompt({ ...prompt, saving: false, error: "Couldn't save, try again." });
        return;
      }
      draftRef.current = null;
      setHasDraft(false);
      setDraftAppliedKey((k) => k + 1);
      setLeavePrompt(null);
      if (prompt.afterApply) prompt.then();
      return;
    }
    setDraftResetKey((k) => k + 1);
    draftRef.current = null;
    setHasDraft(false);
    setLeavePrompt(null);
    prompt.then();
  };
  const unappliedPrompt = leavePrompt ? (
    <div
      role="alertdialog"
      aria-label="Unapplied changes"
      data-testid="unapplied-changes"
      className="pointer-events-auto flex items-center gap-2 rounded-xl border border-rule bg-cream px-3 py-2 text-[13px] text-ink shadow-[0_8px_24px_-10px_rgba(14,15,17,0.35)]"
    >
      <span>{leavePrompt.error ?? "You have unapplied changes."}</span>
      <button
        type="button"
        autoFocus
        onClick={() => void answerLeavePrompt(true)}
        disabled={leavePrompt.saving}
        className="inline-flex h-8 items-center rounded-lg bg-ink px-3 text-[12px] font-semibold text-cream hover:bg-ink/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        Apply
      </button>
      <button
        type="button"
        onClick={() => void answerLeavePrompt(false)}
        disabled={leavePrompt.saving}
        className="inline-flex h-8 items-center rounded-lg border border-rule px-3 text-[12px] font-medium text-ink hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
      >
        Discard
      </button>
    </div>
  ) : null;
  const hiddenPrompt =
    unappliedPrompt && !surfaceActive && typeof document !== "undefined"
      ? createPortal(
          <div data-testid="unapplied-changes-floating" className="workspace-shell fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
            {unappliedPrompt}
          </div>,
          document.body,
        )
      : null;
  const editToolbar = selected ? (
    <WebsiteEditorToolbar
      selected={selected}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
      onApply={applyEdit}
      onAskAi={askAiEdit}
      onRequestSiteChange={onRequestSiteChange}
      onDelete={deleteEdit}
      onUndo={undoEdit}
      onRedo={redoEdit}
      onClose={exitSelection}
      onHandlePointerDown={onToolbarHandlePointerDown}
      designControls={siteDesignAvailable && appId && (selected.section || isSitePhoto(selected)) ? (
        <SiteElementDesignControls
          appId={appId}
          path={(livePath ?? pathFromUrl(url)).split("?")[0] || "/"}
          selected={selected}
          onSectionChanged={(message) => {
            exitSelection();
            showEditHint(message);
          }}
        />
      ) : undefined}
      imageUrlField={!(siteDesignAvailable && isSitePhoto(selected))}
      onDraftChange={(patch) => {
        draftRef.current = patch;
        setHasDraft(patch !== null);
      }}
      draftAppliedKey={draftAppliedKey}
      notice={surfaceActive ? unappliedPrompt : null}
      draftResetKey={draftResetKey}
      onBeforeAskAi={(go) => {
        if (!askBeforeDropping(go)) go();
      }}
    />
  ) : null;

  const frameStyle: CSSProperties = deviceWidth
    ? { width: `${frameWidth}px`, height: "100%" }
    : { width: "100%", height: "100%" };
  const snapshotShot = previewSnapshotFor({
    snapshots,
    device,
    path: currentPath,
    liveSeen: liveSeen && overlayShown,
    refreshed: nonce > 0,
    building: !!buildingNote,
    readiness: readiness.state,
  });
  const iframeStyle: CSSProperties | undefined = deviceWidth
    ? {
        width: `${deviceWidth}px`,
        height: stage.h > 0 ? `${stage.h / scale}px` : "100%",
        zoom: scale,
      }
    : undefined;

  const shellClass = `flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-rule bg-cream shadow-sm${
    flush ? " compact:rounded-none compact:border-x-0 compact:border-t-0" : ""
  }`;

  return (
    <div className={shellClass}>
      {hiddenPrompt}
      {}
      {chromeOverride ?? (
      <div data-testid="preview-chrome" className="grid h-12 shrink-0 grid-cols-[1fr_minmax(0,320px)_1fr] items-center gap-3 border-b border-rule bg-cream px-4 [container-type:inline-size]">
        <div className="flex shrink-0 items-center gap-2 justify-self-start">
          {narrowLeading}
          {leading}
          {editPlacement === "header" && (
          <div className="relative flex shrink-0 items-center gap-2">
            <div
              className={`inline-flex h-8 items-center rounded-2xl transition-colors duration-200 ease-out motion-reduce:transition-none ${
                editActive ? "bg-[#0e0f11] text-white" : "text-[#1f1f1f] hover:bg-[#f4f4f4]"
              }`}
            >
              <button
                type="button"
                onClick={onEdit}
                disabled={clearingEdits}
                aria-pressed={editActive}
                aria-label={editActive ? "Editing" : "Edit"}
                className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-2xl pl-2.5 pr-3 text-[13px] font-semibold disabled:cursor-wait disabled:opacity-50 [@container(max-width:440px)]:w-8 [@container(max-width:440px)]:justify-center [@container(max-width:440px)]:px-0"
              >
                <CursorMagicIcon className="h-4 w-4 shrink-0" />
                <EditLabel active={editActive} className="[@container(max-width:440px)]:hidden" />
              </button>
              <CollapsibleExit
                open={editActive}
                onClick={exitEdit}
                className="rounded-r-2xl text-white/70 hover:text-white"
                wrapperClassName="[@container(max-width:440px)]:hidden"
                divider="bg-white/25"
                size="h-8"
              />
            </div>
            {editHint && (
              <div
                role="status"
                className="absolute left-0 top-full z-30 mt-2 w-[320px] rounded-xl border border-[#ececec] bg-white p-3 text-[12px] leading-[1.5] text-[#454545] shadow-[0_12px_36px_-10px_rgba(14,15,17,0.28)]"
              >
                {editHint}
              </div>
            )}
          </div>
          )}
        </div>

        <div data-testid="preview-chrome-center" className="flex min-w-0 items-center justify-center gap-1 [@container(max-width:480px)]:hidden">
            <button
              type="button"
              onClick={() => setDevice(nextDevice(device))}
              aria-label={`Preview width: ${DEVICE[device].label}. Switch to ${DEVICE[nextDevice(device)].label}.`}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#454545] transition-colors hover:bg-[#f4f4f4] hover:text-[#0e0f11] [@container(max-width:400px)]:hidden"
            >
              <DeviceIcon className="h-4 w-4" aria-hidden />
            </button>

          {src ? (
            <div ref={routeMenuRef} className="relative w-full min-w-0">
              <div className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-full border border-[#f0f0f0] bg-white px-3 [@container(max-width:420px)]:gap-1 [@container(max-width:420px)]:px-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!url) return;
                    const reload = () => setNonce((n) => n + 1);
                    if (!askBeforeDropping(reload)) reload();
                  }}
                  aria-label="Reload preview"
                  className="shrink-0 text-[#595959] transition-colors hover:text-[#0e0f11]"
                >
                  <RotateCw className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setRouteMenuOpen(true)}
                  aria-haspopup="menu"
                  aria-expanded={routeMenuOpen}
                  className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-[#0e0f11]"
                >
                  {routeLabelFromPath(displayPath)}
                </button>
                <button
                  type="button"
                  onClick={() => setRouteMenuOpen((v) => !v)}
                  aria-label="Go to a route"
                  aria-haspopup="menu"
                  aria-expanded={routeMenuOpen}
                  className="shrink-0 text-[#8c8c8c] transition-colors hover:text-[#0e0f11] [@container(max-width:420px)]:hidden"
                >
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${routeMenuOpen ? "rotate-180" : ""}`}
                  />
                </button>
              </div>
              {routeMenuOpen && (
                <RouteMenu
                  routes={routes}
                  currentPath={currentPath}
                  onNavigate={navigateTo}
                />
              )}
            </div>
          ) : body && notLiveAddress && !notLiveAddress.host && notLiveAddress.label !== undefined ? (
            <div aria-hidden className="h-8" />
          ) : body && notLiveAddress ? (
            <div
              data-testid="preview-address-planned"
              className="flex h-8 w-full min-w-0 items-center justify-center gap-1 rounded-full border border-[#f0f0f0] bg-white px-3 text-[13px]"
            >
              {notLiveAddress.host ? (
                <>
                  <span className="min-w-0 truncate font-medium text-[#0e0f11]">{notLiveAddress.host}</span>
                  {notLiveAddress.label === undefined && (
                    <span className="shrink-0 text-[#8c8c8c]">· {NOT_LIVE_YET}</span>
                  )}
                </>
              ) : (
                <span className="truncate text-[#595959]">{NOT_LIVE_YET}</span>
              )}
            </div>
          ) : body ? (
            <div
              data-testid="preview-address-pending"
              className="flex h-8 w-full min-w-0 items-center justify-center rounded-full border border-[#f0f0f0] bg-white px-3"
            >
              <span className="h-2.5 w-24 animate-pulse rounded-full bg-[#ececec] motion-reduce:animate-none" />
            </div>
          ) : (
            <div aria-hidden className="h-8" />
          )}

          {src && (
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open in a new page"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#454545] transition-colors hover:bg-[#f4f4f4] hover:text-[#0e0f11] [@container(max-width:480px)]:hidden"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
              </a>
          )}
        </div>

        <div className="col-start-3 flex shrink-0 items-center gap-0 justify-self-end">
          {editPlacement === "dock" && src && toolsPlacement === "hidden" && (
            <button
              ref={chromeShowToolsRef}
              type="button"
              onClick={showTools}
              aria-label="Show preview tools"
              title="Show preview tools"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#454545] transition-colors hover:bg-[#f4f4f4] hover:text-[#0e0f11] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <Eye className="h-4 w-4" aria-hidden />
            </button>
          )}
          {narrowTrailing}
          {headerActions}
        </div>
      </div>
      )}

      {}

      {}
      <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-hidden bg-creamDeep/45 p-2">
        {}
        {editMode && selected && (
          <div
            data-testid={anchoredToolbar ? "edit-toolbar-anchor" : undefined}
            className={
              toolbarLocation
                ? "pointer-events-none absolute z-20"
                : "pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3"
            }
            style={toolbarLocation ? {
              left: toolbarLocation.x,
              top: toolbarLocation.y,
              maxWidth: anchoredToolbar ? Math.max(0, (deviceWidth ? frameWidth : stage.w) - 16) : "calc(100% - 16px)",
              maxHeight: "calc(100% - 16px)",
            } : undefined}
          >
            <div ref={toolbarWrapRef} className="pointer-events-none inline-flex max-h-full max-w-full overflow-y-auto">
              {editToolbar}
            </div>
          </div>
        )}
        {editPlacement === "dock" && src && (
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-3">
            <div className="pointer-events-auto relative">
              <PreviewErrorPill
                frameRef={iframeRef}
                src={src}
                yieldTo={!!editHint}
                onLogOpenChange={setErrorLogOpen}
                onVisibleChange={setPreviewBroken}
              />
              {editHint && (
                <div
                  role="status"
                  className="absolute bottom-full left-1/2 mb-2 w-[320px] max-w-[calc(100vw-48px)] -translate-x-1/2 rounded-xl border border-rule bg-cream p-3 text-[12px] leading-[1.5] text-inkSoft shadow-elev"
                >
                  {editHint}
                </div>
              )}
              {!previewBroken && !overlayShown && toolsPlacement === "minimized" && (
                <button
                  ref={showToolsButtonRef}
                  type="button"
                  onClick={showTools}
                  aria-label="Show preview tools"
                  title="Show preview tools"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-rule bg-cream text-ink shadow-pop transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 animate-pane-fade motion-reduce:animate-none"
                >
                  <Ellipsis className="h-4 w-4" aria-hidden />
                </button>
              )}
              {!previewBroken && !overlayShown && toolsPlacement === "dock" && (
                <div
                  role="toolbar"
                  aria-label="Preview tools"
                  className="inline-flex h-11 items-center gap-1 rounded-full border border-rule bg-cream p-1 shadow-pop"
                >
                  {annotating ? (
                    <div key="annotate" className="flex items-center animate-pane-fade motion-reduce:animate-none">
                    <AnnotationBar
                      canUndo={notes.past.length > 0}
                      canRedo={notes.future.length > 0}
                      canClear={notes.strokes.length > 0}
                      onUndo={() => dispatchNotes({ type: "undo" })}
                      onRedo={() => dispatchNotes({ type: "redo" })}
                      onClear={() => dispatchNotes({ type: "clear" })}
                      onExit={() => setAnnotating(false)}
                    />
                    </div>
                  ) : editMode && selected ? (
                    <div key="selection" className="flex items-center gap-2 animate-pane-fade motion-reduce:animate-none">
                      <span
                        aria-hidden
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-cream"
                      >
                        <SquareDashedMousePointer className="h-4 w-4" />
                      </span>
                      <span role="status" className="whitespace-nowrap pr-6 text-[14px] font-medium text-ink">
                        1 selection
                      </span>
                      <button
                        type="button"
                        onClick={exitSelection}
                        className="inline-flex h-9 items-center rounded-full border border-rule bg-cream px-4 text-[13px] font-medium text-ink transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
                      >
                        Clear
                      </button>
                    </div>
                  ) : (
                    <div key="edit" className="flex items-center gap-1 animate-pane-fade motion-reduce:animate-none">
                      <div
                        className={`inline-flex h-9 items-center rounded-full transition-colors duration-200 ease-out motion-reduce:transition-none ${
                          editActive ? "bg-ink text-cream" : "text-ink hover:bg-bone"
                        }`}
                      >
                          <button
                            type="button"
                            onClick={onEdit}
                            disabled={clearingEdits}
                            aria-pressed={editActive}
                            aria-label={editActive ? "Editing" : "Edit"}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:cursor-wait disabled:opacity-50"
                          >
                            <CursorMagicIcon className="h-4 w-4 shrink-0" />
                          </button>
                        <CollapsibleExit
                          open={editActive}
                          onClick={exitEdit}
                          className="-ml-1.5 rounded-full text-cream/70 hover:text-cream"
                          size="h-9"
                        />
                      </div>
                        {textToolAvailable && !editActive && (
                          <button
                            type="button"
                            onClick={toggleTextMode}
                            aria-pressed={textMode}
                            aria-label={textMode ? "Stop editing text" : "Edit text"}
                            className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${
                              textMode ? "bg-ink text-cream" : "text-ink hover:bg-bone"
                            }`}
                          >
                            <Type className="h-4 w-4" aria-hidden />
                          </button>
                        )}
                        {textToolAvailable && shownTextChanges > 0 && !editActive && (
                          <div className="flex items-center gap-2 pl-1">
                            <span role="status" className="whitespace-nowrap px-2 text-[14px] font-medium text-ink">
                              {textChangeLabel(shownTextChanges)}
                            </span>
                            <button
                              type="button"
                              onClick={() => void clearTextEdits()}
                              disabled={sendingEdits}
                              className="inline-flex h-9 items-center rounded-full border border-rule bg-cream px-4 text-[13px] font-medium text-ink transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:opacity-50"
                            >
                              Clear
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (savingEdits > 0) {
                                  queuedSnapshotRef.current = [...pendingSnapshotRef.current.values()].map((snapshot) => ({ ...snapshot }));
                                  setSendQueued(true);
                                } else {
                                  void sendTextEdits();
                                }
                              }}
                              disabled={sendQueued || sendingEdits || unsavedEdits.length > 0 || editsBusy}
                              title={editsBusy ? TEXT_EDITS_BUSY : unsavedEdits.length > 0 ? TEXT_EDIT_NOT_SAVED : undefined}
                              className="inline-flex h-9 items-center rounded-full bg-[#fff] px-4 text-[13px] font-medium !text-[#0e0f11] transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 disabled:!text-[#0e0f11] disabled:opacity-50"
                            >
                              {sendQueued ? "Sending..." : "Send"}
                            </button>
                          </div>
                        )}
                        {textToolAvailable && textSaved && shownTextChanges === 0 && !editActive && (
                          <span role="status" className="inline-flex items-center gap-2 whitespace-nowrap px-2 text-[14px] font-medium text-ink">
                            <Check className="h-3.5 w-3.5" aria-hidden />
                            {TEXT_EDITS_SAVED}
                          </span>
                        )}
                        {siteDesignAvailable && !editActive && !(textToolAvailable && shownTextChanges > 0) && (
                          <div ref={themeRef} className="relative">
                            <button
                              type="button"
                              onClick={toggleTheme}
                              aria-pressed={themeOpen}
                              aria-label="Theme"
                              className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${
                                themeOpen ? "bg-ink text-cream" : "text-ink hover:bg-bone"
                              }`}
                            >
                              <Palette className="h-4 w-4" aria-hidden />
                            </button>
                            {themeOpen && appId && (
                              <div className="absolute bottom-full left-1/2 z-30 mb-3 -translate-x-1/2">
                                <SiteThemePanel
                                  appId={appId}
                                  onClose={() => setThemeOpen(false)}
                                  onDraft={postToChild}
                                  onApplied={() => setNonce((n) => n + 1)}
                                  dismissLayerRef={themeLayerRef}
                                />
                              </div>
                            )}
                          </div>
                        )}
                        {!editActive && !(textToolAvailable && shownTextChanges > 0) && (
                          <button
                            type="button"
                            onClick={startAnnotating}
                            aria-label="Annotate"
                            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink transition-colors hover:bg-bone focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
                          >
                            <PenLine className="h-4 w-4" aria-hidden />
                          </button>
                        )}
                        {!toolsBusy && (
                          <PreviewToolsMenu
                            prefs={toolsPrefs}
                            onPlacement={(placement) => {
                              focusShowToolsRef.current = placement !== "dock";
                              setToolsPrefs({ placement });
                              if (placement === "hidden" && !chromeOverride) showEditHint(hiddenToolsHint(toolsPrefs.shortcuts));
                            }}
                            onShortcuts={(shortcuts) => setToolsPrefs({ shortcuts })}
                            frameRef={iframeRef}
                          />
                        )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {body ? (
          <div data-testid="preview-body-override" className="h-full min-h-0 overflow-y-auto">
            {body}
          </div>
        ) : !src ? (
          <EmptyPreview
            onSubmit={(value) => {
              const next = resolveNav(value, appOrigin);
              if (next) setUrl(next);
            }}
          />
        ) : (
          <div className="relative h-full w-full">
            {stillBuilding && (
              <div data-testid="preview-still-building" className="absolute inset-0 z-10">
                <StillBuildingScreen />
              </div>
            )}
            {!stillBuilding && (overlayShown || !overlayGone) && (
              <div
                data-testid={
                  overlayShown
                    ? !appReady
                      ? "preview-readiness-gate"
                      : awaitingRender && loaded
                        ? "preview-awaiting-render"
                        : "preview-loading"
                    : "preview-loading-fading"
                }
                aria-hidden={overlayShown ? undefined : true}
                className={`absolute inset-0 z-10 transition-opacity duration-300 ease-out motion-reduce:transition-none ${
                  overlayShown ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
              >
                {}
                {appReady && buildingNote ? (
                  <StillBuildingScreen />
                ) : snapshotShot ? (
                  <PreviewSnapshotCover shot={snapshotShot} frameStyle={frameStyle} />
                ) : (
                  <AppStartingScreen
                    state={appReady ? "loading" : readiness.state}
                    openUrl={url}
                    onRetry={readiness.retry}
                  />
                )}
              </div>
            )}
            {appReady && !stillBuilding && buildingNote ? (
              <div
                data-testid="preview-building-note"
                role="status"
                aria-live="polite"
                className={`pointer-events-none absolute inset-x-0 z-[8] flex justify-center px-4 ${
                  editPlacement === "dock" ? "bottom-[76px]" : "bottom-4"
                }`}
              >
                <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-rule bg-cream/95 px-3.5 py-1.5 text-[12.5px] font-medium text-ink shadow-sm">
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#4f46e5] motion-reduce:animate-none" />
                  <span className="truncate">{buildingNote}</span>
                </span>
              </div>
            ) : null}
            {appReady && !stillBuilding && (
              <div ref={stageRef} className="flex h-full w-full justify-center overflow-hidden">
                <div
                  data-testid="preview-frame"
                  ref={frameBoxRef}
                  className="relative shrink-0 overflow-hidden rounded-2xl border border-rule bg-cream shadow-sm"
                  style={frameStyle}
                >
                  <span
                    aria-hidden
                    data-testid="edit-frame-ring"
                    className={`pointer-events-none absolute inset-0 z-[7] rounded-[15px] shadow-[inset_0_0_0_2px_#4f46e5,inset_0_0_0_5px_rgba(79,70,229,0.16)] transition-opacity duration-200 ease-out motion-reduce:transition-none ${
                      editActive || annotating ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  {annotating && <AnnotationCanvas strokes={notes.strokes} onStroke={addStroke} />}
                  {anchoredToolbar && selected && (
                    <>
                      <span
                        data-testid="edit-selection-tag"
                        className="pointer-events-none absolute z-20 inline-flex h-6 items-center gap-1 rounded-md bg-[#3b5bdb] px-2 text-[12px] font-medium text-white shadow-sm"
                        style={{ left: anchoredToolbar.chip.left, top: anchoredToolbar.chip.top }}
                      >
                        {selected.tag}
                        <ChevronDown className="h-3 w-3" aria-hidden />
                      </span>

                    </>
                  )}
                  {}
                  <iframe
                    ref={iframeRef}
                    key={`${src}#${nonce}`}
                    src={src}
                    title="Live preview of your app"
                    sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
                    referrerPolicy="no-referrer"
                    className="border-0"
                    style={iframeStyle ?? { width: "100%", height: "100%" }}
                    onLoad={() => {
                      setLoaded(true);
                      loadedRef.current = true;
                      setBlocked(false);
                      postToChild({ type: PREVIEW_RENDER_HELLO });
                    }}
                  />
                  {renderGaveUp && (
                    <PreviewNotice openUrl={url} onRetry={retryRender}>
                      {PREVIEW_RENDER_GAVE_UP}
                    </PreviewNotice>
                  )}
                  {}
                  {blocked && !loaded && (
                    <PreviewNotice openUrl={url} onRetry={() => setNonce((n) => n + 1)}>
                      It may still be waking up, or it blocks inline embedding.
                      You can open it in a new tab or try the preview again.
                    </PreviewNotice>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewNotice({
  children,
  openUrl,
  onRetry,
}: {
  children: ReactNode;
  openUrl: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-creamDeep/80 px-6 backdrop-blur-[2px]">
      <div
        role="status"
        data-testid="preview-notice-card"
        className="flex w-full max-w-[500px] flex-col items-center rounded-[28px] border border-rule bg-cream/95 px-8 py-9 text-center shadow-[0_18px_55px_-38px_rgba(14,15,17,0.5)]"
      >
        <span className="mb-5 inline-flex h-11 w-11 items-center justify-center rounded-full bg-bone text-ink" aria-hidden>
          <Clock className="h-5 w-5" />
        </span>
        <h2 className="font-display text-[24px] font-bold leading-tight tracking-tight text-ink">
          Preview is still loading
        </h2>
        <p className="mt-3 max-w-[400px] text-[14px] leading-[1.6] text-inkMuted">{children}</p>
        <div className="mt-7 flex items-center gap-2">
          <a
            href={openUrl ?? undefined}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-semibold text-cream transition-colors hover:bg-ink/85"
          >
            <ExternalLink className="h-4 w-4" /> Open your app
          </a>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-rule bg-cream px-4 text-[13px] font-semibold text-ink transition-colors hover:bg-bone"
          >
            <RotateCw className="h-4 w-4" /> Try again
          </button>
        </div>
      </div>
    </div>
  );
}

export function StillBuildingScreen() {
  return (
    <Field live>
      <WaitingCard
        testId="still-building-card"
        media={<BuildLottie />}
        title={STILL_BUILDING_TITLE}
        meter={<WaitingMeter label="Still building" />}
        body={STILL_BUILDING_BODY}
      />
    </Field>
  );
}

export function previewSnapshotFor(input: {
  snapshots: Partial<Record<"desktop" | "mobile", PreviewSnapshot>>;
  device: Device;
  path: string;
  liveSeen: boolean;
  refreshed: boolean;
  building: boolean;
  readiness: AppReadiness;
}): PreviewSnapshot | null {
  if (input.liveSeen || input.refreshed || input.building || input.path !== "/") return null;
  if (input.readiness !== "checking" && input.readiness !== "ready") return null;
  if (input.device === "tablet") return null;
  return input.snapshots[input.device] ?? null;
}

function PreviewSnapshotCover({ shot, frameStyle }: { shot: PreviewSnapshot; frameStyle: CSSProperties }) {
  return (
    <div data-testid="preview-snapshot" className="relative flex h-full w-full justify-center overflow-hidden bg-cream">
      <div className="relative shrink-0 overflow-hidden rounded-2xl border border-rule bg-white shadow-sm" style={frameStyle}>
        <img src={shot.url} alt="" draggable={false} className="pointer-events-none h-full w-full select-none object-cover object-top" />
      </div>
      <span
        role="status"
        className="pointer-events-none absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-2 rounded-full border border-rule bg-cream/95 px-3.5 py-1.5 text-[12.5px] font-medium text-ink shadow-sm"
      >
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#4f46e5] motion-reduce:animate-none" />
        Loading the live site…
      </span>
    </div>
  );
}

export function AppStartingScreen({
  state,
  openUrl,
  onRetry,
}: {
  state: AppReadiness | "loading";
  openUrl: string | null;
  onRetry: () => void;
}) {
  const waiting = state === "checking" || state === "loading";
  return (
    <Field live={waiting}>
      <WaitingCard
        testId="app-starting-card"
        media={
          waiting ? (
            <BuildLottie />
          ) : (
            <span aria-hidden className={`${WAITING_ICON_CLASS} bg-bone text-ink`}>
              {state === "suspended" ? <Pause className="h-5 w-5" /> : <Clock className="h-5 w-5" />}
            </span>
          )
        }
        meter={waiting ? <WaitingMeter label="Loading your app" /> : null}
        title={
          state === "loading"
            ? "Loading your app…"
            : state === "checking"
              ? "Waking up your app"
              : state === "suspended"
                ? "This app is paused"
                : "Your app is taking longer than usual to start"
        }
        body={
          state === "loading"
            ? "Your preview will open here automatically."
            : state === "checking"
              ? "This can take up to a minute. Your preview will open automatically as soon as it’s ready."
              : state === "suspended"
                ? "It isn’t taking visitors right now, so there’s nothing to preview. Check again once it’s back on."
                : "Open it in a new tab, or try again."
        }
        actions={
          waiting ? null : (
            <>
              <a
                href={openUrl ?? undefined}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-semibold text-cream transition-colors hover:bg-ink/85"
              >
                <ExternalLink className="h-4 w-4" /> Open your app
              </a>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex h-10 items-center gap-2 rounded-full border border-rule bg-cream px-4 text-[13px] font-semibold text-ink transition-colors hover:bg-bone"
              >
                <RotateCw className="h-4 w-4" /> Try again
              </button>
            </>
          )
        }
      />
    </Field>
  );
}

function EditLabel({ active, className }: { active: boolean; className?: string }) {
  return (
    <span data-testid="edit-label" className={`inline-flex items-baseline ${className ?? ""}`}>
      <span>Edit</span>
      <span
        aria-hidden={!active}
        className={`inline-block overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 ease-out motion-reduce:transition-none ${
          active ? "max-w-[3ch] opacity-100" : "max-w-0 opacity-0"
        }`}
      >
        ing
      </span>
    </span>
  );
}

function CollapsibleExit({
  open,
  onClick,
  className,
  wrapperClassName,
  divider,
  size,
}: {
  open: boolean;
  onClick: () => void;
  className: string;
  wrapperClassName?: string;
  divider?: string;
  size: "h-8" | "h-9";
}) {
  const width = size === "h-8" ? "max-w-[2.5rem]" : "max-w-[2.25rem]";
  return (
    <span
      aria-hidden={!open}
      data-testid="edit-exit"
      className={`inline-flex items-center overflow-hidden transition-[max-width,opacity] duration-200 ease-out motion-reduce:transition-none ${
        open ? `${width} opacity-100` : "pointer-events-none max-w-0 opacity-0"
      } ${wrapperClassName ?? ""}`}
    >
      {divider && <span aria-hidden className={`h-4 w-px shrink-0 ${divider}`} />}
      <button
        type="button"
        onClick={onClick}
        tabIndex={open ? 0 : -1}
        aria-label="Exit edit mode"
        className={`inline-flex ${size} ${size === "h-8" ? "w-8" : "w-9"} shrink-0 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 ${className}`}
      >
        <X className="h-4 w-4" />
      </button>
    </span>
  );
}

function RouteMenu({
  routes,
  currentPath,
  onNavigate,
}: {
  routes: string[];
  currentPath: string;
  onNavigate: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? routes.filter((r) => r.toLowerCase().includes(q)) : routes;
  const isDynamic = (r: string) => r.includes(":") || r.includes("*");
  const dynamicHintId = useId();
  const anyDynamic = filtered.some(isDynamic);

  return (
    <div
      role="menu"
      className="absolute left-1/2 z-20 mt-1.5 flex max-h-[360px] w-[260px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-[#ececec] bg-white shadow-lg"
    >
      {}
      <div className="flex items-center gap-2 border-b border-[#f0f0f0] px-3 py-2">
        <Search className="h-4 w-4 shrink-0 text-[#8c8c8c]" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) onNavigate(query.trim());
          }}
          placeholder="Search or type a route…"
          aria-label="Search or type a route"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[#0e0f11] outline-none placeholder:text-[#8c8c8c]"
        />
      </div>

      {}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] leading-5 text-[#8c8c8c]">
            {routes.length === 0
              ? "No routes reported yet. Type a path above and press Enter."
              : "No routes match. Press Enter to go to what you typed."}
          </div>
        ) : (
          filtered.map((r) => {
            const dynamic = isDynamic(r);
            const active = r === currentPath;
            return (
              <button
                key={r}
                type="button"
                role="menuitem"
                disabled={dynamic}
                aria-describedby={dynamic ? dynamicHintId : undefined}
                onClick={() => onNavigate(r)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors ${
                  dynamic
                    ? "cursor-not-allowed text-[#c0c0c0]"
                    : active
                      ? "font-semibold text-[#0e0f11] hover:bg-[#f9f9f9]"
                      : "text-[#1f1f1f] hover:bg-[#f9f9f9]"
                }`}
              >
                <span className="truncate">
                  {r}
                  {r === "/" && <span className="ml-1.5 text-[#8c8c8c]">(home)</span>}
                </span>
                {active && <Check className="h-4 w-4 shrink-0 text-[#0e0f11]" />}
              </button>
            );
          })
        )}
      </div>
      {anyDynamic && (
        <p id={dynamicHintId} className="border-t border-[#f0f0f0] px-3 py-2 text-[11px] leading-4 text-[#8c8c8c]">
          Greyed routes need a real value in place of :id or *. Type the full path above and press Enter.
        </p>
      )}
    </div>
  );
}

function EmptyPreview({ onSubmit }: { onSubmit: (value: string) => void }) {
  const [value, setValue] = useState("");
  const submit = () => {
    const t = value.trim();
    if (t) onSubmit(t);
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-xl bg-[#f0f0f0] text-[#8c8c8c]">
        <ExternalLink className="h-5 w-5" />
      </div>
      <p className="max-w-[360px] text-[13px] leading-5 text-[#595959]">
        Your built app will preview here. Enter a URL below to load a site now.
      </p>
      <div className="flex w-full max-w-[420px] items-center gap-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="/route or a URL"
          aria-label="Route or URL"
          className="h-10 min-w-0 flex-1 rounded-lg border border-[#e5e5e5] bg-white px-3 text-[13px] font-medium text-[#0e0f11] outline-none transition-colors placeholder:text-[#8c8c8c] focus:border-[#0e0f11]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim()}
          className="inline-flex h-10 shrink-0 items-center rounded-cta bg-[#0e0f11] px-4 text-[13px] font-semibold text-white transition-colors hover:bg-[#0e0f11]/85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Load
        </button>
      </div>
    </div>
  );
}
