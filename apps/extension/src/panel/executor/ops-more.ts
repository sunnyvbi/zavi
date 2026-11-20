
import type { OwnTabCdp } from "./cdp";
import type { AxNode, NodeRef } from "./perceive";
import { actionableRole, axProp, axText } from "./perceive";
import {
  boxCenter,
  clickRef,
  coveredAt,
  failed,
  input,
  toDocumentPoint,
  type Io,
  type OpOutcome,
} from "./ops";

export type Modifier = "Alt" | "Control" | "Meta" | "Shift" | "Mod";
export const MODIFIERS: readonly Modifier[] = ["Alt", "Control", "Meta", "Shift", "Mod"];
export type MouseButton = "left" | "right";
export type ShotPoint = { x: number; y: number; shot_w: number; shot_h: number };

const MOD_BIT: Record<"Alt" | "Control" | "Meta" | "Shift", number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

export function isMac(): boolean {
  const nav = (globalThis as { navigator?: { platform?: string; userAgentData?: { platform?: string } } }).navigator;
  const p = nav?.userAgentData?.platform || nav?.platform || "";
  return /mac/i.test(p);
}

function realMod(m: Modifier, mac: boolean): "Alt" | "Control" | "Meta" | "Shift" {
  return m === "Mod" ? (mac ? "Meta" : "Control") : m;
}

export function modifierMask(mods: readonly Modifier[] | undefined, mac = isMac()): number {
  let mask = 0;
  for (const m of mods ?? []) mask |= MOD_BIT[realMod(m, mac)];
  return mask;
}

const MAX_SHOT_PX = 10_000;

export function isShotPoint(o: Record<string, unknown>, xk = "x", yk = "y"): boolean {
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (
    n(o[xk]) &&
    n(o[yk]) &&
    n(o.shot_w) &&
    n(o.shot_h) &&
    (o.shot_w as number) >= 1 &&
    (o.shot_h as number) >= 1 &&
    (o.shot_w as number) <= MAX_SHOT_PX &&
    (o.shot_h as number) <= MAX_SHOT_PX &&
    (o[xk] as number) >= 0 &&
    (o[yk] as number) >= 0 &&
    (o[xk] as number) <= (o.shot_w as number) &&
    (o[yk] as number) <= (o.shot_h as number)
  );
}

type Metrics = { cssW: number; cssH: number; pageX: number; pageY: number };

export async function viewportMetrics(cdp: OwnTabCdp): Promise<Metrics | null> {
  const m = (await cdp.send("Page.getLayoutMetrics")) as {
    cssVisualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
  };
  const v = m?.cssVisualViewport;
  if (!v || typeof v.clientWidth !== "number" || typeof v.clientHeight !== "number" || v.clientWidth <= 0 || v.clientHeight <= 0) {
    return null;
  }
  return { cssW: v.clientWidth, cssH: v.clientHeight, pageX: v.pageX ?? 0, pageY: v.pageY ?? 0 };
}

export async function toCss(cdp: OwnTabCdp, p: { x: number; y: number }, shot: { shot_w: number; shot_h: number }): Promise<{ x: number; y: number } | null> {
  const m = await viewportMetrics(cdp);
  if (!m) return null;
  return { x: (p.x * m.cssW) / shot.shot_w, y: (p.y * m.cssH) / shot.shot_h };
}

export type Hit = { backend_node_id: number | null };

export async function nodeAt(cdp: OwnTabCdp, at: { x: number; y: number }): Promise<Hit> {
  await cdp.send("DOM.enable", {});
  const doc = await toDocumentPoint(cdp, null, at);
  try {
    const hit = (await cdp.send("DOM.getNodeForLocation", {
      x: Math.round(doc.x),
      y: Math.round(doc.y),
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: false,
    })) as { backendNodeId?: number } | null;
    return { backend_node_id: Number.isInteger(hit?.backendNodeId) ? (hit?.backendNodeId as number) : null };
  } catch {
    return { backend_node_id: null };
  }
}

