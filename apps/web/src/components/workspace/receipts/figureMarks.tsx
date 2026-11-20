"use client";

import { createContext, useContext, type ReactNode } from "react";
import { isProposalAt, proposalKey } from "@zavi/shared";
import { figureKey, isBareCount, type FigureReceiptMeta } from "./receiptData";

export type FigureMarks = {
  receipts: ReadonlyMap<string, FigureReceiptMeta>;
  unverified: ReadonlySet<string>;
};

export function buildFigureMarks(
  receipts: FigureReceiptMeta[] | undefined,
  unverified: string[] | undefined,
): FigureMarks | null {
  const r = new Map<string, FigureReceiptMeta>();
  for (const x of receipts ?? []) {
    const d = figureKey(x.figure);
    if (d && !r.has(d)) r.set(d, x);
  }
  const u = new Set<string>();
  for (const f of unverified ?? []) {
    const d = figureKey(f);
    if (d && !r.has(d)) u.add(d);
  }
  return r.size === 0 && u.size === 0 ? null : { receipts: r, unverified: u };
}

const NONE: object = {};
const cache = new WeakMap<object, WeakMap<object, FigureMarks | null>>();

export function cachedFigureMarks(
  receipts: FigureReceiptMeta[] | undefined,
  unverified: string[] | undefined,
): FigureMarks | null {
  if (!receipts && !unverified) return null;
  const a = receipts ?? NONE;
  const b = unverified ?? NONE;
  let inner = cache.get(a);
  if (!inner) {
    inner = new WeakMap();
    cache.set(a, inner);
  }
  if (inner.has(b)) return inner.get(b) ?? null;
  const marks = buildFigureMarks(receipts, unverified);
  inner.set(b, marks);
  return marks;
}

const FIGURE = /\$\s?\d(?:[\d,]*\d)?(?:\.\d+)?(?:[KkMB](?![a-zA-Z]))?|(?<![\d.])-?\d{1,3}(?:\.\d+)?\s?%|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{3,}(?:\.\d+)?\b|(?<![\w\p{Sc}.,:/#\-–—])\d{1,2}(?![\d%:/\-–—]|[.,]\d|[a-zA-Z])/gu;

type HText = { type: "text"; value: string };
type HElement = { type: "element"; tagName: string; properties?: Record<string, unknown>; children: HNode[] };
type HNode = HText | HElement | { type: string; children?: HNode[] };

const SKIP = new Set(["code", "pre", "a", "script", "style"]);
const NOT_TEXT = new Set(["code", "pre", "script", "style"]);
const BLOCK = new Set(["p", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "dd", "dt"]);

type Slot = { node: HText; para: { text: string }; offset: number; markable: boolean };

function collect(node: HNode, para: { text: string }, markable: boolean, out: Slot[]): void {
  const children = (node as { children?: HNode[] }).children;
  if (!children) return;
  for (const c of children) {
    if (c.type === "text") {
      const t = c as HText;
      out.push({ node: t, para, offset: para.text.length, markable });
      para.text += t.value;
    } else if (c.type === "element") {
      const tag = (c as HElement).tagName;
      if (NOT_TEXT.has(tag)) continue;
      collect(c, BLOCK.has(tag) ? { text: "" } : para, markable && !SKIP.has(tag), out);
    } else {
      collect(c, para, markable, out);
    }
  }
}

function splitText(slot: Slot, marks: FigureMarks, seen: Set<string>, proposed: Set<string>): HNode[] | null {
  const node = slot.node;
  const out: HNode[] = [];
  let last = 0;
  let changed = false;
  FIGURE.lastIndex = 0;
  for (const m of node.value.matchAll(FIGURE)) {
    const raw = m[0];
    const d = figureKey(raw);
    if (!d) continue;
    if (isProposalAt(slot.para.text, slot.offset + (m.index ?? 0), raw, proposed)) {
      const key = proposalKey(raw);
      if (key) proposed.add(key);
      continue;
    }
    if (seen.has(d)) continue;
    if (d.startsWith("#") && !isBareCount(node.value, m.index ?? 0, raw)) continue;
    const kind = marks.receipts.has(d) ? "verified" : marks.unverified.has(d) ? "unverified" : null;
    if (!kind) continue;
    seen.add(d);
    const at = m.index ?? 0;
    if (at > last) out.push({ type: "text", value: node.value.slice(last, at) });
    out.push({
      type: "element",
      tagName: "span",
      properties: { dataFig: d, dataFigKind: kind },
      children: [{ type: "text", value: raw }],
    });
    last = at + raw.length;
    changed = true;
  }
  if (!changed) return null;
  if (last < node.value.length) out.push({ type: "text", value: node.value.slice(last) });
  return out;
}

function parents(node: HNode, out: Map<HText, HNode[]>): void {
  const children = (node as { children?: HNode[] }).children;
  if (!children) return;
  for (const c of children) {
    if (c.type === "text") out.set(c as HText, children);
    else parents(c, out);
  }
}

function walk(tree: HNode, marks: FigureMarks): void {
  const slots: Slot[] = [];
  collect(tree, { text: "" }, true, slots);
  const parentOf = new Map<HText, HNode[]>();
  parents(tree, parentOf);
  const seen = new Set<string>();
  const proposed = new Set<string>();
  for (const slot of slots) {
    if (!slot.markable) continue;
    const parts = splitText(slot, marks, seen, proposed);
    const siblings = parentOf.get(slot.node);
    if (!parts || !siblings) continue;
    const i = siblings.indexOf(slot.node);
    if (i >= 0) siblings.splice(i, 1, ...parts);
  }
}

export function rehypeFigureMarks(marks: FigureMarks) {
  return () => (tree: unknown) => {
    walk(tree as HNode, marks);
  };
}

const FigureMarksContext = createContext<FigureMarks | null>(null);

export function FigureMarksProvider({ marks, children }: { marks: FigureMarks | null; children: ReactNode }) {
  return <FigureMarksContext.Provider value={marks}>{children}</FigureMarksContext.Provider>;
}

export function FigureSpan(props: Record<string, unknown> & { children?: ReactNode }) {
  const marks = useContext(FigureMarksContext);
  const { node: _node, children, ...rest } = props;
  const d = rest["data-fig"];
  if (typeof d !== "string" || !marks) return <span {...(rest as Record<string, string>)}>{children}</span>;
  if (!marks.receipts.has(d) && !marks.unverified.has(d)) return <span>{children}</span>;
  return (
    <strong className="whitespace-nowrap font-semibold tabular-nums" data-testid="figure">
      {children}
    </strong>
  );
}
