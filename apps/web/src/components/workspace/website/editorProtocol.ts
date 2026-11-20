
export const EDITOR_MODE_TYPE = "zavi:editor-mode";
export const EDITOR_APPLY_TYPE = "zavi:editor-apply";
export const EDITOR_DELETE_TYPE = "zavi:editor-delete";
export const EDITOR_UNDO_TYPE = "zavi:editor-undo";
export const EDITOR_REDO_TYPE = "zavi:editor-redo";
export const EDITOR_DESELECT_TYPE = "zavi:editor-deselect";

export const EDITOR_READY_TYPE = "zavi:editor-ready";
export const EDITOR_SELECTED_TYPE = "zavi:editor-selected";
export const EDITOR_DESELECTED_TYPE = "zavi:editor-deselected";
export const EDITOR_HISTORY_TYPE = "zavi:editor-history";
export const EDITOR_ROUTES_TYPE = "zavi:editor-routes";
export const EDITOR_LOCATION_TYPE = "zavi:editor-location";
export const EDITOR_OUTLINE_REQUEST_TYPE = "zavi:editor-outline-request";
export const EDITOR_OUTLINE_TYPE = "zavi:editor-outline";
export const EDITOR_APPLIED_TYPE = "zavi:editor-applied";
export const EDITOR_TEXT_EDITED_TYPE = "zavi:editor-text-edited";
export const EDITOR_TEXT_SUBMIT_TYPE = "zavi:editor-text-submit";
export const TEXT_TOOL_PROTOCOL = 3;
export const EDITOR_TEXT_REVERT_TYPE = "zavi:editor-text-revert";
export const TEXT_REVERT_PROTOCOL = 4;
export const EDITOR_THEME_DRAFT_TYPE = "zavi:editor-theme-draft";
export const THEME_DRAFT_PROTOCOL = 5;
export const EDITOR_COMMENT_PICK_TYPE = "zavi:editor-comment-pick";
export const EDITOR_RECTS_REQUEST_TYPE = "zavi:editor-rects-request";
export const EDITOR_RECTS_TYPE = "zavi:editor-rects";
export const EDITOR_KEY_TYPE = "zavi:editor-key";
export const MAX_WATCHED_SELECTORS = 100;
export const MAX_ANCHOR_TEXT = 160;

export const EDITABLE_STYLE_KEYS = [
  "color",
  "backgroundColor",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "textAlign",
] as const;
export type EditStyleKey = (typeof EDITABLE_STYLE_KEYS)[number];
export type EditStyle = Partial<Record<EditStyleKey, string>>;

export const EDITABLE_ATTR_KEYS = ["href", "src"] as const;
export type EditAttrKey = (typeof EDITABLE_ATTR_KEYS)[number];
export type EditAttrs = Partial<Record<EditAttrKey, string>>;

export type EditPatch = {
  text?: string;
  segments?: Array<string | null>;
  style?: EditStyle;
  attrs?: EditAttrs;
};

export type SelectedElement = {
  selector: string;
  tag: string;
  text: string;
  textEditable: boolean;
  segments?: string[];
  protocol?: number;
  style: EditStyle;
  attrs?: EditAttrs;
  section?: string;
};

export const MAX_SELECTOR_LENGTH = 400;
export const MAX_TEXT_LENGTH = 5000;
export const MAX_STYLE_VALUE_LENGTH = 120;
export const MAX_ROUTES = 300;
export const MAX_ROUTE_LENGTH = 200;
export const MAX_URL_LENGTH = 2048;
export const MAX_SEGMENTS = 40;
export const MAX_OUTLINE = 150;
export const MAX_OUTLINE_TEXT = 160;

export type OutlineElement = { selector: string; tag: string; text: string };

const SAFE_ROUTE = /^\/[A-Za-z0-9_\-./:*?=&%~]*$/;