async function hitStillSame(cdp: OwnTabCdp, at: { x: number; y: number }, want: NodeRef | null | undefined): Promise<boolean> {
  if (want === undefined) return true;
  const now = await nodeAt(cdp, at);
  return want === null ? now.backend_node_id === null : now.backend_node_id === want.backend_node_id;
}

export async function mouseClickAt(
  cdp: OwnTabCdp,
  io: Io,
  at: { x: number; y: number },
  fs: string | null,
  opts: { button?: MouseButton; count?: number; modifiers?: readonly Modifier[] } = {},
): Promise<void> {
  const button = opts.button ?? "left";
  const count = Math.max(1, Math.min(3, opts.count ?? 1));
  const modifiers = modifierMask(opts.modifiers);
  const buttons = button === "right" ? 2 : 1;
  await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none", modifiers }, fs);
  for (let i = 1; i <= count; i++) {
    // eslint-disable-next-line no-await-in-loop
    await input(cdp, io, "Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button, buttons, clickCount: i, modifiers }, fs);
    // eslint-disable-next-line no-await-in-loop
    await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button, buttons: 0, clickCount: i, modifiers }, fs);
  }
}

export async function hoverRef(cdp: OwnTabCdp, io: Io, ref: NodeRef): Promise<OpOutcome> {
  const fs = ref.frame_session;
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backend_node_id }, fs);
  const at = boxCenter(await cdp.send("DOM.getBoxModel", { backendNodeId: ref.backend_node_id }, fs));
  if (!at) return failed("no_box", "That element has no area to point at.");
  await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" }, fs);
  return { status: "done", result: {} };
}

export async function hoverXy(cdp: OwnTabCdp, io: Io, p: ShotPoint): Promise<OpOutcome> {
  const at = await toCss(cdp, p, p);
  if (!at) return failed("no_viewport", "The tab's size could not be read.");
  await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" }, null);
  return { status: "done", result: {} };
}

export async function clickXy(
  cdp: OwnTabCdp,
  io: Io,
  op: ShotPoint & { button?: MouseButton; click_count?: number; modifiers?: Modifier[]; hit_ref?: NodeRef | null },
): Promise<OpOutcome> {
  const at = await toCss(cdp, op, op);
  if (!at) return failed("no_viewport", "The tab's size could not be read.");
  if (!(await hitStillSame(cdp, at, op.hit_ref))) {
    return failed("target_changed", "Something else is at that point now, so it was not clicked. Take a fresh screenshot.");
  }
  await mouseClickAt(cdp, io, at, null, { button: op.button, count: op.click_count, modifiers: op.modifiers });
  return { status: "done", result: { css_x: Math.round(at.x), css_y: Math.round(at.y) } };
}

export async function scrollAt(cdp: OwnTabCdp, io: Io, op: ShotPoint & { dx: number; dy: number }): Promise<OpOutcome> {
  const at = await toCss(cdp, op, op);
  if (!at) return failed("no_viewport", "The tab's size could not be read.");
  const clampD = (d: number) => Math.max(-5000, Math.min(5000, d));
  await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" }, null);
  await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: clampD(op.dx), deltaY: clampD(op.dy) }, null);
  return { status: "done", result: {} };
}

const DRAG_STEPS = 8;
const DRAG_STEP_MS = 16;
const DRAG_INTERCEPT_WAIT_MS = 60;

