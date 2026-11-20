
import { CdpNotAllowedError, UnknownFrameError, type OwnTabCdp } from "./cdp";
import {
  INTERACTIVE_ROLES,
  actionableRole,
  axProp,
  axText,
  MAX_NAME_CHARS,
  pageSignature,
  settle,
  SETTLE_MAX_MS,
  snapshot,
  withinMs,
  type AxNode,
  type AxValue,
  type NodeRef,
  type SettleClock,
} from "./perceive";

import {
  choose,
  clickXy,
  mouseClickAt,
  dragRef,
  dragXy,
  historyGo,
  hoverRef,
  hoverXy,
  isAllowedChord,
  isShotPoint,
  keyChord,
  MODIFIERS,
  navHistory,
  nodeAt,
  pageText,
  PAGE_TEXT_MAX_CHARS,
  reloadPage,
  scrollAt,
  toCss,
  viewportShot,
  WAIT_MAX_MS,
  waitFor,
  zoomShot,
  type ChordKey,
  type Modifier,
  type MouseButton,
  type ShotPoint,
} from "./ops-more";

export { INTERACTIVE_ROLES, MAX_NAME_CHARS, MAX_SNAPSHOT_NODES, type NodeRef, type SnapshotNode } from "./perceive";
export type { ChordKey, Modifier, MouseButton, ShotPoint } from "./ops-more";

export type KeyName =
  | "Enter"
  | "Tab"
  | "Escape"
  | "Space"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

export type ClickOpts = { button?: MouseButton; click_count?: 1 | 2 | 3; modifiers?: Modifier[]; dialog_text?: string };

export type ExtOp =
  | { op: "ax_snapshot" }
  | ({ op: "click_ref"; ref: NodeRef } & ClickOpts)
  | { op: "hover_ref"; ref: NodeRef }
  | (ShotPoint & { op: "hover_xy" })
  | (ShotPoint & { op: "click_xy"; hit_ref?: NodeRef | null } & ClickOpts)
  | { op: "drag_ref"; ref: NodeRef; to_ref: NodeRef }
  | (ShotPoint & { op: "drag_xy"; to_x: number; to_y: number; hit_ref?: NodeRef | null; to_hit_ref?: NodeRef | null })
  | (ShotPoint & { op: "scroll_at"; dx: number; dy: number })
  | { op: "key_chord"; key: ChordKey; modifiers: Modifier[]; focus_ref?: NodeRef | null; dialog_text?: string }
  | { op: "nav_history" }
  | { op: "history_go"; entry_id: number; url: string }
  | { op: "reload"; expect_url: string }
  | (ShotPoint & { op: "zoom"; w: number; h: number })
  | { op: "get_page_text"; max_chars?: number }
  | { op: "wait_until"; text?: string; text_gone?: string; network_quiet?: boolean; timeout_ms: number }
  | { op: "choose"; ref: NodeRef; option: string }
  | { op: "type_ref"; ref: NodeRef; text: string }
  | { op: "select_option"; ref: NodeRef; label?: string; value?: string }
  | { op: "set_checked"; ref: NodeRef; checked: boolean }
  | { op: "key"; key: KeyName; focus_ref?: NodeRef | null }
  | { op: "scroll"; dy: number; ref?: NodeRef }
  | { op: "nav"; url: string }
  | { op: "screenshot" }
  | { op: "assert_url"; expected: string }
  | { op: "resolve"; ref: NodeRef | null; at?: ShotPoint };

export type OpOutcome = { status: "done" | "failed"; result: Record<string, unknown> };

const MAX_TYPE_CHARS = 5_000;
const MAX_OPTION_CHARS = 200;
const NAV_LOAD_WAIT_MS = 10_000;
const SCROLL_SETTLE_MS = 50;
const SCROLL_SETTLE_POLLS = 6;

export const ALLOWED_KEYS: Record<string, { code: string; vk: number; text?: string; key?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Space: { code: "Space", vk: 32, text: " ", key: " " },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
};

export function isAllowedKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_KEYS, key);
}

export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isRef(v: unknown): v is NodeRef {
  const r = v as NodeRef | null;
  return (
    !!r &&
    typeof r === "object" &&
    (r.frame_session === null || typeof r.frame_session === "string") &&
    Number.isInteger(r.backend_node_id) &&
    r.backend_node_id > 0
  );
}

const MAX_DIALOG_TEXT = 500;
const MAX_WAIT_TEXT = 200;

function clickOpts(o: Record<string, unknown>): ClickOpts | null {
  const out: ClickOpts = {};
  if (o.button !== undefined) {
    if (o.button !== "left" && o.button !== "right") return null;
    out.button = o.button;
  }
  if (o.click_count !== undefined) {
    if (o.click_count !== 1 && o.click_count !== 2 && o.click_count !== 3) return null;
    out.click_count = o.click_count;
  }
  if (o.modifiers !== undefined) {
    const m = o.modifiers;
    if (!Array.isArray(m) || m.length > 3 || !m.every((x) => (MODIFIERS as readonly unknown[]).includes(x)) || new Set(m).size !== m.length) return null;
    if (m.length) out.modifiers = m as Modifier[];
  }
  if (o.dialog_text !== undefined) {
    if (typeof o.dialog_text !== "string" || o.dialog_text.length > MAX_DIALOG_TEXT) return null;
    out.dialog_text = o.dialog_text;
  }
  return out;
}

function shot(o: Record<string, unknown>): ShotPoint {
  return { x: o.x as number, y: o.y as number, shot_w: o.shot_w as number, shot_h: o.shot_h as number };
}

function optRefOrNull(v: unknown): NodeRef | null | undefined | false {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return isRef(v) ? v : false;
}

