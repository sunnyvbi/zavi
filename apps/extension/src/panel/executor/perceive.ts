
import type { OwnTabCdp } from "./cdp";

export type NodeRef = { frame_session: string | null; backend_node_id: number };

export type SnapshotNode = {
  role: string;
  name: string;
  ref: NodeRef;
  value?: string;
  states?: string[];
  desc?: string;
  near?: string;
  in_view?: boolean;
};

export const MAX_NAME_CHARS = 80;
export const MAX_SNAPSHOT_NODES = 400;
export const MAX_VALUE_CHARS = 80;
const MAX_DESC_CHARS = 60;
const MAX_NEAR_CHARS = 40;
export const MAX_SNAPSHOT_TEXT_CHARS = 2_000;
const MAX_TEXT_ITEM_CHARS = 160;
export const MAX_SNAPSHOT_JSON_CHARS = 64_000;
const NODE_BOX_LOOKUPS = 1_500;
const TEXT_BOX_LOOKUPS = 300;
const BOX_CONCURRENCY = 100;
const BOX_TIME_BUDGET_MS = 1_500;

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
  "Date",
  "DateTime",
  "InputTime",
]);

const VALUE_ROLES: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
  "Date",
  "DateTime",
  "InputTime",
]);

export type AxValue = { value?: unknown; sources?: { type?: string; value?: { value?: unknown } }[] } | undefined;
export type AxProp = { name?: string; value?: { value?: unknown } };
export type AxNode = {
  nodeId?: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  backendDOMNodeId?: number;
  properties?: AxProp[];
};

export function axText(v: AxValue): string {
  return typeof v?.value === "string" ? v.value : "";
}

export function axProp(n: AxNode, name: string): unknown {
  return (n.properties ?? []).find((p) => p.name === name)?.value?.value;
}

function placeholderOf(n: AxNode): string {
  const src = (n.name?.sources ?? []).find((x) => x.type === "placeholder" && typeof x.value?.value === "string");
  return typeof src?.value?.value === "string" ? src.value.value : "";
}

