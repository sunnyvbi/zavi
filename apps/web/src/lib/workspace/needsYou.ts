
import { useSyncExternalStore } from "react";
import { fetchHome, type HomeDecision, type HomeTotals } from "@/lib/approvals/decisionApi";
import { reviewDecisionText } from "@/components/workspace/growth/ReviewRow";
import { agentDisplayName } from "@/lib/agentRegistry";
import type { WorkspaceThreadMeta } from "@/components/workspace/useAgentThreads";
import { firstSentence } from "./buildHistory";

export const ATTENTION_CHANGED_EVENT = "zavi:attention-changed";

export const NEEDS_YOU_HOMES = ["needs_you", "growth", "channel"] as const;
export const NEEDS_YOU_PAGE = 25;
export const NEEDS_YOU_POLL_MS = 120_000;
export const NEEDS_YOU_HIDDEN_POLL_MS = 300_000;

export type NeedsYouItem =
  | { kind: "approval"; key: string; id: string; who: string; text: string; at: string }
  | { kind: "question"; key: string; threadId: string; agentSlug: string; who: string; text: string; at: string };

type Snapshot = {
  tenantId: string | null;
  decisions: HomeDecision[];
  totals: HomeTotals | null;
  loaded: boolean;
};

const EMPTY: Snapshot = { tenantId: null, decisions: [], totals: null, loaded: false };
let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let queued = false;

function emit(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

export function subscribeNeedsYou(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getNeedsYouSnapshot(): Snapshot {
  return snapshot;
}

export function resetNeedsYouStore() {
  snapshot = EMPTY;
  inflight = null;
  queued = false;
  listeners.clear();
}

export function refreshNeedsYou(tenantId: string): Promise<void> {
  if (snapshot.tenantId !== tenantId) emit({ ...EMPTY, tenantId });
  if (inflight) {
    queued = true;
    return inflight;
  }
  inflight = (async () => {
    try {
      const page = await fetchHome(NEEDS_YOU_HOMES, { count: true, limit: NEEDS_YOU_PAGE });
      if (snapshot.tenantId !== tenantId) return;
      emit({ tenantId, decisions: page.decisions, totals: page.totals ?? snapshot.totals, loaded: true });
    } catch (e) {
      console.warn("[needs-you] approvals refresh failed:", (e as Error).message);
    } finally {
      inflight = null;
      if (queued) {
        queued = false;
        void refreshNeedsYou(snapshot.tenantId ?? tenantId);
      }
    }
  })();
  return inflight;
}

export function useNeedsYouSnapshot(): Snapshot {
  return useSyncExternalStore(subscribeNeedsYou, getNeedsYouSnapshot, () => EMPTY);
}

function approvalItem(d: HomeDecision): NeedsYouItem {
  const text = reviewDecisionText({ decision_class: d.decision_class, handler: d.handler, body: d.body ?? {} });
  const who = d.agent_slug ? agentDisplayName(d.agent_slug) : text.agent;
  return { kind: "approval", key: `approval:${d.id}`, id: d.id, who, text: text.title, at: d.emitted_at };
}

export function needsYouItems(
  decisions: readonly HomeDecision[],
  threads: readonly WorkspaceThreadMeta[],
  dismissed: ReadonlySet<string>,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = decisions.map(approvalItem);
  for (const t of threads) {
    const r = t.unread_reply;
    if (!t.unread || !r || r.kind !== "question") continue;
    items.push({
      kind: "question",
      key: `question:${t.id}:${r.at}`,
      threadId: t.id,
      agentSlug: t.agent_slug,
      who: agentDisplayName(t.agent_slug),
      text: firstSentence(r.head) || "Has a question for you.",
      at: r.at,
    });
  }
  return items
    .filter((i) => !dismissed.has(i.key))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? -1 : 1));
}

export function needsYouRemaining(
  s: Snapshot,
  items: readonly NeedsYouItem[],
  dismissed: ReadonlySet<string>,
): number {
  const questions = items.filter((i) => i.kind === "question").length;
  const loadedApprovals = items.length - questions;
  if (!s.totals) return items.length;
  const total = NEEDS_YOU_HOMES.reduce((n, h) => n + (s.totals?.[h] ?? 0), 0);
  const pending = new Set(s.decisions.map((d) => `approval:${d.id}`));
  let closed = 0;
  for (const k of dismissed) if (pending.has(k)) closed += 1;
  return Math.max(loadedApprovals, total - closed) + questions;
}

export function needsYouNavCount(s: Snapshot): number {
  return s.totals?.needs_you ?? 0;
}
