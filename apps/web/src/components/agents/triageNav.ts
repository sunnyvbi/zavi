
import type { DecisionBrief } from "./decisionSupport";

export type TriageDecision = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown>;
  status: string;
  agent_slug?: string | null;
  emitted_at: string;
  dispatched_at?: string | null;
  dispatch_error?: string | null;
  revision?: {
    id: string;
    status: string;
    message: string;
    assistant_text: string | null;
    replacement_decision_id: string | null;
    last_error?: string | null;
    created_at: string;
  } | null;
  brief?: DecisionBrief | null;
};

export type TriageBucket = { key: string; label: string; items: TriageDecision[] };

export type TriageItem = { decision: TriageDecision; bucketKey: string; bucketLabel: string };

export function flattenBuckets(buckets: TriageBucket[]): TriageItem[] {
  const out: TriageItem[] = [];
  for (const b of buckets) {
    for (const d of b.items) {
      out.push({ decision: d, bucketKey: b.key, bucketLabel: b.label });
    }
  }
  return out;
}

export function clampIndex(index: number, len: number): number {
  if (len <= 0) return 0;
  if (index < 0) return 0;
  if (index > len - 1) return len - 1;
  return index;
}

export type TriageKeyAction =
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "modify" }
  | { kind: "prev" }
  | { kind: "next" }
  | { kind: "none" };

export function keyToTriageAction(key: string): TriageKeyAction {
  switch (key) {
    case "a":
    case "A":
      return { kind: "approve" };
    case "r":
    case "R":
      return { kind: "reject" };
    case "m":
    case "M":
      return { kind: "modify" };
    case "ArrowLeft":
      return { kind: "prev" };
    case "ArrowRight":
      return { kind: "next" };
    default:
      return { kind: "none" };
  }
}

export function navigate(current: number, dir: "prev" | "next", len: number): number {
  const delta = dir === "next" ? 1 : -1;
  return clampIndex(current + delta, len);
}

export function progressLabel(args: {
  current: number;
  total: number;
  approved: number;
  rejected: number;
}): string {
  const { current, total, approved, rejected } = args;
  const head = total > 0 ? `${Math.min(current + 1, total)} of ${total}` : "0 of 0";
  const parts = [head];
  if (approved > 0) parts.push(`${approved} approved`);
  if (rejected > 0) parts.push(`${rejected} rejected`);
  return parts.join(" · ");
}