const SAFE_SELECTOR_CHARS = /^[A-Za-z0-9_\-.#[\]=:()>+~*, \t]+$/;

const SAFE_STYLE_VALUE = /^[A-Za-z0-9 #%().,'"/-]+$/;
const FORBIDDEN_STYLE_TOKENS = /url\s*\(|javascript:|expression\s*\(|@import|<|>/i;

export function isSafeSelector(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const t = raw.trim();
  if (t.length === 0 || t.length > MAX_SELECTOR_LENGTH) return false;
  return SAFE_SELECTOR_CHARS.test(t);
}

const SAFE_TAG = /^[a-z][a-z0-9-]{0,30}$/;
const SAFE_SECTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function sanitizeStyleValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > MAX_STYLE_VALUE_LENGTH) return null;
  if (!SAFE_STYLE_VALUE.test(t)) return null;
  if (FORBIDDEN_STYLE_TOKENS.test(t)) return null;
  return t;
}

export function sanitizeStyle(raw: unknown): EditStyle {
  const out: EditStyle = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of EDITABLE_STYLE_KEYS) {
    const v = sanitizeStyleValue(obj[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}

const HREF_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);
const SRC_SCHEMES = new Set(["https:"]);
const URL_PARSE_BASE = "https://base.invalid/";

export function sanitizeUrl(key: EditAttrKey, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > MAX_URL_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return null;
  if (/\s/.test(t)) return null;
  if (/\\/.test(t)) return null;
  if (/%00/i.test(t)) return null;
  if (t.startsWith("//")) return null;

  const scheme = t.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) {
    let proto: string;
    try {
      proto = new URL(t).protocol.toLowerCase();
    } catch {
      return null;
    }
    const allowed = key === "href" ? HREF_SCHEMES : SRC_SCHEMES;
    return allowed.has(proto) ? t : null;
  }

  if (t.startsWith("#")) return key === "href" ? t : null;
  try {
    if (new URL(t, URL_PARSE_BASE).protocol.toLowerCase() !== "https:") return null;
  } catch {
    return null;
  }
  return t;
}

export function sanitizeAttrs(raw: unknown): EditAttrs {
  const out: EditAttrs = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of EDITABLE_ATTR_KEYS) {
    if (!(key in obj)) continue;
    const v = sanitizeUrl(key, obj[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}

export function sanitizeSegments(raw: unknown): Array<string | null> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEGMENTS) return null;
  let words = 0;
  for (const s of raw) {
    if (s === null) continue;
    if (typeof s !== "string" || s.length > MAX_TEXT_LENGTH || !s.trim()) return null;
    words++;
  }
  return words > 0 ? (raw as Array<string | null>) : null;
}

export function sanitizeRuns(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SEGMENTS) return null;
  if (!raw.every((s) => typeof s === "string")) return null;
  return (raw as string[]).map((s) => s.slice(0, MAX_TEXT_LENGTH));
}

export function runtimeProtocol(data: unknown): number {
  const v = typeof data === "object" && data !== null ? (data as { protocol?: unknown }).protocol : undefined;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 1;
}

export function sanitizePatch(patch: EditPatch): EditPatch {
  const out: EditPatch = {};
  if (typeof patch.text === "string") {
    out.text = patch.text.slice(0, MAX_TEXT_LENGTH);
  }
  const segments = sanitizeSegments(patch.segments);
  if (segments) out.segments = segments;
  const style = sanitizeStyle(patch.style);
  if (Object.keys(style).length > 0) out.style = style;
  const attrs = sanitizeAttrs(patch.attrs);
  if (Object.keys(attrs).length > 0) out.attrs = attrs;
  return out;
}

function originOk(origin: string, expected: string | null): boolean {
  return !!expected && origin === expected;
}

export function isEditorReady(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): boolean {
  if (!originOk(origin, expectedOrigin)) return false;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === EDITOR_READY_TYPE
  );
}

export function isEditorDeselected(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): boolean {
  if (!originOk(origin, expectedOrigin)) return false;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === EDITOR_DESELECTED_TYPE
  );
}

export function parseEditorHistory(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): { canUndo: boolean; canRedo: boolean } | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_HISTORY_TYPE) return null;
  return { canUndo: m.canUndo === true, canRedo: m.canRedo === true };
}

export function parseEditorRoutes(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): string[] | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_ROUTES_TYPE) return null;
  if (!Array.isArray(m.routes)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of m.routes) {
    if (out.length >= MAX_ROUTES) break;
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (t.length === 0 || t.length > MAX_ROUTE_LENGTH) continue;
    if (!SAFE_ROUTE.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function parseEditorLocation(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): string | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_LOCATION_TYPE) return null;
  if (typeof m.path !== "string") return null;
  const t = m.path.trim();
  if (t.length === 0 || t.length > MAX_ROUTE_LENGTH) return null;
  if (!SAFE_ROUTE.test(t)) return null;
  return t;
}

export function parseEditorKey(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): { key: string; metaKey: boolean; ctrlKey: boolean } | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_KEY_TYPE) return null;
  if (typeof m.key !== "string" || (m.key.length !== 1 && m.key !== "Escape")) return null;
  return { key: m.key, metaKey: m.metaKey === true, ctrlKey: m.ctrlKey === true };
}