function squash(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

export function actionableRole(n: AxNode): string {
  const role = axText(n.role);
  if (INTERACTIVE_ROLES.has(role)) return role;
  const props = n.properties ?? [];
  const editable = props.some((p) => p.name === "editable" && (p.value?.value === "richtext" || p.value?.value === "plaintext"));
  const focusable = props.some((p) => p.name === "focusable" && p.value?.value === true);
  return editable && focusable ? "textbox" : "";
}

export function statesOf(n: AxNode): string[] {
  const out: string[] = [];
  const is = (name: string) => {
    const v = axProp(n, name);
    return v === true || v === "true";
  };
  const checked = axProp(n, "checked");
  if (checked === true || checked === "true") out.push("checked");
  else if (checked === "mixed") out.push("mixed");
  else if (checked === false || checked === "false") out.push("unchecked");
  if (is("selected")) out.push("selected");
  const expanded = axProp(n, "expanded");
  if (expanded === true || expanded === "true") out.push("expanded");
  else if (expanded === false || expanded === "false") out.push("collapsed");
  const pressed = axProp(n, "pressed");
  if (pressed === true || pressed === "true") out.push("pressed");
  if (is("disabled")) out.push("disabled");
  if (is("required")) out.push("required");
  if (is("readonly")) out.push("readonly");
  return out;
}

export function documentOrder(nodes: AxNode[]): AxNode[] {
  if (!nodes.length || nodes.some((n) => typeof n.nodeId !== "string")) return nodes;
  const byId = new Map(nodes.map((n) => [n.nodeId as string, n]));
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const out: AxNode[] = [];
  const seen = new Set<string>();
  const stack = [...roots].reverse();
  while (stack.length) {
    const n = stack.pop() as AxNode;
    if (seen.has(n.nodeId as string)) continue;
    seen.add(n.nodeId as string);
    out.push(n);
    const kids = (n.childIds ?? []).map((id) => byId.get(id)).filter((k): k is AxNode => !!k);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  for (const n of nodes) if (!seen.has(n.nodeId as string)) out.push(n);
  return out;
}

type Rect = { x0: number; y0: number; x1: number; y1: number };

export function rectOf(model: unknown): Rect | null {
  const q = (model as { model?: { border?: number[]; content?: number[] } } | null)?.model;
  const pts = q?.border ?? q?.content;
  if (!Array.isArray(pts) || pts.length < 8) return null;
  const xs = [pts[0], pts[2], pts[4], pts[6]];
  const ys = [pts[1], pts[3], pts[5], pts[7]];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export async function viewportOf(cdp: OwnTabCdp, frame: string | null): Promise<{ w: number; h: number } | null> {
  try {
    const m = (await cdp.send("Page.getLayoutMetrics", {}, frame)) as {
      cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    };
    const w = m?.cssVisualViewport?.clientWidth;
    const h = m?.cssVisualViewport?.clientHeight;
    return typeof w === "number" && typeof h === "number" && w > 0 && h > 0 ? { w, h } : null;
  } catch {
    return null;
  }
}

type Pending = { frame: string | null; box: number | null };
type FrameRead = {
  frame: string | null;
  nodes: (SnapshotNode & { _box: number })[];
  texts: { text: string; box: number | null }[];
};

async function readFrame(cdp: OwnTabCdp, frame: string | null): Promise<FrameRead> {
  await cdp.send("Accessibility.enable", {}, frame);
  const tree = (await cdp.send("Accessibility.getFullAXTree", {}, frame)) as { nodes?: AxNode[] };
  const all = tree?.nodes ?? [];
  const byId = new Map(all.filter((n) => typeof n.nodeId === "string").map((n) => [n.nodeId as string, n]));
  const out: FrameRead = { frame, nodes: [], texts: [] };
  let lastText = "";
  const inside = (n: AxNode, pred: (a: AxNode) => boolean): boolean => {
    for (let p = n.parentId ? byId.get(n.parentId) : undefined, i = 0; p && i < 50; p = p.parentId ? byId.get(p.parentId) : undefined, i++) {
      if (pred(p)) return true;
    }
    return false;
  };
  const elementOf = (n: AxNode): number | null => {
    for (let p = n.parentId ? byId.get(n.parentId) : undefined, i = 0; p && i < 50; p = p.parentId ? byId.get(p.parentId) : undefined, i++) {
      if (Number.isInteger(p.backendDOMNodeId) && axText(p.role) !== "StaticText") return p.backendDOMNodeId as number;
    }
    return null;
  };
  for (const n of documentOrder(all)) {
    if (n.ignored) continue;
    const rawRole = axText(n.role);
    if (rawRole === "StaticText") {
      const t = squash(axText(n.name), MAX_TEXT_ITEM_CHARS);
      if (!t) continue;
      lastText = t;
      if (!inside(n, (a) => !a.ignored && !!actionableRole(a))) out.texts.push({ text: t, box: elementOf(n) });
      continue;
    }
    const role = actionableRole(n);
    if (!role || !Number.isInteger(n.backendDOMNodeId)) continue;
    if (role === "spinbutton" && inside(n, (a) => ["Date", "DateTime", "InputTime"].includes(axText(a.role)))) continue;
    const name = squash(axText(n.name), MAX_NAME_CHARS);
    const node: SnapshotNode & { _box: number } = {
      role,
      name,
      ref: { frame_session: frame, backend_node_id: n.backendDOMNodeId as number },
      _box: n.backendDOMNodeId as number,
    };
    const rawValue = n.value?.value;
    const value = typeof rawValue === "string" || typeof rawValue === "number" ? squash(String(rawValue), MAX_VALUE_CHARS) : "";
    if (value && VALUE_ROLES.has(role)) node.value = value;
    const states = statesOf(n);
    if (states.length) node.states = states;
    const desc = squash(axText(n.description) || placeholderOf(n), MAX_DESC_CHARS);
    if (desc && desc !== name) node.desc = desc;
    if (!name && lastText) node.near = lastText.slice(0, MAX_NEAR_CHARS);
    out.nodes.push(node);
  }
  return out;
}

async function markInView(cdp: OwnTabCdp, frames: FrameRead[]): Promise<Map<string, boolean>> {
  const verdict = new Map<string, boolean>();
  const key = (frame: string | null, id: number) => `${frame ?? ""}:${id}`;
  const seen = new Set<string>();
  const pick = (items: Pending[], cap: number): Pending[] => {
    const out: Pending[] = [];
    for (const w of items) {
      if (out.length >= cap) break;
      if (w.box === null) continue;
      const k = key(w.frame, w.box);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(w);
    }
    return out;
  };
  const nodeWants: Pending[] = [];
  const textWants: Pending[] = [];
  for (const f of frames) {
    for (const n of f.nodes) nodeWants.push({ frame: f.frame, box: n._box });
    for (const t of f.texts) textWants.push({ frame: f.frame, box: t.box });
  }
  const todo = [...pick(nodeWants, NODE_BOX_LOOKUPS), ...pick(textWants, TEXT_BOX_LOOKUPS)];
  if (!todo.length) return verdict;
  const viewports = new Map<string | null, { w: number; h: number } | null>();
  for (const f of frames) viewports.set(f.frame, await viewportOf(cdp, f.frame));
  const batch = todo;
  const started = Date.now();
  for (let i = 0; i < batch.length && Date.now() - started < BOX_TIME_BUDGET_MS; i += BOX_CONCURRENCY) {
    await Promise.all(
      batch.slice(i, i + BOX_CONCURRENCY).map(async (w) => {
        const vp = viewports.get(w.frame);
        if (!vp || w.box === null) return;
        let r: Rect | null = null;
        try {
          r = rectOf(await cdp.send("DOM.getBoxModel", { backendNodeId: w.box }, w.frame));
        } catch {
          verdict.set(key(w.frame, w.box), false);
          return;
        }
        if (!r) return;
        const on = r.x1 > 0 && r.y1 > 0 && r.x0 < vp.w && r.y0 < vp.h && r.x1 - r.x0 >= 1 && r.y1 - r.y0 >= 1;
        verdict.set(key(w.frame, w.box), on);
      }),
    );
  }
  return verdict;
}

export type Snapshot = { nodes: SnapshotNode[]; texts: string[]; truncated: boolean };

export async function snapshot(cdp: OwnTabCdp): Promise<Snapshot> {
  const frames: FrameRead[] = [await readFrame(cdp, null)];
  for (const f of cdp.frameSessions()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      frames.push(await readFrame(cdp, f));
    } catch {
    }
  }
  const inView = await markInView(cdp, frames);
  const rank = (v: boolean | undefined) => (v === true ? 0 : v === undefined ? 1 : 2);

  const nodes: (SnapshotNode & { _box?: number })[] = [];
  for (const f of frames) {
    for (const n of f.nodes) {
      const v = inView.get(`${f.frame ?? ""}:${n._box}`);
      if (v !== undefined) n.in_view = v;
      nodes.push(n);
    }
  }
  const ordered = nodes.map((n, i) => ({ n, i })).sort((a, b) => rank(a.n.in_view) - rank(b.n.in_view) || a.i - b.i);
  const kept: SnapshotNode[] = [];
  let size = 2;
  let truncated = ordered.length > MAX_SNAPSHOT_NODES;
  for (const { n } of ordered.slice(0, MAX_SNAPSHOT_NODES)) {
    const { _box: _drop, ...clean } = n;
    const len = JSON.stringify(clean).length + 1;
    if (size + len > MAX_SNAPSHOT_JSON_CHARS) {
      truncated = true;
      break;
    }
    size += len;
    kept.push(clean);
  }

  const texts: { text: string; v: boolean | undefined; i: number }[] = [];
  let i = 0;
  for (const f of frames) {
    for (const t of f.texts) {
      texts.push({ text: t.text, v: t.box === null ? undefined : inView.get(`${f.frame ?? ""}:${t.box}`), i: i++ });
    }
  }
  const outTexts: string[] = [];
  let chars = 0;
  const seenText = new Set<string>();
  for (const t of texts.filter((x) => x.v !== false).sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i)) {
    if (seenText.has(t.text)) continue;
    if (chars + t.text.length > MAX_SNAPSHOT_TEXT_CHARS) break;
    seenText.add(t.text);
    outTexts.push(t.text);
    chars += t.text.length + 1;
  }
  return { nodes: kept, texts: outTexts, truncated };
}

const SETTLE_POLL_MS = 150;
const SETTLE_QUIET_MS = 400;
const SETTLE_NO_CHANGE_MS = 1_200;
export const SETTLE_MAX_MS = 3_000;
const BUSY_NAME_RE = /^\W*(loading|saving|processing|submitting|please wait)\b/i;

export type PageSig = { sig: string; busy: boolean };

export async function pageSignature(cdp: OwnTabCdp, topUrl: () => Promise<string | null>): Promise<PageSig | null> {
  try {
    await cdp.send("Accessibility.enable");
    const tree = (await cdp.send("Accessibility.getFullAXTree")) as { nodes?: AxNode[] };
    let h = 5381;
    const add = (s: string) => {
      for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    };
    let busy = false;
    add(String((await topUrl().catch(() => null)) ?? ""));
    for (const n of tree?.nodes ?? []) {
      if (n.ignored) continue;
      const role = axText(n.role);
      if (role === "InlineTextBox") continue;
      const name = axText(n.name);
      const v = n.value?.value;
      add(`|${role}|${name}|${typeof v === "string" || typeof v === "number" ? v : ""}|${statesOf(n).join(",")}`);
      if (role === "progressbar" || axProp(n, "busy") === true || (name.length <= 40 && BUSY_NAME_RE.test(name))) busy = true;
    }
    return { sig: `${h}:${tree?.nodes?.length ?? 0}`, busy };
  } catch {
    return null;
  }
}

export type SettleResult = { settled: boolean; ms: number };

export type SettleClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timer: (ms: number) => { done: Promise<void>; cancel: () => void };
};
export const realClock: SettleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  timer: (ms) => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((r) => {
      t = setTimeout(r, Math.max(0, ms));
    });
    return { done, cancel: () => clearTimeout(t) };
  },
};