export function parseOp(raw: unknown): ExtOp | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  switch (o.op) {
    case "ax_snapshot":
    case "screenshot":
    case "nav_history":
      return { op: o.op };
    case "click_ref": {
      if (!isRef(o.ref)) return null;
      const c = clickOpts(o);
      return c ? { op: "click_ref", ref: o.ref, ...c } : null;
    }
    case "hover_ref":
      return isRef(o.ref) ? { op: "hover_ref", ref: o.ref } : null;
    case "hover_xy":
      return isShotPoint(o) ? { op: "hover_xy", ...shot(o) } : null;
    case "click_xy": {
      if (!isShotPoint(o)) return null;
      const c = clickOpts(o);
      const hit = optRefOrNull(o.hit_ref);
      if (!c || hit === false) return null;
      return { op: "click_xy", ...shot(o), ...c, ...(hit !== undefined ? { hit_ref: hit } : {}) };
    }
    case "drag_ref":
      return isRef(o.ref) && isRef(o.to_ref) ? { op: "drag_ref", ref: o.ref, to_ref: o.to_ref } : null;
    case "drag_xy": {
      if (!isShotPoint(o) || !isShotPoint(o, "to_x", "to_y")) return null;
      const hit = optRefOrNull(o.hit_ref);
      const toHit = optRefOrNull(o.to_hit_ref);
      if (hit === false || toHit === false) return null;
      return {
        op: "drag_xy",
        ...shot(o),
        to_x: o.to_x as number,
        to_y: o.to_y as number,
        ...(hit !== undefined ? { hit_ref: hit } : {}),
        ...(toHit !== undefined ? { to_hit_ref: toHit } : {}),
      };
    }
    case "scroll_at": {
      const fin = (v: unknown) => typeof v === "number" && Number.isFinite(v);
      if (!isShotPoint(o) || !fin(o.dx) || !fin(o.dy)) return null;
      return { op: "scroll_at", ...shot(o), dx: o.dx as number, dy: o.dy as number };
    }
    case "key_chord": {
      const mods = o.modifiers ?? [];
      if (!isAllowedChord(o.key, mods)) return null;
      const focus = optRefOrNull(o.focus_ref);
      if (focus === false) return null;
      if (o.dialog_text !== undefined && (typeof o.dialog_text !== "string" || o.dialog_text.length > MAX_DIALOG_TEXT)) return null;
      return {
        op: "key_chord",
        key: o.key as ChordKey,
        modifiers: mods as Modifier[],
        ...(focus !== undefined ? { focus_ref: focus } : {}),
        ...(typeof o.dialog_text === "string" ? { dialog_text: o.dialog_text } : {}),
      };
    }
    case "history_go":
      return Number.isInteger(o.entry_id) && isHttpUrl(o.url) ? { op: "history_go", entry_id: o.entry_id as number, url: o.url } : null;
    case "reload":
      return isHttpUrl(o.expect_url) ? { op: "reload", expect_url: o.expect_url } : null;
    case "zoom": {
      const pos = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
      return isShotPoint(o) && pos(o.w) && pos(o.h) ? { op: "zoom", ...shot(o), w: o.w as number, h: o.h as number } : null;
    }
    case "get_page_text": {
      if (o.max_chars === undefined) return { op: "get_page_text" };
      return Number.isInteger(o.max_chars) && (o.max_chars as number) > 0 && (o.max_chars as number) <= PAGE_TEXT_MAX_CHARS
        ? { op: "get_page_text", max_chars: o.max_chars as number }
        : null;
    }
    case "wait_until": {
      const s = (v: unknown) => v === undefined || (typeof v === "string" && v.trim().length > 0 && v.length <= MAX_WAIT_TEXT);
      if (!s(o.text) || !s(o.text_gone)) return null;
      if (o.network_quiet !== undefined && o.network_quiet !== true) return null;
      const n = [o.text, o.text_gone, o.network_quiet].filter((v) => v !== undefined).length;
      if (n !== 1) return null;
      const t = o.timeout_ms;
      if (!Number.isInteger(t) || (t as number) < 0 || (t as number) > WAIT_MAX_MS) return null;
      return {
        op: "wait_until",
        timeout_ms: t as number,
        ...(typeof o.text === "string" ? { text: o.text } : {}),
        ...(typeof o.text_gone === "string" ? { text_gone: o.text_gone } : {}),
        ...(o.network_quiet === true ? { network_quiet: true } : {}),
      };
    }
    case "choose":
      return isRef(o.ref) && typeof o.option === "string" && o.option.trim().length > 0 && o.option.length <= MAX_OPTION_CHARS
        ? { op: "choose", ref: o.ref, option: o.option }
        : null;
    case "type_ref":
      return isRef(o.ref) && typeof o.text === "string" && o.text.length <= MAX_TYPE_CHARS
        ? { op: "type_ref", ref: o.ref, text: o.text }
        : null;
    case "key":
      if (typeof o.key !== "string" || !isAllowedKey(o.key)) return null;
      if (o.focus_ref === undefined) return { op: "key", key: o.key as KeyName };
      if (o.focus_ref !== null && !isRef(o.focus_ref)) return null;
      return { op: "key", key: o.key as KeyName, focus_ref: o.focus_ref as NodeRef | null };
    case "select_option": {
      if (!isRef(o.ref)) return null;
      const label = typeof o.label === "string" && o.label.length <= MAX_OPTION_CHARS ? o.label : undefined;
      const value = typeof o.value === "string" && o.value.length <= MAX_OPTION_CHARS ? o.value : undefined;
      if ((label === undefined) === (value === undefined)) return null;
      return { op: "select_option", ref: o.ref, ...(label !== undefined ? { label } : { value: value as string }) };
    }
    case "set_checked":
      return isRef(o.ref) && typeof o.checked === "boolean" ? { op: "set_checked", ref: o.ref, checked: o.checked } : null;
    case "scroll":
      if (typeof o.dy !== "number" || !Number.isFinite(o.dy)) return null;
      if (o.ref === undefined) return { op: "scroll", dy: o.dy };
      return isRef(o.ref) ? { op: "scroll", dy: o.dy, ref: o.ref } : null;
    case "nav":
      return typeof o.url === "string" ? { op: "nav", url: o.url } : null;
    case "assert_url":
      return typeof o.expected === "string" ? { op: "assert_url", expected: o.expected } : null;
    case "resolve": {
      if (o.at !== undefined) {
        const at = o.at as Record<string, unknown> | null;
        return o.ref === null && at && typeof at === "object" && isShotPoint(at) ? { op: "resolve", ref: null, at: shot(at) } : null;
      }
      return o.ref === null ? { op: "resolve", ref: null } : isRef(o.ref) ? { op: "resolve", ref: o.ref } : null;
    }
    default:
      return null;
  }
}

export function boxCenter(model: unknown): { x: number; y: number } | null {
  const q = (model as { model?: { content?: number[] } } | null)?.model?.content;
  if (!Array.isArray(q) || q.length < 8) return null;
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return {
    x: xs.reduce((a, b) => a + b, 0) / 4,
    y: ys.reduce((a, b) => a + b, 0) / 4,
  };
}

function urlMatches(url: string, expected: string): boolean {
  if (expected === "") return true;
  if (expected.startsWith("^")) {
    try {
      return new RegExp(expected).test(url);
    } catch {
      return false;
    }
  }
  return url.includes(expected);
}

export function failed(code: string, message: string): OpOutcome {
  return { status: "failed", result: { error_code: code, error_message: message } };
}

export type Io = { dispatched: boolean };

export async function input(cdp: OwnTabCdp, io: Io, method: string, params: object, fs: string | null): Promise<unknown> {
  io.dispatched = true;
  return cdp.send(method, params, fs);
}