export function parseEditorSelected(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): SelectedElement | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_SELECTED_TYPE) return null;
  if (!isSafeSelector(m.selector)) return null;

  const tag =
    typeof m.tag === "string" && SAFE_TAG.test(m.tag.toLowerCase())
      ? m.tag.toLowerCase()
      : "element";
  const text = typeof m.text === "string" ? m.text.slice(0, MAX_TEXT_LENGTH) : "";
  const style = sanitizeStyle(m.style);
  const textEditable = m.textEditable !== false;
  const attrs = sanitizeAttrs(m.attrs);
  const segments = sanitizeRuns(m.segments);
  const base: SelectedElement = { selector: (m.selector as string).trim(), tag, text, textEditable, style };
  if (segments) base.segments = segments;
  if (typeof m.section === "string" && SAFE_SECTION_ID.test(m.section)) base.section = m.section;
  const protocol = runtimeProtocol(m);
  if (protocol > 1) base.protocol = protocol;
  return Object.keys(attrs).length > 0 ? { ...base, attrs } : base;
}

export function parseEditorOutline(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): OutlineElement[] | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_OUTLINE_TYPE) return null;
  if (!Array.isArray(m.elements)) return null;
  const out: OutlineElement[] = [];
  const seen = new Set<string>();
  for (const raw of m.elements) {
    if (out.length >= MAX_OUTLINE) break;
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (!isSafeSelector(e.selector)) continue;
    const selector = (e.selector as string).trim();
    if (seen.has(selector)) continue;
    const tag =
      typeof e.tag === "string" && SAFE_TAG.test(e.tag.toLowerCase())
        ? e.tag.toLowerCase()
        : "element";
    const text = typeof e.text === "string" ? e.text.slice(0, MAX_OUTLINE_TEXT) : "";
    seen.add(selector);
    out.push({ selector, tag, text });
  }
  return out;
}

export function editorModeMessage(enabled: boolean, tool?: "text" | "comment") {
  return enabled && tool ? ({ type: EDITOR_MODE_TYPE, enabled, tool } as const) : ({ type: EDITOR_MODE_TYPE, enabled } as const);
}

export type TextEdited = { selector: string; text: string; before: string };

export function editorTextRevertMessage(edits: Array<{ selector: string; text: string }>) {
  return {
    type: EDITOR_TEXT_REVERT_TYPE,
    edits: edits
      .filter((edit) => isSafeSelector(edit.selector))
      .map((edit) => ({ selector: edit.selector.trim(), text: edit.text.slice(0, MAX_TEXT_LENGTH) })),
  } as const;
}

export function parseEditorTextEdited(data: unknown, origin: string, expectedOrigin: string | null): TextEdited | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_TEXT_EDITED_TYPE) return null;
  if (!isSafeSelector(m.selector)) return null;
  if (typeof m.text !== "string" || typeof m.before !== "string") return null;
  const text = m.text.slice(0, MAX_TEXT_LENGTH);
  if (!text.trim() || text === m.before) return null;
  return { selector: (m.selector as string).trim(), text, before: m.before.slice(0, MAX_TEXT_LENGTH) };
}

export function isEditorTextSubmit(data: unknown, origin: string, expectedOrigin: string | null): boolean {
  if (!originOk(origin, expectedOrigin)) return false;
  return typeof data === "object" && data !== null && (data as Record<string, unknown>).type === EDITOR_TEXT_SUBMIT_TYPE;
}
export function editorApplyMessage(selector: string, patch: EditPatch, reveal = false, ack = false) {
  return ack
    ? ({ type: EDITOR_APPLY_TYPE, selector, patch: sanitizePatch(patch), reveal, ack } as const)
    : ({ type: EDITOR_APPLY_TYPE, selector, patch: sanitizePatch(patch), reveal } as const);
}

export function parseEditorApplied(
  data: unknown,
  origin: string,
  expectedOrigin: string | null,
): { selector: string; ok: boolean } | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_APPLIED_TYPE) return null;
  if (!isSafeSelector(m.selector)) return null;
  return { selector: (m.selector as string).trim(), ok: m.ok === true };
}
export function editorDeleteMessage(selector: string) {
  return { type: EDITOR_DELETE_TYPE, selector } as const;
}
export function editorUndoMessage() {
  return { type: EDITOR_UNDO_TYPE } as const;
}
export function editorRedoMessage() {
  return { type: EDITOR_REDO_TYPE } as const;
}
export function editorDeselectMessage() {
  return { type: EDITOR_DESELECT_TYPE } as const;
}
export function editorOutlineRequestMessage() {
  return { type: EDITOR_OUTLINE_REQUEST_TYPE } as const;
}

