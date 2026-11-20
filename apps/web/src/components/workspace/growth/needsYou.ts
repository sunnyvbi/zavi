"use client";

import { useEffect, useSyncExternalStore } from "react";
import { apiFetch } from "@/lib/api";
import { sharedJson } from "@/lib/workspace/sharedRead";
import { normalizeGrowthPlan, type GoalWork, type GrowthSection, type HeadOfGrowth, type NoteSectionRow } from "@/lib/workspace/useGrowthPlan";
import type { ReadState, WaitingQuestion } from "../WaitingForYou";
import { fetchHome, type HomeTotals } from "@/lib/approvals/decisionApi";

export const APPROVALS_LIST_CAP = 100;

export type Pending = {
  total: number;
  capped: boolean;
  toApprove: number;
  inChannels: Record<string, number>;
  marks?: string[];
};

export type ApprovalsBody = {
  channel_pending_counts?: Record<string, number>;
};

export type GrowthHomeRead = { totals: HomeTotals; ids: string[] };

export function pendingFromApprovals(approvals: ApprovalsBody, growth: GrowthHomeRead | null): Pending | null {
  if (!growth) return null;
  const counts = approvals.channel_pending_counts ?? {};
  const inChannels: Record<string, number> = {};
  let total = growth.totals.growth;
  const marks = growth.ids.map((id) => `d:${id}`);
  for (let i = growth.ids.length; i < growth.totals.growth; i++) marks.push(`d:#${i}`);
  for (const [slug, n] of Object.entries(counts)) {
    if (n <= 0) continue;
    total += n;
    for (let i = 0; i < n; i++) marks.push(`c:${slug}#${i}`);
    inChannels[slug] = n;
  }
  return { total, capped: false, toApprove: growth.totals.growth + growth.totals.channel, inChannels, marks };
}

export async function readGrowthHome(): Promise<GrowthHomeRead | null> {
  try {
    const page = await fetchHome("growth", { count: true, limit: APPROVALS_LIST_CAP });
    if (!page.totals) return null;
    return { totals: page.totals, ids: page.decisions.map((d) => d.id) };
  } catch {
    return null;
  }
}

type Move = GoalWork["moves"][number];

export function noteNeeds(note: NonNullable<HeadOfGrowth["note"]> | null): {
  rows: NoteSectionRow[];
  more: { count: number; url: string; line: string } | null;
  sectioned: boolean;
} {
  if (note?.sections) {
    const sec = note.sections.find((s) => s.key === "needs_you") ?? null;
    return { rows: (sec?.rows ?? []).filter((r) => r.question_ordinal == null), more: sec?.more ?? null, sectioned: true };
  }
  const rows = note && Array.isArray(note.questions) ? note.need.map((line) => ({ line, url: null })) : [];
  return { rows, more: null, sectioned: false };
}

export function waitingMovesOf(goalWork: Record<string, GoalWork> | undefined): Array<{ move: Move; actsOn: string | null }> {
  const out: Array<{ move: Move; actsOn: string | null }> = [];
  const seen = new Set<string>();
  for (const w of Object.values(goalWork ?? {})) {
    const claims = new Map((w.hypotheses ?? []).map((h) => [h.id, h.claim]));
    for (const m of w.moves) {
      if (m.state !== "waiting" || seen.has(m.decision_id)) continue;
      seen.add(m.decision_id);
      out.push({ move: m, actsOn: m.hypothesis_id ? claims.get(m.hypothesis_id) ?? null : null });
    }
  }
  return out;
}

export type NeedsYouInput = {
  questions: { state: ReadState; open: readonly WaitingQuestion[] };
  pending: Pending | null | "loading";
  note: NonNullable<HeadOfGrowth["note"]> | null;
  goalWork: Record<string, GoalWork> | undefined;
  unreadable: readonly GrowthSection[];
};

export type NeedsYouSourceState = "loading" | "ready" | "failed";
export type NeedsYouState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; total: number; capped: boolean; marks?: readonly string[] };

export function needsYouState(i: NeedsYouInput): NeedsYouState {
  const sources: NeedsYouSourceState[] = [
    i.questions.state,
    i.pending === "loading" ? "loading" : i.pending === null ? "failed" : "ready",
    i.unreadable.includes("goal_work") ? "failed" : "ready",
    i.unreadable.includes("head_of_growth") ? "failed" : "ready",
  ];
  if (sources.includes("loading")) return { kind: "loading" };
  if (sources.includes("failed")) return { kind: "failed" };
  const pending = i.pending as Pending;
  const needs = noteNeeds(i.note);
  const moves = waitingMovesOf(i.goalWork);
  const total = i.questions.open.length + needs.rows.length + (needs.more?.count ?? 0) + moves.length + pending.total;
  const marks = [
    ...i.questions.open.map((q) => `q:${q.id}`),
    ...needs.rows.map((r) => (r.rid ? `n:${r.rid}` : `n:${r.line.slice(0, 80)}`)),
    ...Array.from({ length: needs.more?.count ?? 0 }, (_, k) => `nm#${k}`),
    ...moves.map((m) => `m:${m.move.decision_id}`),
    ...(pending.marks ?? []),
  ];
  return { kind: "ready", total, capped: pending.capped, marks };
}

export type NeedsYouSignal = "yes" | "no" | "unknown";

type Store = { value: NeedsYouSignal; owner: "page" | "nav" };
let store: Store = { value: "unknown", owner: "nav" };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;
let generation = 0;
let approvalsReadOnce = false;