export async function pressKey(cdp: OwnTabCdp, io: Io, name: string, fs: string | null = null): Promise<void> {
  const k = ALLOWED_KEYS[name];
  const base = { key: k.key ?? name, code: k.code, windowsVirtualKeyCode: k.vk };
  await input(cdp, io, "Input.dispatchKeyEvent", k.text ? { type: "keyDown", ...base, text: k.text } : { type: "rawKeyDown", ...base }, fs);
  await input(cdp, io, "Input.dispatchKeyEvent", { type: "keyUp", ...base }, fs);
}

async function typeChars(cdp: OwnTabCdp, io: Io, text: string, fs: string | null): Promise<void> {
  for (const ch of text) {
    // eslint-disable-next-line no-await-in-loop
    await input(cdp, io, "Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch }, fs);
    // eslint-disable-next-line no-await-in-loop
    await input(cdp, io, "Input.dispatchKeyEvent", { type: "keyUp", key: ch }, fs);
  }
}

async function coveredAtInner(
  cdp: OwnTabCdp,
  fs: string | null,
  id: number,
  at: { x: number; y: number },
  seen: { by: string },
): Promise<boolean> {
  let hitId: number | undefined;
  try {
    await cdp.send("DOM.enable", {}, fs);
    const doc = await toDocumentPoint(cdp, fs, at);
    const hit = (await cdp.send(
      "DOM.getNodeForLocation",
      { x: Math.round(doc.x), y: Math.round(doc.y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: false },
      fs,
    )) as { backendNodeId?: number } | null;
    hitId = hit?.backendNodeId;
  } catch {
    return false;
  }
  if (!Number.isInteger(hitId) || hitId === id) return false;
  try {
    const doc = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, fs)) as { root?: DomNode };
    if (!doc?.root) return true;
    const parents = new Map<number, number | null>();
    const byId = new Map<number, DomNode>();
    walk(doc.root, (n, p) => {
      if (!Number.isInteger(n.backendNodeId)) return;
      byId.set(n.backendNodeId as number, n);
      parents.set(n.backendNodeId as number, p && Number.isInteger(p.backendNodeId) ? (p.backendNodeId as number) : null);
    });
    const target = byId.get(id);
    const hitNode = byId.get(hitId as number);
    if (hitNode) seen.by = `<${tagOf(hitNode)}${attrs(hitNode).role ? ` role=${attrs(hitNode).role.slice(0, 20)}` : ""}>`;
    if (!target || !hitNode) return true;
    const chain = (from: number): number[] => {
      const out: number[] = [];
      for (let p: number | null = from, i = 0; p !== null && i < 1000; p = parents.get(p) ?? null, i++) out.push(p);
      return out;
    };
    const hitChain = chain(hitId as number);
    const targetChain = chain(id);
    if (hitChain.includes(id) || targetChain.includes(hitId as number)) return false;
    const tid = attrs(target).id;
    for (const n of hitChain) {
      const node = byId.get(n);
      if (!node || tagOf(node) !== "label") continue;
      const f = attrs(node).for;
      if (f !== undefined ? !!tid && f === tid : targetChain.includes(n)) return false;
    }
    const lcaAt = targetChain.slice(1, SAME_WIDGET_DEPTH + 1).findIndex((a) => hitChain.includes(a));
    if (lcaAt >= 0) {
      const lca = targetChain[lcaAt + 1];
      const lcaTag = tagOf(byId.get(lca) ?? {});
      if (lcaTag !== "body" && lcaTag !== "html" && lcaTag !== "#document" && lcaTag !== "") {
        const between = hitChain.slice(0, hitChain.indexOf(lca));
        const labelsElsewhere = [...between, lca].some((n) => {
          const node = byId.get(n);
          const f = node && tagOf(node) === "label" ? attrs(node).for : undefined;
          return f !== undefined && f !== tid;
        });
        if (!labelsElsewhere && !between.some((n) => isOwnControl(byId.get(n)))) return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

export async function toDocumentPoint(cdp: OwnTabCdp, fs: string | null, at: { x: number; y: number }): Promise<{ x: number; y: number }> {
  try {
    const m = (await cdp.send("Page.getLayoutMetrics", {}, fs)) as { cssVisualViewport?: { pageX?: number; pageY?: number } };
    const v = m?.cssVisualViewport;
    return { x: at.x + (typeof v?.pageX === "number" ? v.pageX : 0), y: at.y + (typeof v?.pageY === "number" ? v.pageY : 0) };
  } catch {
    return at;
  }
}

let lastCoverBy = "";

export async function coveredAt(cdp: OwnTabCdp, fs: string | null, id: number, at: { x: number; y: number }): Promise<boolean> {
  const seen = { by: "" };
  const covered = await coveredAtInner(cdp, fs, id, at, seen);
  lastCoverBy = covered ? seen.by : "";
  return covered;
}

export function interceptedMessage(what = "that element"): string {
  return `Something else is on top of ${what}${lastCoverBy ? ` (${lastCoverBy})` : ""} (a dialog, overlay or another control), so it was not clicked.`;
}

const SAME_WIDGET_DEPTH = 2;
const MOVE_CHECKS = 15;
const MOVE_CHECK_MS = 40;
const CONTROL_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary", "iframe", "dialog"]);
const CONTROL_ROLES = new Set([...INTERACTIVE_ROLES, "dialog", "alertdialog"]);

function isOwnControl(n: DomNode | undefined): boolean {
  if (!n) return false;
  const a = attrs(n);
  return CONTROL_TAGS.has(tagOf(n)) || CONTROL_ROLES.has((a.role ?? "").trim()) || a.contenteditable === "true" || a.contenteditable === "";
}

export async function clickRef(cdp: OwnTabCdp, io: Io, ref: NodeRef, opts: ClickOpts = {}): Promise<OpOutcome> {
  const fs = ref.frame_session;
  const backendNodeId = ref.backend_node_id;
  await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, fs);
  let box = await cdp.send("DOM.getBoxModel", { backendNodeId }, fs);
  for (let i = 0; i < MOVE_CHECKS; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, MOVE_CHECK_MS));
    // eslint-disable-next-line no-await-in-loop
    const again = await cdp.send("DOM.getBoxModel", { backendNodeId }, fs);
    if (JSON.stringify(boxCenter(again)) === JSON.stringify(boxCenter(box))) break;
    box = again;
  }
  const at = boxCenter(box);
  if (!at) return failed("no_box", "That element has no clickable area.");
  if (await coveredAt(cdp, fs, backendNodeId, at)) {
    return failed("click_intercepted", interceptedMessage());
  }
  if (!opts.button && !opts.click_count && !opts.modifiers) {
    await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" }, fs);
    await input(cdp, io, "Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 }, fs);
    await input(cdp, io, "Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 }, fs);
    return { status: "done", result: {} };
  }
  await mouseClickAt(cdp, io, at, fs, { button: opts.button, count: opts.click_count, modifiers: opts.modifiers });
  return { status: "done", result: {} };
}

async function axNodeOf(cdp: OwnTabCdp, fs: string | null, backendNodeId: number): Promise<AxNode | null> {
  const r = (await cdp.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }, fs)) as { nodes?: AxNode[] };
  return (r?.nodes ?? []).find((x) => x.backendDOMNodeId === backendNodeId) ?? r?.nodes?.[0] ?? null;
}

const ISO_DATE_RE = /^(\d{4,6})-(\d{2})-(\d{2})$/;

async function typeDate(cdp: OwnTabCdp, io: Io, ref: NodeRef, text: string): Promise<OpOutcome> {
  const m = ISO_DATE_RE.exec(text.trim());
  if (!m) return failed("bad_date", "Type a date as YYYY-MM-DD.");
  const [, year, month, day] = m;
  const fs = ref.frame_session;
  await cdp.send("Accessibility.enable", {}, fs);
  const tree = (await cdp.send("Accessibility.getFullAXTree", {}, fs)) as { nodes?: AxNode[] };
  const nodes = tree?.nodes ?? [];
  const byId = new Map(nodes.filter((n) => typeof n.nodeId === "string").map((n) => [n.nodeId as string, n]));
  const root = nodes.find((n) => n.backendDOMNodeId === ref.backend_node_id);
  if (!root) return failed("stale_ref", "That element is no longer on the page. Take a fresh snapshot.");
  const fields: { id: number; max: number }[] = [];
  const stack = [...(root.childIds ?? [])];
  while (stack.length) {
    const n = byId.get(stack.shift() as string);
    if (!n) continue;
    if (axText(n.role) === "spinbutton" && Number.isInteger(n.backendDOMNodeId)) {
      fields.push({ id: n.backendDOMNodeId as number, max: Number(axProp(n, "valuemax")) });
    }
    stack.push(...(n.childIds ?? []));
  }
  const monthF = fields.find((f) => f.max === 12);
  const dayF = fields.find((f) => f.max === 31);
  const yearF = fields.find((f) => f !== monthF && f !== dayF && f.max > 31);
  if (!monthF || !dayF || !yearF || fields.length !== 3) {
    return failed("not_supported", "Zavi can type into date fields only (not date-and-time fields).");
  }
  for (const [f, digits] of [
    [monthF, month],
    [dayF, day],
    [yearF, year],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    await cdp.send("DOM.focus", { backendNodeId: f.id }, fs);
    // eslint-disable-next-line no-await-in-loop
    await typeChars(cdp, io, digits, fs);
  }
  const after = await axNodeOf(cdp, fs, ref.backend_node_id);
  const now = after?.value?.value;
  const want = `${year}-${month}-${day}`;
  if (typeof now === "string" && now !== want) {
    return failed("date_mismatch", `The date field shows ${now.slice(0, 20)}, not ${want}.`);
  }
  return { status: "done", result: { value: typeof now === "string" ? now : want } };
}

const lastTypeAhead = new Map<string, number>();
const TYPE_AHEAD_GAP_MS = 1_100;

type OptionInfo = { label: string; value: string; disabled: boolean };

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

async function selectOption(cdp: OwnTabCdp, io: Io, op: Extract<ExtOp, { op: "select_option" }>): Promise<OpOutcome> {
  const fs = op.ref.frame_session;
  const doc = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, fs)) as { root?: DomNode };
  let target: DomNode | null = null;
  if (doc?.root) {
    walk(doc.root, (n) => {
      if (n.backendNodeId === op.ref.backend_node_id) target = n;
    });
  }
  const sel = target as DomNode | null;
  if (!sel) return failed("stale_ref", "That element is no longer on the page. Take a fresh snapshot.");
  if (tagOf(sel) !== "select") {
    return failed("not_a_select", "That is not a native dropdown. Click it to open it, then click the option.");
  }
  const sa = attrs(sel);
  if ("multiple" in sa) return failed("not_supported", "That list allows several choices; click each option instead.");
  if ("disabled" in sa) return failed("disabled", "That dropdown is disabled.");
  const options: OptionInfo[] = [];
  walk(sel, (n, p) => {
    if (tagOf(n) !== "option") return;
    const a = attrs(n);
    const own = (n.children ?? []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue ?? "").join(" ");
    const label = (a.label ?? own).replace(/\s+/g, " ").trim().slice(0, 200);
    options.push({ label, value: a.value ?? label, disabled: "disabled" in a || (!!p && tagOf(p) === "optgroup" && "disabled" in attrs(p)) });
  });
  const pick =
    op.value !== undefined
      ? options.find((o) => o.value === op.value)
      : options.find((o) => o.label === op.label) ?? options.find((o) => norm(o.label) === norm(op.label ?? ""));
  if (!pick) {
    const list = options.map((o) => o.label).join(" | ").slice(0, 300);
    return failed("no_such_option", `No option ${JSON.stringify(op.value ?? op.label)}. Options: ${list}`);
  }
  if (pick.disabled) return failed("disabled", `The option "${pick.label.slice(0, 60)}" is disabled.`);
  const read = async () => axText((await axNodeOf(cdp, fs, op.ref.backend_node_id))?.value);
  if (norm(await read()) === norm(pick.label)) return { status: "done", result: { value: pick.label, changed: false } };
  if (!pick.label) return failed("not_supported", "That option has no text to choose it by.");
  const key = `${fs ?? ""}:${op.ref.backend_node_id}`;
  let now = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const since = Date.now() - (lastTypeAhead.get(key) ?? 0);
    // eslint-disable-next-line no-await-in-loop
    if (since < TYPE_AHEAD_GAP_MS) await new Promise((r) => setTimeout(r, TYPE_AHEAD_GAP_MS - since));
    // eslint-disable-next-line no-await-in-loop
    await cdp.send("DOM.focus", { backendNodeId: op.ref.backend_node_id }, fs);
    // eslint-disable-next-line no-await-in-loop
    await typeChars(cdp, io, pick.label, fs);
    lastTypeAhead.set(key, Date.now());
    // eslint-disable-next-line no-await-in-loop
    now = await read();
    if (norm(now) === norm(pick.label)) break;
  }
  if (norm(now) !== norm(pick.label)) {
    return failed("select_mismatch", `The dropdown shows "${now.slice(0, 60)}", not "${pick.label.slice(0, 60)}".`);
  }
  return { status: "done", result: { value: pick.label, changed: true } };
}