export function runtimeSupportsComments(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { comments?: unknown }).comments === 1;
}

export type CommentPick = {
  selector: string;
  tag: string;
  text: string;
  section?: string;
  relX: number;
  relY: number;
};

function unit(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
}

export function parseEditorCommentPick(data: unknown, origin: string, expectedOrigin: string | null): CommentPick | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_COMMENT_PICK_TYPE) return null;
  if (!isSafeSelector(m.selector)) return null;
  const tag = typeof m.tag === "string" && SAFE_TAG.test(m.tag.toLowerCase()) ? m.tag.toLowerCase() : "element";
  const text = typeof m.text === "string" ? m.text.replace(/\s+/g, " ").trim().slice(0, MAX_ANCHOR_TEXT) : "";
  const out: CommentPick = { selector: (m.selector as string).trim(), tag, text, relX: unit(m.rel_x), relY: unit(m.rel_y) };
  if (typeof m.section === "string" && SAFE_SECTION_ID.test(m.section)) out.section = m.section;
  return out;
}

export type ElementRect = { x: number; y: number; w: number; h: number };
export type ElementRects = { rects: Record<string, ElementRect | null>; vw: number; vh: number };

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e7;
}

export function parseEditorRects(data: unknown, origin: string, expectedOrigin: string | null): ElementRects | null {
  if (!originOk(origin, expectedOrigin)) return null;
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== EDITOR_RECTS_TYPE || !Array.isArray(m.rects)) return null;
  const rects: Record<string, ElementRect | null> = {};
  let n = 0;
  for (const raw of m.rects) {
    if (n >= MAX_WATCHED_SELECTORS) break;
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (!isSafeSelector(r.selector)) continue;
    const selector = (r.selector as string).trim();
    n++;
    if (r.found === true && finite(r.x) && finite(r.y) && finite(r.w) && finite(r.h) && r.w >= 0 && r.h >= 0) {
      rects[selector] = { x: r.x, y: r.y, w: r.w, h: r.h };
    } else {
      rects[selector] = null;
    }
  }
  return { rects, vw: finite(m.vw) && m.vw > 0 ? m.vw : 0, vh: finite(m.vh) && m.vh > 0 ? m.vh : 0 };
}

export function editorRectsRequestMessage(selectors: readonly string[]) {
  const out: string[] = [];
  for (const s of selectors) {
    if (out.length >= MAX_WATCHED_SELECTORS) break;
    if (!isSafeSelector(s)) continue;
    const t = s.trim();
    if (!out.includes(t)) out.push(t);
  }
  return { type: EDITOR_RECTS_REQUEST_TYPE, selectors: out } as const;
}

export type ThemeDraft = {
  colors?: Partial<Record<"primary" | "background" | "foreground" | "accent", string>>;
  fonts?: { display?: string; body?: string };
  radius?: string;
};

const THEME_DRAFT_HEX = /^#[0-9a-fA-F]{6}$/;
const THEME_DRAFT_COLOR_KEYS = ["primary", "background", "foreground", "accent"] as const;

export function editorThemeDraftMessage(
  draft: ThemeDraft | null,
  allowed: { fonts: readonly string[]; radii: readonly string[] },
) {
  if (!draft) return { type: EDITOR_THEME_DRAFT_TYPE, theme: null } as const;
  const theme: ThemeDraft = {};
  const colors: NonNullable<ThemeDraft["colors"]> = {};
  for (const key of THEME_DRAFT_COLOR_KEYS) {
    const v = draft.colors?.[key];
    if (typeof v === "string" && THEME_DRAFT_HEX.test(v)) colors[key] = v.toLowerCase();
  }
  if (Object.keys(colors).length) theme.colors = colors;
  const fonts: NonNullable<ThemeDraft["fonts"]> = {};
  for (const key of ["display", "body"] as const) {
    const v = draft.fonts?.[key];
    if (typeof v === "string" && allowed.fonts.includes(v) && /^[A-Za-z0-9 ]{1,48}$/.test(v)) fonts[key] = v;
  }
  if (Object.keys(fonts).length) theme.fonts = fonts;
  if (typeof draft.radius === "string" && allowed.radii.includes(draft.radius) && /^(0|\d{1,2}(\.\d{1,3})?(rem|px|em))$/.test(draft.radius)) {
    theme.radius = draft.radius;
  }
  return { type: EDITOR_THEME_DRAFT_TYPE, theme: Object.keys(theme).length ? theme : null } as const;
}
