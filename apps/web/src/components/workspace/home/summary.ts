
import { num } from "../counters";
import type {
  HomeSummaryPayload,
  ActiveRunRow,
  SpendBucket,
  SuggestedNextRow,
  ActivityRow,
  CompanyMdRef,
  KeyFact,
} from "./types";

export const EMPTY_SUMMARY: HomeSummaryPayload = {
  active_runs_today: [],
  spend_week: [],
  spend_total_usd: 0,
  suggested_next: [],
  company_md_ref: null,
  pending_approvals_count: 0,
  recent_activity: [],
};

function arr<T>(x: unknown, coerce: (item: unknown) => T): T[] {
  return Array.isArray(x) ? x.map(coerce) : [];
}
function str(x: unknown, d = ""): string {
  return typeof x === "string" ? x : d;
}
function nstr(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}
function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : {};
}

const DISPLAY_STATES = new Set(["answered", "failed", "running", "cancelled"]);

function coerceActiveRun(x: unknown): ActiveRunRow {
  const o = obj(x);
  const ps = nstr(o.presentation_status);
  return {
    id: str(o.id),
    agent_slug: str(o.agent_slug),
    status: str(o.status),
    started_at: nstr(o.started_at),
    finished_at: nstr(o.finished_at),
    presentation_status:
      ps && DISPLAY_STATES.has(ps)
        ? (ps as ActiveRunRow["presentation_status"])
        : undefined,
  };
}

function coerceSpendBucket(x: unknown): SpendBucket {
  const o = obj(x);
  return { date: str(o.date), usd: num(o.usd) };
}

function coerceSuggested(x: unknown): SuggestedNextRow {
  const o = obj(x);
  return {
    feedback_id: str(o.feedback_id),
    agent_slug: str(o.agent_slug),
    suggestion_text: str(o.suggestion_text),
    created_at: str(o.created_at),
  };
}

function coerceActivity(x: unknown): ActivityRow {
  const o = obj(x);
  return {
    agent_slug: str(o.agent_slug),
    finished_at: nstr(o.finished_at),
    cost_usd: num(o.cost_usd),
  };
}

function coerceKeyFact(x: unknown): KeyFact {
  const o = obj(x);
  return { label: str(o.label), value: str(o.value) };
}

function coerceCompanyMdRef(x: unknown): CompanyMdRef | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.title !== "string") return null;
  const meta = o.metadata && typeof o.metadata === "object"
    ? (o.metadata as Record<string, unknown>)
    : undefined;
  const keyFacts = meta && Array.isArray(meta.key_facts)
    ? meta.key_facts.map(coerceKeyFact)
    : undefined;
  return {
    id: o.id,
    title: o.title,
    updated_at: str(o.updated_at),
    source: typeof o.source === "string"
      ? (o.source as CompanyMdRef["source"])
      : "agent_write",
    ...(meta ? { metadata: keyFacts ? { key_facts: keyFacts } : {} } : {}),
  };
}

export function normalizeSummary(raw: unknown): HomeSummaryPayload {
  const o = obj(raw);
  return {
    active_runs_today: arr(o.active_runs_today, coerceActiveRun),
    spend_week: arr(o.spend_week, coerceSpendBucket),
    spend_total_usd: num(o.spend_total_usd),
    suggested_next: arr(o.suggested_next, coerceSuggested),
    company_md_ref: coerceCompanyMdRef(o.company_md_ref),
    pending_approvals_count: num(o.pending_approvals_count),
    recent_activity: arr(o.recent_activity, coerceActivity),
  };
}