const CHECKABLE = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
const CHECK_VERIFY_POLLS = 6;
const CHECK_VERIFY_MS = 100;

function checkedOf(n: AxNode | null): boolean | null {
  const v = n ? axProp(n, "checked") : undefined;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  const p = n ? axProp(n, "pressed") : undefined;
  if (p === true || p === "true") return true;
  if (p === false || p === "false") return false;
  return null;
}

async function setChecked(cdp: OwnTabCdp, io: Io, op: Extract<ExtOp, { op: "set_checked" }>): Promise<OpOutcome> {
  const fs = op.ref.frame_session;
  const n = await axNodeOf(cdp, fs, op.ref.backend_node_id);
  if (!n || n.backendDOMNodeId !== op.ref.backend_node_id) {
    return failed("stale_ref", "That element is no longer on the page. Take a fresh snapshot.");
  }
  const role = actionableRole(n) || axText(n.role);
  const now = checkedOf(n);
  if (!CHECKABLE.has(role) || now === null) return failed("not_checkable", "That is not a checkbox, radio button or switch.");
  if (now === op.checked) return { status: "done", result: { checked: now, changed: false } };
  if (!op.checked && (role === "radio" || role === "menuitemradio")) {
    return failed("radio_uncheck", "A radio button cannot be cleared by clicking it; choose another option instead.");
  }
  if (axProp(n, "disabled") === true) return failed("disabled", "That control is disabled.");
  const clicked = await clickRef(cdp, io, op.ref);
  if (clicked.status !== "done") return clicked;
  let after: boolean | null = null;
  for (let i = 0; i < CHECK_VERIFY_POLLS; i++) {
    // eslint-disable-next-line no-await-in-loop
    after = checkedOf(await axNodeOf(cdp, fs, op.ref.backend_node_id).catch(() => null));
    if (after === op.checked) return { status: "done", result: { checked: after, changed: true } };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, CHECK_VERIFY_MS));
  }
  return failed("check_mismatch", `Clicked it, but it is still ${after ? "checked" : "unchecked"}.`);
}

