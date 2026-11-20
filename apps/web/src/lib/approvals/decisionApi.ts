
import type { DecisionHome, DecisionHomeKind } from "@zavi/shared";
import { apiFetch } from "@/lib/api";

export type DecisionSurface = "chat" | "growth" | "needs_you" | "channel";

export type ViewerRole = "owner" | "admin" | "member" | "viewer";

export type HomeDecision = {
  id: string;
  agent_run_id: string | null;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown> | null;
  status: string;
  autonomy_at_emit?: string;
  emitted_at: string;
  approved_at?: string | null;
  dispatched_at: string | null;
  dispatch_error: string | null;
  home: DecisionHomeKind | null;
  home_channel: string | null;
  channel_slug: string | null;
  agent_slug: string | null;
  thread_id: string | null;
  run_stopped: boolean;
  click_allowlistable?: boolean;
  needs_owner_admin: boolean;
  post_revision?: string;
  cgo_hold?: { words: string[]; evidence: string | null } | null;
  founder_advice?: { warnings: string[]; unavailable?: boolean } | null;
};

export type HomeTotals = Record<DecisionHomeKind, number>;

export type HomePage = {
  decisions: HomeDecision[];
  next_cursor: string | null;
  totals?: HomeTotals;
};

export async function fetchHome(
  home: DecisionHomeKind | readonly DecisionHomeKind[],
  opts: { cursor?: string | null; count?: boolean; limit?: number } = {},
): Promise<HomePage> {
  const q = new URLSearchParams({ home: typeof home === "string" ? home : home.join(",") });
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.count) q.set("count", "1");
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  const res = await apiFetch(`/api/approvals?${q.toString()}`);
  if (!res.ok) throw new Error(`Could not load this list (HTTP ${res.status}).`);
  const body = (await res.json()) as Partial<HomePage>;
  return {
    decisions: Array.isArray(body.decisions) ? body.decisions : [],
    next_cursor: typeof body.next_cursor === "string" ? body.next_cursor : null,
    ...(body.totals ? { totals: body.totals } : {}),
  };
}

export type LiveDecisionRow = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown> | null;
  status: string;
  emitted_at?: string;
  approved_at?: string | null;
  dispatched_at: string | null;
  dispatch_error: string | null;
  home?: DecisionHomeKind | null;
  home_channel?: string | null;
  agent_slug?: string | null;
  thread_id?: string | null;
  post_revision?: string;
  cgo_hold?: { words: string[]; evidence: string | null } | null;
  founder_advice?: { warnings: string[]; unavailable?: boolean } | null;
};

export type BudgetChoiceView =
  | { kind: "fits" }
  | { kind: "over"; month_label: string; projection_usd: number; monthly_usd: number;  month_cap_usd?: number; over_by_usd: number; raise_to_usd: number | null; daily_limit_usd: number | null; daily_limit_to_usd: number | null; set_aside_over?: boolean; find_money?: "available" | "none" | "unreadable" | null; find_money_why?: "set_aside" | "spent" | "not_enough" | "no_candidates" | "non_usd" | null }
  | { kind: "unreadable"; why: string };

export type RaiseAsk = { raise_budget_to_usd?: number; raise_daily_limit_to_usd?: number };

export type MoveView = {
  key: string;
  still_filing: boolean;
  lines: Array<{
    id: string;
    decision_class: string;
    title: string;
    status: string;
    side: "lowers" | "adds" | "neutral";
    daily_delta_usd: number | null;
    dispatch_error: string | null;
    waits_on_cuts: boolean;
    blocked: { code: string; at: string } | null;
    suggested?: boolean;
  }>;
};

export type FounderCut = { platform: "meta" | "google"; level: "ad_set" | "campaign"; object_id: string; name: string | null; from_usd: number; to_usd: number; frees_daily_usd: number; why: string };

export type FindMoneyResult = { kind: "candidates" | "none" | "unreadable"; why: string | null; candidates: FounderCut[]; budget_choice: BudgetChoiceView | null; move: MoveView };

export async function fetchFindMoney(id: string): Promise<FindMoneyResult> {
  const res = await apiFetch(`/api/approvals/${encodeURIComponent(id)}/find-money`);
  const j = (await res.json().catch(() => null)) as (FindMoneyResult & { error?: { message?: string } }) | null;
  if (!res.ok || !j) throw new Error(j?.error?.message ?? `Could not look for money elsewhere (HTTP ${res.status}).`);
  return { ...j, candidates: Array.isArray(j.candidates) ? j.candidates : [] };
}

export type DecisionLookup =
  | { ok: true; decision: LiveDecisionRow; home: DecisionHome; needs_owner_admin: boolean; viewer_role: ViewerRole | null; budget_choice: BudgetChoiceView | null; move: MoveView | null }
  | { ok: false; notFound: true }
  | { ok: false; notFound: false; error: string };

export async function fetchDecision(id: string): Promise<DecisionLookup> {
  try {
    const res = await apiFetch(`/api/approvals/${encodeURIComponent(id)}`);
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, notFound: false, error: `Could not load this card (HTTP ${res.status}).` };
    const body = (await res.json()) as {
      decision: LiveDecisionRow;
      home: DecisionHome;
      needs_owner_admin?: boolean;
      viewer_role?: ViewerRole | null;
      budget_choice?: BudgetChoiceView | null;
      move?: MoveView | null;
    };
    return {
      ok: true,
      decision: body.decision,
      home: body.home,
      needs_owner_admin: body.needs_owner_admin === true,
      viewer_role: body.viewer_role ?? null,
      budget_choice: body.budget_choice ?? null,
      move: body.move ?? null,
    };
  } catch (e) {
    return { ok: false, notFound: false, error: (e as Error)?.message || "Could not load this card." };
  }
}

export function surfaceQuery(surface?: DecisionSurface): string {
  return surface ? `?surface=${surface}` : "";
}