export async function dragBetween(cdp: OwnTabCdp, io: Io, a: { x: number; y: number }, b: { x: number; y: number }, fs: string | null): Promise<OpOutcome> {
  let intercepting = false;
  try {
    await cdp.send("Input.setInterceptDrags", { enabled: true }, fs);
    intercepting = true;
  } catch {
  }
  cdp.takeDragData();
  try {
    await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y, button: "none" }, fs);
    await input(cdp, io, "Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 }, fs);
    let native: unknown = null;
    for (let i = 1; i <= DRAG_STEPS; i++) {
      const x = a.x + ((b.x - a.x) * i) / DRAG_STEPS;
      const y = a.y + ((b.y - a.y) * i) / DRAG_STEPS;
      // eslint-disable-next-line no-await-in-loop
      await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }, fs);
      if (intercepting && i === 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, DRAG_INTERCEPT_WAIT_MS));
        native = cdp.takeDragData();
        if (native) break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, DRAG_STEP_MS));
    }
    if (native) {
      for (const type of ["dragEnter", "dragOver", "drop"] as const) {
        // eslint-disable-next-line no-await-in-loop
        await input(cdp, io, "Input.dispatchDragEvent", { type, x: b.x, y: b.y, data: native }, fs);
      }
      return { status: "done", result: { drag: "native" } };
    }
    await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, fs);
    return { status: "done", result: { drag: "pointer" } };
  } finally {
    if (intercepting) await cdp.send("Input.setInterceptDrags", { enabled: false }, fs).catch(() => undefined);
  }
}

export async function dragRef(cdp: OwnTabCdp, io: Io, from: NodeRef, to: NodeRef): Promise<OpOutcome> {
  if (from.frame_session !== to.frame_session) return failed("cross_frame_drag", "Zavi can only drag within one frame of the page.");
  const fs = from.frame_session;
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: from.backend_node_id }, fs);
  const a = boxCenter(await cdp.send("DOM.getBoxModel", { backendNodeId: from.backend_node_id }, fs));
  const b = boxCenter(await cdp.send("DOM.getBoxModel", { backendNodeId: to.backend_node_id }, fs));
  if (!a || !b) return failed("no_box", "One of those elements has no area to drag from or to.");
  if (await coveredAt(cdp, fs, from.backend_node_id, a)) {
    return failed("click_intercepted", "Something else is on top of the element to drag, so nothing was dragged.");
  }
  if (await coveredAt(cdp, fs, to.backend_node_id, b)) {
    return failed("click_intercepted", "Something else is on top of the drop target, so nothing was dragged.");
  }
  return dragBetween(cdp, io, a, b, fs);
}

export async function dragXy(
  cdp: OwnTabCdp,
  io: Io,
  op: ShotPoint & { to_x: number; to_y: number; hit_ref?: NodeRef | null; to_hit_ref?: NodeRef | null },
): Promise<OpOutcome> {
  const a = await toCss(cdp, op, op);
  const b = await toCss(cdp, { x: op.to_x, y: op.to_y }, op);
  if (!a || !b) return failed("no_viewport", "The tab's size could not be read.");
  if (!(await hitStillSame(cdp, a, op.hit_ref))) {
    return failed("target_changed", "Something else is at the start point now, so nothing was dragged. Take a fresh screenshot.");
  }
  if (!(await hitStillSame(cdp, b, op.to_hit_ref))) {
    return failed("target_changed", "Something else is at the drop point now, so nothing was dragged. Take a fresh screenshot.");
  }
  return dragBetween(cdp, io, a, b, null);
}

type ChordKeyDef = { key: string; code: string; vk: number; text?: string };
const CHORD_KEY_DEFS: Record<string, ChordKeyDef> = {
  a: { key: "a", code: "KeyA", vk: 65 },
  c: { key: "c", code: "KeyC", vk: 67 },
  v: { key: "v", code: "KeyV", vk: 86 },
  x: { key: "x", code: "KeyX", vk: 88 },
  z: { key: "z", code: "KeyZ", vk: 90 },
  y: { key: "y", code: "KeyY", vk: 89 },
  f: { key: "f", code: "KeyF", vk: 70 },
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
};
export type ChordKey = keyof typeof CHORD_KEY_DEFS;

const PRIMARY_KEYS = new Set(["a", "c", "v", "x", "z", "y", "f", "Enter"]);
const ARROWS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const BARE_KEYS = new Set(["Escape", "Delete", "Backspace"]);