export const NEEDS_YOU_CHANGED_EVENT = "needs-you:changed";

const SEEN_PREFIX = "zavi:cgo-needs-seen:";
let seenTenant: string | null = null;
let seen = new Set<string>();

function marksOf(state: Extract<NeedsYouState, { kind: "ready" }>): readonly string[] {
  return state.marks ?? Array.from({ length: state.total }, (_, k) => `t#${k}`);
}

function loadSeen(raw: string | null): Set<string> {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : []);
  } catch {
    return new Set();
  }
}

export function setNeedsYouTenant(id: string | null | undefined): void {
  const next = id || null;
  if (next === seenTenant) return;
  seenTenant = next;
  seen = new Set();
  if (!next) return;
  try {
    seen = loadSeen(window.localStorage.getItem(SEEN_PREFIX + next));
  } catch {
  }
}

function markSeen(next: Set<string>): void {
  if (next.size === seen.size && [...next].every((m) => seen.has(m))) return;
  seen = next;
  if (!seenTenant) return;
  try {
    window.localStorage.setItem(SEEN_PREFIX + seenTenant, JSON.stringify([...next]));
  } catch {
  }
}

function navSignalOf(state: NeedsYouState): NeedsYouSignal {
  if (state.kind !== "ready") return "unknown";
  const marks = marksOf(state);
  if (!state.capped) markSeen(new Set(marks.filter((m) => seen.has(m))));
  return marks.some((m) => !seen.has(m)) ? "yes" : "no";
}

function onStorage(e: StorageEvent): void {
  if (!seenTenant || e.key !== SEEN_PREFIX + seenTenant) return;
  seen = loadSeen(e.newValue);
  generation += 1;
  inFlight = null;
  void readNeedsYou();
}

function emit(next: Store) {
  if (next.value === store.value && next.owner === store.owner) return;
  store = next;
  for (const l of listeners) l();
}

export function signalOf(state: NeedsYouState): NeedsYouSignal {
  return state.kind === "ready" ? (state.total > 0 ? "yes" : "no") : "unknown";
}

export function publishFromPage(state: NeedsYouState): void {
  if (store.owner !== "page") generation += 1;
  if (state.kind === "loading") {
    emit({ value: store.value, owner: "page" });
    return;
  }
  if (state.kind === "ready") markSeen(new Set(marksOf(state)));
  emit({ value: state.kind === "ready" ? "no" : signalOf(state), owner: "page" });
}

export function releaseFromPage(): void {
  generation += 1;
  inFlight = null;
  emit({ value: store.value, owner: "nav" });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NEEDS_YOU_CHANGED_EVENT));
}

export function readNeedsYou(): Promise<void> {
  if (store.owner === "page") return Promise.resolve();
  if (inFlight) return inFlight;
  const gen = generation;
  let read!: Promise<void>;
  read = (async () => {
    try {
      const fresh = approvalsReadOnce;
      approvalsReadOnce = true;
      const [q, p, approvals, g] = await Promise.all([
        apiFetch("/api/workspace/growth/questions"),
        apiFetch("/api/workspace/growth/plan"),
        sharedJson<ApprovalsBody>("/api/approvals", { fresh }),
        readGrowthHome(),
      ]);
      const questionsBody = q?.ok ? ((await q.json()) as { questions?: WaitingQuestion[] }) : null;
      const plan = p?.ok ? normalizeGrowthPlan(await p.json()) : null;
      const state = needsYouState({
        questions: questionsBody
          ? { state: "ready", open: Array.isArray(questionsBody.questions) ? questionsBody.questions : [] }
          : { state: "failed", open: [] },
        pending: approvals ? pendingFromApprovals(approvals, g) : null,
        note: plan?.head_of_growth?.note ?? null,
        goalWork: plan?.goal_work,
        unreadable: plan ? plan.unreadable : ["goal_work", "head_of_growth"],
      });
      if (gen === generation && store.owner === "nav") emit({ value: navSignalOf(state), owner: "nav" });
    } catch {
      if (gen === generation && store.owner === "nav") emit({ value: "unknown", owner: "nav" });
    } finally {
      if (inFlight === read) inFlight = null;
    }
  })();
  inFlight = read;
  return read;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const currentNeedsYouSignal = (): NeedsYouSignal => store.value;
const snapshot = currentNeedsYouSignal;

export function useNeedsYouSignal(tenantId?: string | null): NeedsYouSignal {
  const value = useSyncExternalStore(subscribe, snapshot, () => "unknown" as const);
  useEffect(() => {
    setNeedsYouTenant(tenantId);
    void readNeedsYou();
  }, [tenantId]);
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void readNeedsYou();
    };
    const onChanged = () => void readNeedsYou();
    window.addEventListener("focus", onFocus);
    window.addEventListener(NEEDS_YOU_CHANGED_EVENT, onChanged);
    window.addEventListener("autopilot:goals-changed", onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(NEEDS_YOU_CHANGED_EVENT, onChanged);
      window.removeEventListener("autopilot:goals-changed", onChanged);
    };
  }, []);
  return value;
}

export const __needsYouOwner = (): "page" | "nav" => store.owner;

export function __resetNeedsYouStore(): void {
  store = { value: "unknown", owner: "nav" };
  inFlight = null;
  generation = 0;
  seenTenant = null;
  seen = new Set();
}
