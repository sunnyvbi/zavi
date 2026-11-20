import { useCallback, useEffect, useRef, useState } from "react";

export type ToolsPlacement = "dock" | "minimized" | "hidden";
export type PreviewToolsPrefs = { placement: ToolsPlacement; shortcuts: boolean };

export const PREVIEW_TOOLS_STORAGE_KEY = "zavi:preview-tools:v1";
export const DEFAULT_PREVIEW_TOOLS_PREFS: PreviewToolsPrefs = { placement: "dock", shortcuts: true };
const PLACEMENTS: readonly ToolsPlacement[] = ["dock", "minimized", "hidden"];

export function parsePreviewToolsPrefs(raw: string | null): PreviewToolsPrefs {
  if (!raw) return DEFAULT_PREVIEW_TOOLS_PREFS;
  try {
    const value = JSON.parse(raw) as { placement?: unknown; shortcuts?: unknown } | null;
    return {
      placement: PLACEMENTS.includes(value?.placement as ToolsPlacement)
        ? (value!.placement as ToolsPlacement)
        : DEFAULT_PREVIEW_TOOLS_PREFS.placement,
      shortcuts: typeof value?.shortcuts === "boolean" ? value.shortcuts : DEFAULT_PREVIEW_TOOLS_PREFS.shortcuts,
    };
  } catch {
    return DEFAULT_PREVIEW_TOOLS_PREFS;
  }
}

function readStoredPrefs(): PreviewToolsPrefs | null {
  try {
    return parsePreviewToolsPrefs(window.localStorage.getItem(PREVIEW_TOOLS_STORAGE_KEY));
  } catch {
    return null;
  }
}

const PREFS_EVENT = "zavi:preview-tools-prefs";

export function usePreviewToolsPrefs(): [PreviewToolsPrefs, (patch: Partial<PreviewToolsPrefs>) => void] {
  const [prefs, setPrefs] = useState<PreviewToolsPrefs>(DEFAULT_PREVIEW_TOOLS_PREFS);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => {
    const sync = () => {
      const stored = readStoredPrefs();
      if (stored) setPrefs(stored);
    };
    sync();
    const onStorage = (event: StorageEvent) => {
      if (event.key === PREVIEW_TOOLS_STORAGE_KEY) sync();
    };
    window.addEventListener(PREFS_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(PREFS_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const update = useCallback((patch: Partial<PreviewToolsPrefs>) => {
    const next = { ...(readStoredPrefs() ?? prefsRef.current), ...patch };
    setPrefs(next);
    try {
      window.localStorage.setItem(PREVIEW_TOOLS_STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event(PREFS_EVENT));
    } catch {
    }
  }, []);
  return [prefs, update];
}

export type PreviewShortcut = "edit" | "text" | "annotate" | "toggleTools";

export const PREVIEW_SHORTCUTS: ReadonlyArray<{ action: PreviewShortcut; keys: string; label: string }> = [
  { action: "edit", keys: "E", label: "Select an element" },
  { action: "text", keys: "T", label: "Edit text" },
  { action: "annotate", keys: "A", label: "Draw on the page" },
  { action: "toggleTools", keys: "⌘ .", label: "Show or hide tools" },
];

const LETTER_ACTIONS: Record<string, PreviewShortcut> = { e: "edit", t: "text", a: "annotate" };

export type ShortcutKey = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
};

export function previewShortcutFor(event: ShortcutKey): PreviewShortcut | null {
  if (event.repeat) return null;
  const key = event.key.toLowerCase();
  const mod = !!event.metaKey || !!event.ctrlKey;
  if (key === "." && mod && !event.altKey && !event.shiftKey) return "toggleTools";
  if (mod || event.altKey || event.shiftKey) return null;
  return LETTER_ACTIONS[key] ?? null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  return typeof el.closest === "function" && !!el.closest('[contenteditable]:not([contenteditable="false"])');
}

export function shortcutLabel(isMac: boolean, keys: string): string {
  return isMac ? keys : keys.replace("⌘ ", "Ctrl ");
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
}

export function hiddenToolsHint(shortcuts: boolean, isMac: boolean = isMacPlatform()): string {
  const keys = shortcuts ? `Press ${isMac ? "⌘ ." : "Ctrl ."} or use ` : "Use ";
  return `Preview tools hidden. ${keys}the eye button at the top right of the preview to bring them back.`;
}