export function isAllowedChord(key: unknown, mods: unknown): boolean {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(CHORD_KEY_DEFS, key)) return false;
  if (!Array.isArray(mods) || !mods.every((m) => typeof m === "string" && (MODIFIERS as readonly string[]).includes(m))) return false;
  const m = mods as Modifier[];
  if (new Set(m).size !== m.length) return false;
  if (PRIMARY_KEYS.has(key)) return m.length === 1 && (m[0] === "Control" || m[0] === "Meta" || m[0] === "Mod");
  if (key === "Tab") return m.length === 1 && m[0] === "Shift";
  if (ARROWS.has(key)) return m.length === 1 && m[0] === "Alt";
  if (BARE_KEYS.has(key)) return m.length === 0;
  return false;
}

export const EDITING_CHORD_KEYS: ReadonlySet<string> = new Set(["v", "x", "z", "y", "Delete", "Backspace"]);

const MAC_COMMANDS: Record<string, string> = {
  "Meta+a": "selectAll",
  "Meta+c": "copy",
  "Meta+v": "paste",
  "Meta+x": "cut",
  "Meta+z": "undo",
  "Meta+y": "redo",
  "+Backspace": "deleteBackward",
  "+Delete": "deleteForward",
  "Alt+ArrowLeft": "moveWordLeft",
  "Alt+ArrowRight": "moveWordRight",
};

const MOD_KEY_DEFS: Record<"Alt" | "Control" | "Meta" | "Shift", { key: string; code: string; vk: number }> = {
  Control: { key: "Control", code: "ControlLeft", vk: 17 },
  Alt: { key: "Alt", code: "AltLeft", vk: 18 },
  Meta: { key: "Meta", code: "MetaLeft", vk: 91 },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
};

export async function keyChord(
  cdp: OwnTabCdp,
  io: Io,
  key: ChordKey,
  mods: readonly Modifier[],
  mac = isMac(),
): Promise<OpOutcome> {
  if (!isAllowedChord(key, [...mods])) return failed("key_not_allowed", "That key combination cannot be pressed.");
  const real = mods.map((m) => realMod(m, mac));
  if (key === "v") {
    return failed("paste_not_allowed", "Zavi does not paste: the clipboard may hold your own text. Type the text into the field instead.");
  }
  const def = CHORD_KEY_DEFS[key];
  let mask = 0;
  for (const m of real) {
    mask |= MOD_BIT[m];
    const d = MOD_KEY_DEFS[m];
    // eslint-disable-next-line no-await-in-loop
    await input(cdp, io, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, modifiers: mask }, null);
  }
  const commandKey = `${real.join("+")}+${key}`;
  const command = mac ? MAC_COMMANDS[commandKey] : undefined;
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, modifiers: mask };
  const withText = def.text && !(mask & (MOD_BIT.Control | MOD_BIT.Meta | MOD_BIT.Alt));
  await input(
    cdp,
    io,
    "Input.dispatchKeyEvent",
    { type: withText ? "keyDown" : "rawKeyDown", ...base, ...(withText ? { text: def.text } : {}), ...(command ? { commands: [command] } : {}) },
    null,
  );
  await input(cdp, io, "Input.dispatchKeyEvent", { type: "keyUp", ...base }, null);
  for (const m of [...real].reverse()) {
    mask &= ~MOD_BIT[m];
    const d = MOD_KEY_DEFS[m];
    // eslint-disable-next-line no-await-in-loop
    await input(cdp, io, "Input.dispatchKeyEvent", { type: "keyUp", key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, modifiers: mask }, null);
  }
  return { status: "done", result: { chord: [...mods, key].join("+") } };
}

type HistoryEntry = { id?: number; url?: string; title?: string };