type ScreenFp = { ax: string | null; shot: string | null };
type Viewport = { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
type Metrics = { vp: Viewport; contentHeight: number | null };

const SCROLLBAR_EDGE_PX = 20;

function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${h}:${s.length}`;
}

async function shotHash(cdp: OwnTabCdp, vp: Viewport): Promise<string | null> {
  try {
    const w = Math.max(1, (vp.clientWidth ?? 800) - SCROLLBAR_EDGE_PX);
    const h = Math.max(1, (vp.clientHeight ?? 600) - SCROLLBAR_EDGE_PX);
    const clip = { x: vp.pageX ?? 0, y: vp.pageY ?? 0, width: w, height: h, scale: 0.5 };
    const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60, clip })) as { data?: unknown };
    return typeof shot?.data === "string" && shot.data.length > 0 ? hashStr(shot.data) : null;
  } catch {
    return null;
  }
}

async function screenFp(cdp: OwnTabCdp, topUrl: () => Promise<string | null>, vp: Viewport, withShot: boolean): Promise<ScreenFp> {
  const ax = (await pageSignature(cdp, topUrl))?.sig ?? null;
  return { ax, shot: withShot ? await shotHash(cdp, vp) : null };
}

const SCROLL_HOVER_MS = 50;
const SCROLL_SETTLE_RECHECK_MS = 400;

async function scrollOp(cdp: OwnTabCdp, op: Extract<ExtOp, { op: "scroll" }>, topUrl: () => Promise<string | null>): Promise<OpOutcome> {
  const metrics = async (): Promise<Metrics> => {
    const m = (await cdp.send("Page.getLayoutMetrics")) as { cssVisualViewport?: Viewport; cssContentSize?: { height?: number } };
    const ch = m?.cssContentSize?.height;
    return { vp: m?.cssVisualViewport ?? {}, contentHeight: typeof ch === "number" ? ch : null };
  };
  const { vp, contentHeight } = await metrics();
  const w = vp.clientWidth ?? 800;
  const h = vp.clientHeight ?? 600;
  const startY = vp.pageY;
  const dy = Math.max(-5000, Math.min(5000, op.dy));
  const points: { x: number; y: number; fs: string | null }[] = [];
  if (op.ref) {
    try {
      const at = boxCenter(await cdp.send("DOM.getBoxModel", { backendNodeId: op.ref.backend_node_id }, op.ref.frame_session));
      if (at) points.push({ ...at, fs: op.ref.frame_session });
    } catch {
    }
  }
  const named = points.length;
  points.push({ x: w / 2, y: h / 2, fs: null }, { x: w - 8, y: h / 2, fs: null }, { x: 8, y: h / 2, fs: null });
  if (typeof startY !== "number") {
    const p = points[0];
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY: dy }, p.fs);
    return { status: "done", result: { page_moved: null } };
  }
  const pageCanMove = contentHeight === null ? true : dy > 0 ? contentHeight - (startY + h) > 1 : startY > 1;

  let shotsUsable: boolean | null = null;
  let innerMoved: "content" | "screenshot" | null = null;
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    // eslint-disable-next-line no-await-in-loop
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "none" }, p.fs);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, SCROLL_HOVER_MS));
    // eslint-disable-next-line no-await-in-loop
    const before = await screenFp(cdp, topUrl, vp, shotsUsable !== false);
    if (shotsUsable === null) {
      // eslint-disable-next-line no-await-in-loop
      const again = before.shot ? await shotHash(cdp, vp) : null;
      shotsUsable = !!before.shot && again === before.shot;
    }
    // eslint-disable-next-line no-await-in-loop
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY: dy }, p.fs);
    let moved = false;
    for (let i = 0; i < SCROLL_SETTLE_POLLS && !moved; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, SCROLL_SETTLE_MS));
      // eslint-disable-next-line no-await-in-loop
      moved = ((await metrics()).vp.pageY ?? startY) !== startY;
    }
    if (moved) return { status: "done", result: { page_moved: true, content_changed: true, tried: k + 1 } };
    // eslint-disable-next-line no-await-in-loop
    const after = await screenFp(cdp, topUrl, vp, !!shotsUsable);
    const axChanged = before.ax !== null && after.ax !== null && before.ax !== after.ax;
    let shotChanged = !!shotsUsable && before.shot !== null && after.shot !== null && before.shot !== after.shot;
    if (shotChanged && !axChanged) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, SCROLL_SETTLE_RECHECK_MS));
      // eslint-disable-next-line no-await-in-loop
      const settled = await shotHash(cdp, vp);
      shotChanged = settled !== null && settled !== before.shot;
    }
    if (axChanged || shotChanged) {
      innerMoved = axChanged ? "content" : "screenshot";
      if (k < named || !pageCanMove) break;
    }
  }
  if (innerMoved) return { status: "done", result: { page_moved: false, content_changed: true, changed_by: innerMoved } };
  return failed("scroll_no_move", "Nothing on the page moved (it may already be at the end).");
}

async function perform(cdp: OwnTabCdp, op: ExtOp, topUrl: () => Promise<string | null>, io: Io): Promise<OpOutcome> {
  switch (op.op) {
    case "ax_snapshot": {
      const snap = await snapshot(cdp);
      return { status: "done", result: { nodes: snap.nodes, texts: snap.texts, truncated: snap.truncated } };
    }
    case "click_ref":
      return clickRef(cdp, io, op.ref, op);
    case "hover_ref":
      return hoverRef(cdp, io, op.ref);
    case "hover_xy":
      return hoverXy(cdp, io, op);
    case "click_xy":
      return clickXy(cdp, io, op);
    case "drag_ref":
      return dragRef(cdp, io, op.ref, op.to_ref);
    case "drag_xy":
      return dragXy(cdp, io, op);
    case "scroll_at":
      return scrollAt(cdp, io, op);
    case "key_chord": {
      if (op.focus_ref !== undefined && !(await sameFocus(cdp, op.focus_ref))) {
        return failed("focus_changed", "The focus moved before the keys were pressed, so they were not pressed.");
      }
      return keyChord(cdp, io, op.key, op.modifiers);
    }
    case "nav_history":
      return navHistory(cdp);
    case "history_go":
      return historyGo(cdp, io, op.entry_id, op.url);
    case "reload":
      return reloadPage(cdp, io, op.expect_url, topUrl);
    case "zoom":
      return zoomShot(cdp, op);
    case "get_page_text": {
      const t = await pageText(cdp, op.max_chars ?? PAGE_TEXT_MAX_CHARS);
      return { status: "done", result: { text: t.text, truncated: t.truncated, lines: t.lines } };
    }
    case "wait_until":
      return waitFor(cdp, op);
    case "choose":
      return choose(cdp, io, op.ref, op.option);
    case "type_ref": {
      const fs = op.ref.frame_session;
      const n = await axNodeOf(cdp, fs, op.ref.backend_node_id).catch(() => null);
      if (n && n.backendDOMNodeId === op.ref.backend_node_id && ["Date"].includes(axText(n.role))) {
        return typeDate(cdp, io, op.ref, op.text);
      }
      await cdp.send("DOM.focus", { backendNodeId: op.ref.backend_node_id }, fs);
      await input(cdp, io, "Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["selectAll"] }, fs);
      await input(cdp, io, "Input.dispatchKeyEvent", { type: "keyUp" }, fs);
      await input(cdp, io, "Input.insertText", { text: op.text }, fs);
      return { status: "done", result: {} };
    }
    case "select_option":
      return selectOption(cdp, io, op);
    case "set_checked":
      return setChecked(cdp, io, op);
    case "key": {
      if (!isAllowedKey(op.key)) return failed("key_not_allowed", "That key cannot be pressed.");
      if (op.focus_ref !== undefined && !(await sameFocus(cdp, op.focus_ref))) {
        return failed("focus_changed", "The focus moved before the key was pressed, so it was not pressed.");
      }
      await pressKey(cdp, io, op.key);
      return { status: "done", result: {} };
    }
    case "scroll":
      return scrollOp(cdp, op, topUrl);
    case "nav": {
      if (!isHttpUrl(op.url)) return failed("nav_blocked", "Only http and https pages can be opened.");
      const loaded = cdp.waitForLoad(NAV_LOAD_WAIT_MS);
      await cdp.send("Page.navigate", { url: op.url });
      await loaded;
      return { status: "done", result: {} };
    }
    case "screenshot":
      return viewportShot(cdp);
    case "assert_url": {
      const url = (await topUrl()) ?? "";
      return urlMatches(url, op.expected)
        ? { status: "done", result: {} }
        : failed("assert_url_mismatch", "The tab is not on the expected page.");
    }
    case "resolve":
      return op.at ? resolveAt(cdp, op.at) : resolveTarget(cdp, op.ref);
  }
}

async function sameFocus(cdp: OwnTabCdp, want: NodeRef | null): Promise<boolean> {
  const now = await focusedRef(cdp);
  return now === null || want === null
    ? now === want
    : now.backend_node_id === want.backend_node_id && now.frame_session === want.frame_session;
}

const SETTLE_OPS: ReadonlySet<ExtOp["op"]> = new Set([
  "click_ref",
  "type_ref",
  "select_option",
  "set_checked",
  "key",
  "nav",
  "click_xy",
  "drag_ref",
  "drag_xy",
  "key_chord",
  "history_go",
  "reload",
  "choose",
  "hover_ref",
  "hover_xy",
]);
const REF_OPS: ReadonlySet<ExtOp["op"]> = new Set(["click_ref", "type_ref", "select_option", "set_checked", "hover_ref", "drag_ref", "choose"]);
const NODE_GONE_RE = /no node (?:found )?(?:with|for) given|could not find node|node .*not found|does not belong to the document|node is detached/i;

export type ExecOpts = {
  settle?: boolean;
  clock?: SettleClock;
};

export async function executeOp(
  cdp: OwnTabCdp,
  raw: unknown,
  topUrl: () => Promise<string | null>,
  opts: ExecOpts = {},
): Promise<OpOutcome> {
  const op = parseOp(raw);
  let out: OpOutcome;
  const io: Io = { dispatched: false };
  let settleInfo: { settled: boolean; ms: number } | null = null;
  if (!op) {
    out = failed("bad_op", "The panel does not run that op.");
  } else {
    const watch = opts.settle && SETTLE_OPS.has(op.op);
    let before: Awaited<ReturnType<typeof pageSignature>> = null;
    if (watch) {
      const got = await withinMs(pageSignature(cdp, topUrl), SETTLE_MAX_MS, opts.clock);
      before = typeof got === "symbol" ? null : got;
    }
    const dialogText = "dialog_text" in op && typeof op.dialog_text === "string" ? op.dialog_text : "";
    cdp.beginStep(dialogText);
    try {
      out = await perform(cdp, op, topUrl, io);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "The step failed.";
      out =
        e instanceof CdpNotAllowedError
          ? failed("cdp_not_allowed", e.message)
          : e instanceof UnknownFrameError
            ? failed("unknown_frame", e.message)
            : REF_OPS.has(op.op) && !io.dispatched && NODE_GONE_RE.test(msg)
              ? failed("stale_ref", "That element is no longer on the page. Take a fresh snapshot.")
              : REF_OPS.has(op.op) && !io.dispatched && /could not compute box model/i.test(msg)
                ? failed("not_visible", "That element is not shown on the page right now.")
                : failed("cdp_error", msg.slice(0, 300));
    }
    if (out.status === "failed" && io.dispatched) {
      const why = typeof out.result.error_message === "string" ? ` (${out.result.error_message.slice(0, 200)})` : "";
      out = failed("extension_op_unknown", `The step started on the page but did not finish as expected${why}.`);
    }
    if (watch && out.status === "done") settleInfo = await settle(cdp, topUrl, before, opts.clock);
    const dialogs = cdp.takeDialogs();
    if (dialogs.length) out = { status: out.status, result: { ...out.result, dialogs } };
  }
  let top_url: string | null = null;
  try {
    top_url = await topUrl();
  } catch {
    top_url = null;
  }
  return { status: out.status, result: { ...out.result, ...(settleInfo ? { settle: settleInfo } : {}), top_url } };
}

type DomNode = {
  backendNodeId?: number;
  nodeName?: string;
  localName?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  documentURL?: string;
  nodeType?: number;
  nodeValue?: string;
};

const MAX_HINTS = 200;
const PAYMENT_FRAME_RE =
  /^https:\/\/(?:js\.stripe\.com\/v3\/elements-inner|checkout\.stripe\.com\/|checkout\.shopifycs\.com\/|pay\.shopify\.com\/|assets\.braintreegateway\.com\/|js\.braintreegateway\.com\/|www\.paypal\.com\/(?:smart|checkoutnow|sdk)|checkoutshopper-[a-z]+\.adyen\.com\/|pay\.google\.com\/)/i;
const CARD_NAME_RE = /card.?number|cc.?num|cardnumber|\bcvc\b|\bcvv\b|card.?cvc|exp.?date|cc.?exp/i;
const BUDGET_HINT_RE = /budget|\bbid|spend|cost cap/i;
const SUBMIT_LIKE_RE = /^\s*(submit|confirm|continue|complete|finish|pay|place|buy|order|checkout)\b/i;
const AMOUNT_RE =
  /(?:[$€£₹¥]\s?\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?|\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?\s?(?:[$€£₹¥]|(?:USD|EUR|GBP|INR|CAD|AUD)\b))/g;
const TOTAL_LABEL_RE = /\b(?:total|subtotal|amount due|due today|you(?:'ll| will)? pay|to pay|charge|order total|budget)\b/i;
const MAX_AMOUNTS = 30;

function textOf(n: DomNode, limit = 300): string {
  let out = "";
  walk(n, (x) => {
    if (out.length < limit && x.nodeType === 3 && x.nodeValue) out += ` ${x.nodeValue}`;
  });
  return out.slice(0, limit);
}

function stepAmounts(root: DomNode, scope: DomNode | null, parents: Map<DomNode, DomNode | null>): string[] {
  const labelled: string[] = [];
  walk(root, (n) => {
    if (n.nodeType !== 3 || !n.nodeValue || !AMOUNT_RE.test(n.nodeValue)) return;
    AMOUNT_RE.lastIndex = 0;
    const p = parents.get(n) ?? null;
    const ctx = `${n.nodeValue} ${p ? textOf(p) : ""}`;
    if (TOTAL_LABEL_RE.test(ctx)) for (const m of n.nodeValue.match(AMOUNT_RE) ?? []) labelled.push(m.replace(/\s+/g, " ").trim());
  });
  const inScope: string[] = [];
  if (scope) {
    walk(scope, (n) => {
      if (n.nodeType === 3 && n.nodeValue) for (const m of n.nodeValue.match(AMOUNT_RE) ?? []) inScope.push(m.replace(/\s+/g, " ").trim());
    });
  }
  return [...labelled, ...inScope].slice(0, MAX_AMOUNTS);
}

function attrs(n: DomNode): Record<string, string> {
  const out: Record<string, string> = {};
  const a = n.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) out[a[i].toLowerCase()] = a[i + 1];
  return out;
}

function tagOf(n: DomNode): string {
  return (n.localName || n.nodeName || "").toLowerCase();
}

function walk(root: DomNode, visit: (n: DomNode, parent: DomNode | null) => void, parent: DomNode | null = null): void {
  visit(root, parent);
  for (const c of root.children ?? []) walk(c, visit, root);
  for (const c of root.shadowRoots ?? []) walk(c, visit, root);
  if (root.contentDocument) walk(root.contentDocument, visit, root);
}

function isCardField(n: DomNode): boolean {
  const t = tagOf(n);
  const a = attrs(n);
  if (t === "iframe") return PAYMENT_FRAME_RE.test(a.src ?? "");
  if (t !== "input" && t !== "select") return false;
  if ((a.autocomplete ?? "").split(/\s+/).some((tok) => tok.toLowerCase().startsWith("cc-"))) return true;
  return CARD_NAME_RE.test(`${a.name ?? ""} ${a.id ?? ""}`);
}

function fieldHints(n: DomNode): string {
  const a = attrs(n);
  return [a.name, a.id, a.placeholder, a["aria-label"]].filter(Boolean).join(" ").slice(0, MAX_HINTS);
}

type AxLite = { role: string; name: string; value: string };

async function axOf(cdp: OwnTabCdp, frame: string | null, backendNodeId: number): Promise<AxLite> {
  const r = (await cdp.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }, frame)) as {
    nodes?: (AxNode & { value?: AxValue })[];
  };
  const n = (r?.nodes ?? []).find((x) => x.backendDOMNodeId === backendNodeId) ?? r?.nodes?.[0];
  const raw: unknown = n?.value?.value;
  return {
    role: (n && actionableRole(n)) || axText(n?.role),
    name: axText(n?.name).replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS),
    value: (typeof raw === "string" || typeof raw === "number" ? String(raw) : "").slice(0, MAX_NAME_CHARS),
  };
}

async function focusedRef(cdp: OwnTabCdp): Promise<NodeRef | null> {
  for (const frame of [...cdp.frameSessions(), null]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const tree = (await cdp.send("Accessibility.getFullAXTree", {}, frame)) as {
        nodes?: (AxNode & { properties?: { name?: string; value?: { value?: unknown } }[] })[];
      };
      const hit = (tree?.nodes ?? []).find(
        (n) =>
          !n.ignored &&
          Number.isInteger(n.backendDOMNodeId) &&
          !["Iframe", "RootWebArea", "WebArea"].includes(axText(n.role)) &&
          (n.properties ?? []).some((p) => p.name === "focused" && p.value?.value === true),
      );
      if (hit) return { frame_session: frame, backend_node_id: hit.backendDOMNodeId as number };
    } catch {
    }
  }
  return null;
}

async function resolveTarget(cdp: OwnTabCdp, want: NodeRef | null): Promise<OpOutcome> {
  const ref = want ?? (await focusedRef(cdp));
  if (!ref) {
    return { status: "done", result: { ref: null, role: "", name: "", is_submit: false, href: null, amounts: [], form: { has_card_field: false, budget_fields: [] } } };
  }
  const frame = ref.frame_session;
  const doc = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, frame)) as { root?: DomNode };
  const root = doc?.root;
  if (!root) return failed("no_document", "The page could not be read.");

  const parents = new Map<DomNode, DomNode | null>();
  const found: { target: DomNode | null; paymentFrame: boolean } = { target: null, paymentFrame: false };
  walk(root, (n, p) => {
    parents.set(n, p);
    if (n.backendNodeId === ref.backend_node_id) found.target = n;
    if (tagOf(n) === "iframe" && PAYMENT_FRAME_RE.test(attrs(n).src ?? "")) found.paymentFrame = true;
  });
  const t = found.target;
  if (!t) return failed("no_node", "That element is no longer on the page.");

  let frameUrl: string | null = null;
  let scope: DomNode | null = null;
  let scopeKind: "form" | "dialog" | null = null;
  let dialog: DomNode | null = null;
  for (let p = parents.get(t) ?? null; p; p = parents.get(p) ?? null) {
    if (p.nodeName === "#document") {
      frameUrl = p.documentURL ?? null;
      break;
    }
    const tag = tagOf(p);
    if (!scope && tag === "form") {
      scope = p;
      scopeKind = "form";
    }
    if (!dialog && (tag === "dialog" || attrs(p).role === "dialog" || attrs(p).role === "alertdialog")) dialog = p;
  }
  if (!frameUrl) frameUrl = root.documentURL ?? null;
  if (!scope && dialog) {
    scope = dialog;
    scopeKind = "dialog";
  }

  const ta = attrs(t);
  const tag = tagOf(t);
  const type = (ta.type ?? "").toLowerCase();
  const ax = await axOf(cdp, frame, ref.backend_node_id);
  const textEntry = tag === "input" || tag === "textarea" || ["textbox", "searchbox", "spinbutton", "combobox"].includes(ax.role);
  const card = { found: false };
  const budgetNodes: DomNode[] = [];
  if (scope) {
    walk(scope, (n) => {
      if (isCardField(n)) card.found = true;
      const nt = tagOf(n);
      if ((nt === "input" || nt === "select") && Number.isInteger(n.backendNodeId) && BUDGET_HINT_RE.test(fieldHints(n))) {
        budgetNodes.push(n);
      }
    });
  }

  const nativeSubmit =
    scopeKind === "form" &&
    ((tag === "button" && (type === "" || type === "submit")) ||
      (tag === "input" && (type === "submit" || type === "image")) ||
      (want === null && textEntry && tag !== "textarea"));
  const scriptSubmit =
    card.found && (tag === "button" || ax.role === "button") && SUBMIT_LIKE_RE.test(ax.name || "");
  const isSubmit = nativeSubmit || scriptSubmit;

  let amounts = stepAmounts(root, scope, parents);
  if (frame) {
    try {
      const top = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root?: DomNode };
      if (top?.root) {
        const topParents = new Map<DomNode, DomNode | null>();
        walk(top.root, (n, p) => topParents.set(n, p));
        amounts = [...stepAmounts(top.root, null, topParents), ...amounts].slice(0, MAX_AMOUNTS);
      }
    } catch {
    }
  }
  const budget_fields: { label: string; value: string }[] = [];
  for (const b of budgetNodes.slice(0, 3)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const bx = await axOf(cdp, frame, b.backendNodeId as number);
      budget_fields.push({ label: bx.name || fieldHints(b).slice(0, MAX_NAME_CHARS), value: bx.value });
    } catch {
    }
  }

  return {
    status: "done",
    result: {
      ref,
      role: ax.role,
      name: ax.name,
      value: textEntry ? ax.value : "",
      hints: fieldHints(t),
      frame_url: frameUrl,
      is_submit: isSubmit,
      href: tag === "a" && typeof ta.href === "string" ? ta.href : null,
      amounts,
      form: {
        kind: scopeKind,
        scope_node_id: scope && Number.isInteger(scope.backendNodeId) ? scope.backendNodeId : null,
        has_card_field: card.found,
        budget_fields,
        budget_truncated: budgetNodes.length > 3,
      },
      page_has_payment_frame: found.paymentFrame,
      tag,
      opaque_frame: (tag === "iframe" || tag === "frame") && !t.contentDocument,
    },
  };
}

const HIT_ANCESTOR_DEPTH = 10;

async function resolveAt(cdp: OwnTabCdp, at: ShotPoint): Promise<OpOutcome> {
  const css = await toCss(cdp, at, at);
  if (!css) return failed("no_viewport", "The tab's size could not be read.");
  const hit = await nodeAt(cdp, css);
  if (hit.backend_node_id === null) {
    let paymentFrame = false;
    try {
      const doc = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root?: DomNode };
      if (doc?.root) walk(doc.root, (n) => {
        if (tagOf(n) === "iframe" && PAYMENT_FRAME_RE.test(attrs(n).src ?? "")) paymentFrame = true;
      });
    } catch {
    }
    return {
      status: "done",
      result: {
        ref: null,
        hit_ref: null,
        hit_kind: "none",
        role: "",
        name: "",
        is_submit: false,
        href: null,
        amounts: [],
        form: { has_card_field: false, budget_fields: [] },
        page_has_payment_frame: paymentFrame,
      },
    };
  }
  let target = hit.backend_node_id;
  try {
    const doc = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root?: DomNode };
    const parent = new Map<number, number>();
    if (doc?.root) {
      walk(doc.root, (n, p) => {
        if (Number.isInteger(n.backendNodeId) && p && Number.isInteger(p.backendNodeId)) parent.set(n.backendNodeId as number, p.backendNodeId as number);
      });
    }
    for (let id: number | undefined = hit.backend_node_id, i = 0; id !== undefined && i < HIT_ANCESTOR_DEPTH; id = parent.get(id), i++) {
      // eslint-disable-next-line no-await-in-loop
      const ax = await axOf(cdp, null, id).catch(() => null);
      if (ax && INTERACTIVE_ROLES.has(ax.role)) {
        target = id;
        break;
      }
    }
  } catch {
  }
  const r = await resolveTarget(cdp, { frame_session: null, backend_node_id: target });
  if (r.status !== "done") return r;
  const tag = r.result.tag;
  const kind = tag === "canvas" ? "canvas" : r.result.opaque_frame === true ? "frame" : "element";
  return { status: "done", result: { ...r.result, hit_ref: { frame_session: null, backend_node_id: hit.backend_node_id }, hit_kind: kind } };
}