const TIMED_OUT = Symbol("timed_out");

export async function withinMs<T>(p: Promise<T>, ms: number, clock: SettleClock = realClock): Promise<T | typeof TIMED_OUT> {
  const t = clock.timer(ms);
  try {
    return await Promise.race<T | typeof TIMED_OUT>([p, t.done.then((): typeof TIMED_OUT => TIMED_OUT)]);
  } finally {
    t.cancel();
  }
}

export async function settle(
  cdp: OwnTabCdp,
  topUrl: () => Promise<string | null>,
  before: PageSig | null,
  clock: SettleClock = realClock,
): Promise<SettleResult> {
  const start = clock.now();
  const read = async (): Promise<PageSig | null> => {
    const left = SETTLE_MAX_MS - (clock.now() - start);
    if (left <= 0) return null;
    const got = await withinMs(pageSignature(cdp, topUrl), left, clock);
    return got === TIMED_OUT ? null : got;
  };
  let last = await read();
  if (!last) return { settled: false, ms: clock.now() - start };
  let changed = !!before && before.sig !== last.sig;
  let lastChange = start;
  for (;;) {
    const t = clock.now();
    if (t - start >= SETTLE_MAX_MS) return { settled: false, ms: t - start };
    if (!last.busy) {
      if (changed && t - lastChange >= SETTLE_QUIET_MS) return { settled: true, ms: t - start };
      if (!changed && t - start >= SETTLE_NO_CHANGE_MS) return { settled: true, ms: t - start };
    }
    await clock.sleep(SETTLE_POLL_MS);
    const next = await read();
    if (!next) return { settled: false, ms: clock.now() - start };
    if (next.sig !== last.sig) {
      changed = true;
      lastChange = clock.now();
    }
    last = next;
  }
}