export async function navHistory(cdp: OwnTabCdp): Promise<OpOutcome> {
  const h = (await cdp.send("Page.getNavigationHistory")) as { currentIndex?: number; entries?: HistoryEntry[] };
  const entries = h?.entries ?? [];
  const i = typeof h?.currentIndex === "number" ? h.currentIndex : -1;
  const pick = (e: HistoryEntry | undefined) =>
    e && Number.isInteger(e.id) && typeof e.url === "string" ? { entry_id: e.id as number, url: e.url.slice(0, 2_048) } : null;
  return { status: "done", result: { back: pick(entries[i - 1]), forward: pick(entries[i + 1]) } };
}

const HISTORY_LOAD_WAIT_MS = 10_000;

export async function historyGo(cdp: OwnTabCdp, io: Io, entryId: number, url: string): Promise<OpOutcome> {
  const h = (await cdp.send("Page.getNavigationHistory")) as { entries?: HistoryEntry[] };
  const e = (h?.entries ?? []).find((x) => x.id === entryId);
  if (!e || e.url !== url) return failed("history_changed", "The tab's history changed; that page is not where back / forward would go now.");
  const loaded = cdp.waitForLoad(HISTORY_LOAD_WAIT_MS);
  await input(cdp, io, "Page.navigateToHistoryEntry", { entryId }, null);
  await loaded;
  return { status: "done", result: {} };
}

export async function reloadPage(cdp: OwnTabCdp, io: Io, expectUrl: string, topUrl: () => Promise<string | null>): Promise<OpOutcome> {
  if ((await topUrl()) !== expectUrl) return failed("url_changed", "The tab is on another page now, so it was not reloaded.");
  const loaded = cdp.waitForLoad(HISTORY_LOAD_WAIT_MS);
  await input(cdp, io, "Page.reload", {}, null);
  await loaded;
  return { status: "done", result: {} };
}

export const SHOT_MAX_EDGE = 1_280;
export const SHOT_MAX_AREA = 1_150_000;
const ZOOM_TARGET_EDGE = 1_024;
const ZOOM_MAX_SCALE = 4;

export function jpegSize(b64: string): { w: number; h: number } | null {
  let bytes: Uint8Array;
  try {
    const bin = atob(b64.slice(0, 200_000));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

const deviceRatio = new WeakMap<OwnTabCdp, number>();

async function captureClip(cdp: OwnTabCdp, clip: { x: number; y: number; width: number; height: number; scale: number }) {
  const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60, clip })) as { data?: unknown };
  if (typeof shot?.data !== "string") return null;
  return { data: shot.data, size: jpegSize(shot.data) };
}

function fitScale(w: number, h: number): number {
  return Math.min(1, SHOT_MAX_EDGE / Math.max(w, h), Math.sqrt(SHOT_MAX_AREA / (w * h)));
}

export async function viewportShot(cdp: OwnTabCdp): Promise<OpOutcome> {
  const m = await viewportMetrics(cdp);
  if (!m) {
    const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 })) as { data?: unknown };
    if (typeof shot?.data !== "string") return failed("no_image", "The tab could not be captured.");
    const size = jpegSize(shot.data);
    return { status: "done", result: { image_base64: shot.data, mime: "image/jpeg", ...(size ? { width: size.w, height: size.h } : {}) } };
  }
  const known = deviceRatio.get(cdp);
  const target = fitScale(m.cssW, m.cssH);
  const clip = (scale: number) => ({ x: m.pageX, y: m.pageY, width: m.cssW, height: m.cssH, scale });
  let got = await captureClip(cdp, clip(known ? target / known : target));
  if (!got) return failed("no_image", "The tab could not be captured.");
  if (got.size && !known) {
    const ratio = got.size.w / (m.cssW * target);
    if (ratio > 0 && Number.isFinite(ratio)) {
      deviceRatio.set(cdp, ratio);
      if (Math.abs(ratio - 1) > 0.05) {
        const again = await captureClip(cdp, clip(target / ratio));
        if (again) got = again;
      }
    }
  }
  return {
    status: "done",
    result: {
      image_base64: got.data,
      mime: "image/jpeg",
      ...(got.size ? { width: got.size.w, height: got.size.h } : {}),
      css_width: Math.round(m.cssW),
      css_height: Math.round(m.cssH),
    },
  };
}

export async function zoomShot(cdp: OwnTabCdp, op: ShotPoint & { w: number; h: number }): Promise<OpOutcome> {
  const m = await viewportMetrics(cdp);
  if (!m) return failed("no_viewport", "The tab's size could not be read.");
  const sx = m.cssW / op.shot_w;
  const sy = m.cssH / op.shot_h;
  const x = op.x * sx;
  const y = op.y * sy;
  const w = Math.min(op.w * sx, m.cssW - x);
  const h = Math.min(op.h * sy, m.cssH - y);
  if (!(w >= 4 && h >= 4)) return failed("bad_region", "That region is too small or outside the screenshot.");
  const ratio = deviceRatio.get(cdp) ?? 1;
  const scale = Math.min(ZOOM_MAX_SCALE, ZOOM_TARGET_EDGE / Math.max(w, h)) / ratio;
  const got = await captureClip(cdp, { x: m.pageX + x, y: m.pageY + y, width: w, height: h, scale });
  if (!got) return failed("no_image", "The tab could not be captured.");
  return {
    status: "done",
    result: { image_base64: got.data, mime: "image/jpeg", ...(got.size ? { width: got.size.w, height: got.size.h } : {}), zoom: true },
  };
}

export const PAGE_TEXT_MAX_CHARS = 40_000;
const PAGE_TEXT_SCAN_CHARS = 400_000;
const LINE_TOLERANCE_PX = 4;

type DocSnap = {
  nodes?: { parentIndex?: number[]; nodeType?: number[]; nodeName?: number[] };
  layout?: { nodeIndex?: number[]; bounds?: number[][]; text?: number[] };
  scrollOffsetX?: number;
  scrollOffsetY?: number;
};

type Line = { text: string; visible: boolean | null; order: number };

function docLines(doc: DocSnap, strings: string[], view: { top: number; bottom: number } | null, orderBase: number): Line[] {
  const L = doc.layout;
  const types = doc.nodes?.nodeType ?? [];
  const names = doc.nodes?.nodeName ?? [];
  const parents = doc.nodes?.parentIndex ?? [];
  if (!L?.nodeIndex || !L.text || !L.bounds) return [];
  const skip = (nodeIdx: number) => {
    const p = parents[nodeIdx];
    const tag = p !== undefined && p >= 0 ? (strings[names[p]] ?? "").toUpperCase() : "";
    return tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA" || tag === "OPTION";
  };
  const lines: Line[] = [];
  let cur: { parts: string[]; top: number; visible: boolean | null } | null = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) lines.push({ text, visible: cur.visible, order: orderBase + lines.length });
    cur = null;
  };
  for (let i = 0; i < L.nodeIndex.length; i++) {
    const ni = L.nodeIndex[i];
    const si = L.text[i];
    if (types[ni] !== 3 || si === undefined || si < 0 || skip(ni)) continue;
    const t = strings[si];
    if (!t || !t.trim()) continue;
    const b = L.bounds[i] ?? [];
    const top = typeof b[1] === "number" ? b[1] : 0;
    const height = typeof b[3] === "number" ? b[3] : 0;
    const visible = view ? top + height > view.top && top < view.bottom : null;
    if (cur && Math.abs(top - (cur as { top: number }).top) <= LINE_TOLERANCE_PX) {
      (cur as { parts: string[] }).parts.push(t);
      if (visible) (cur as { visible: boolean | null }).visible = true;
    } else {
      flush();
      cur = { parts: [t], top, visible };
    }
  }
  flush();
  return lines;
}

export type PageText = { text: string; truncated: boolean; lines: number };

export async function pageText(cdp: OwnTabCdp, max = PAGE_TEXT_MAX_CHARS): Promise<PageText> {
  const m = await viewportMetrics(cdp).catch(() => null);
  const all: Line[] = [];
  for (const frame of [null, ...cdp.frameSessions()]) {
    let snap: { documents?: DocSnap[]; strings?: string[] };
    try {
      // eslint-disable-next-line no-await-in-loop
      snap = (await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }, frame)) as typeof snap;
    } catch (e) {
      if (frame === null) throw e;
      continue;
    }
    const strings = snap?.strings ?? [];
    (snap?.documents ?? []).forEach((doc, di) => {
      const top = frame === null && di === 0 && m ? { top: doc.scrollOffsetY ?? m.pageY, bottom: (doc.scrollOffsetY ?? m.pageY) + m.cssH } : null;
      all.push(...docLines(doc, strings, top, all.length));
    });
    if (all.reduce((a, l) => a + l.text.length, 0) > PAGE_TEXT_SCAN_CHARS) break;
  }
  const rank = (v: boolean | null) => (v === true ? 0 : v === null ? 1 : 2);
  const ordered = [...all].sort((a, b) => rank(a.visible) - rank(b.visible) || a.order - b.order);
  const out: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  let truncated = false;
  for (const l of ordered) {
    if (seen.has(l.text)) continue;
    if (chars + l.text.length + 1 > max) {
      truncated = true;
      break;
    }
    seen.add(l.text);
    out.push(l.text);
    chars += l.text.length + 1;
  }
  return { text: out.join("\n"), truncated, lines: out.length };
}

export const WAIT_MAX_MS = 10_000;
const WAIT_POLL_MS = 250;

function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function waitFor(
  cdp: OwnTabCdp,
  op: { text?: string; text_gone?: string; network_quiet?: boolean; timeout_ms: number },
): Promise<OpOutcome> {
  const started = Date.now();
  const deadline = started + Math.max(0, Math.min(WAIT_MAX_MS, op.timeout_ms));
  const want = op.text !== undefined ? normText(op.text) : null;
  const gone = op.text_gone !== undefined ? normText(op.text_gone) : null;
  for (;;) {
    let met = true;
    if (want !== null || gone !== null) {
      // eslint-disable-next-line no-await-in-loop
      const t = normText((await pageText(cdp, PAGE_TEXT_SCAN_CHARS)).text);
      if (want !== null && !t.includes(want)) met = false;
      if (gone !== null && t.includes(gone)) met = false;
    }
    if (op.network_quiet && cdp.isNetworkIdle() !== true) met = false;
    if (met) return { status: "done", result: { met: true, waited_ms: Date.now() - started } };
    if (Date.now() >= deadline) {
      const unknown = op.network_quiet && cdp.isNetworkIdle() === null;
      return failed(
        "wait_timeout",
        unknown
          ? "The page did not report its network state; nothing to wait on. Look at the page instead."
          : "What it waited for did not happen in time.",
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

const OPTION_ROLES = new Set(["option", "gridcell", "menuitem", "menuitemradio", "menuitemcheckbox", "treeitem"]);
const CHOOSE_OPEN_WAIT_MS = 2_000;
const CHOOSE_POLL_MS = 150;

type Opt = { ref: NodeRef; name: string };

async function visibleOptions(cdp: OwnTabCdp): Promise<Opt[]> {
  const out: Opt[] = [];
  for (const frame of [null, ...cdp.frameSessions()]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await cdp.send("Accessibility.enable", {}, frame);
      // eslint-disable-next-line no-await-in-loop
      const tree = (await cdp.send("Accessibility.getFullAXTree", {}, frame)) as { nodes?: AxNode[] };
      for (const n of tree?.nodes ?? []) {
        if (n.ignored || !Number.isInteger(n.backendDOMNodeId)) continue;
        if (!OPTION_ROLES.has(axText(n.role))) continue;
        if (axProp(n, "disabled") === true) continue;
        const name = axText(n.name).replace(/\s+/g, " ").trim();
        if (name) out.push({ ref: { frame_session: frame, backend_node_id: n.backendDOMNodeId as number }, name });
      }
    } catch {
    }
  }
  return out;
}

export function matchOption(opts: Opt[], want: string): Opt | null {
  const w = normText(want);
  const exact = opts.filter((o) => normText(o.name) === w);
  if (exact.length >= 1) return exact[0];
  const starts = opts.filter((o) => normText(o.name).startsWith(w));
  if (starts.length === 1) return starts[0];
  const has = opts.filter((o) => normText(o.name).includes(w));
  return has.length === 1 ? has[0] : null;
}

async function waitOptions(cdp: OwnTabCdp, want: string, ms: number): Promise<{ hit: Opt | null; all: Opt[] }> {
  const end = Date.now() + ms;
  let all: Opt[] = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    all = await visibleOptions(cdp);
    const hit = matchOption(all, want);
    if (hit || Date.now() >= end) return { hit, all };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, CHOOSE_POLL_MS));
  }
}

const STABLE_POLL_MS = 80;
const STABLE_MAX_MS = 1_200;

async function stableBox(cdp: OwnTabCdp, ref: NodeRef): Promise<void> {
  const end = Date.now() + STABLE_MAX_MS;
  let last = "";
  let same = 0;
  while (Date.now() < end) {
    // eslint-disable-next-line no-await-in-loop
    const m = await cdp.send("DOM.getBoxModel", { backendNodeId: ref.backend_node_id }, ref.frame_session).catch(() => null);
    const now = JSON.stringify((m as { model?: { content?: number[] } } | null)?.model?.content ?? null);
    same = now === last && now !== "null" ? same + 1 : 0;
    if (same >= 2) return;
    last = now;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, STABLE_POLL_MS));
  }
}

function withStep(o: OpOutcome, step: "open" | "pick"): OpOutcome {
  const msg = typeof o.result.error_message === "string" ? o.result.error_message : "";
  return { status: o.status, result: { ...o.result, error_message: `${step === "open" ? "Opening the list" : "Picking the option"}: ${msg}`, step } };
}

export async function choose(cdp: OwnTabCdp, io: Io, ref: NodeRef, option: string): Promise<OpOutcome> {
  const fs = ref.frame_session;
  const trig = (await cdp.send("Accessibility.getPartialAXTree", { backendNodeId: ref.backend_node_id, fetchRelatives: false }, fs)) as {
    nodes?: AxNode[];
  };
  const tn = (trig?.nodes ?? []).find((x) => x.backendDOMNodeId === ref.backend_node_id);
  if (!tn) return failed("stale_ref", "That element is no longer on the page. Take a fresh snapshot.");
  const role = actionableRole(tn) || axText(tn.role);
  const expanded = axProp(tn, "expanded");
  if (!(expanded === true || expanded === "true")) {
    const opened = await clickRef(cdp, io, ref);
    if (opened.status !== "done") return withStep(opened, "open");
  }
  let found = await waitOptions(cdp, option, CHOOSE_OPEN_WAIT_MS);
  let via = "click";
  if (!found.hit && ["combobox", "textbox", "searchbox"].includes(role)) {
    await cdp.send("DOM.focus", { backendNodeId: ref.backend_node_id }, fs);
    await input(cdp, io, "Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["selectAll"] }, fs);
    await input(cdp, io, "Input.dispatchKeyEvent", { type: "keyUp" }, fs);
    await input(cdp, io, "Input.insertText", { text: option }, fs);
    found = await waitOptions(cdp, option, CHOOSE_OPEN_WAIT_MS);
    via = "filter";
  }
  if (!found.hit) {
    const list = [...new Set(found.all.map((o) => o.name))].slice(0, 20).join(" | ").slice(0, 400);
    return failed("no_such_option", `No option ${JSON.stringify(option.slice(0, 80))} showed up.${list ? ` Options: ${list}` : ""}`);
  }
  await stableBox(cdp, found.hit.ref);
  const picked = await clickRef(cdp, io, found.hit.ref);
  if (picked.status !== "done") return withStep(picked, "pick");
  return { status: "done", result: { chosen: found.hit.name.slice(0, 80), via } };
}
