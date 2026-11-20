
import { RETIRED_CHANNEL_SLUGS } from "@zavi/shared";
import {
  DEFAULT_TIER_AGENT_MIN,
  DEFAULT_TIER_ALWAYS_PRO,
  DONE_FOR_YOU_KEY_PREFIX,
  DONE_FOR_YOU_MAX_ATTEMPTS,
  doneForYouAttemptOf,
  doneForYouKey,
  isDoneForYouIdentity,
  isTierGatedChannel,
  requiredTierFor,
  type Tier,
} from "@/services/billing/tiers";
import { PROFILE_CHANNELS } from "@/services/channels/card-presentation";
export {
  DONE_FOR_YOU_MAX_BUDGET_USD,
  DONE_FOR_YOU_MAX_CREDITS,
  DONE_FOR_YOU_TOOL_DENIED_REASON,
  isDoneForYouAllowedTool,
} from "./done-for-you-tools";

export { DONE_FOR_YOU_KEY_PREFIX, DONE_FOR_YOU_MAX_ATTEMPTS, doneForYouKey };

export const DONE_FOR_YOU_STALE_MS = 30 * 60_000;

export const CANNOT_DO_PREFIX = "Can't do:";

export type DoneForYouMode = "research" | "visual";

export type DoneForYouRefusal =
  | "not_open"
  | "snoozed"
  | "not_a_card_task"
  | "channel_not_free_previewable"
  | "needs_account"
  | "already_final"
  | "needs_founder"
  | "cannot_do_before";

export type DoneForYouEligibility =
  | { eligible: true; mode: DoneForYouMode }
  | { eligible: false; reason: DoneForYouRefusal };

export type DfyActionRow = {
  id: string;
  channel_slug: string;
  status: string;
  snoozed_until?: string | null;
  body: Record<string, unknown> | null;
  exec_class: string | null;
  exec_status: string | null;
  card_kind: string | null;
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const RESEARCH_DELIVERABLES: ReadonlySet<string | null> = new Set([null, "list", "brief", "proof_topics", "other"]);
const VISUAL_CHANNELS: ReadonlySet<string> = new Set(["instagram_organic", "pinterest_organic"]);
const VISUAL_CARD_KINDS: ReadonlySet<string> = new Set(["post", "copy_to_site"]);
const VISUAL_DELIVERABLES: ReadonlySet<string> = new Set(["post", "script"]);
const FINAL_COPY_DELIVERABLES: ReadonlySet<string> = new Set(["page_copy", "code", "comment"]);
const EXCLUDED_CHANNELS: ReadonlySet<string> = new Set(["generated_video"]);

export type ChannelFacts = {
  agentMin?: Readonly<Record<string, Tier>>;
  alwaysPro?: readonly string[];
  hasRecipe: (slug: string) => boolean;
};

export function doneForYouEligibility(
  row: DfyActionRow,
  now: number,
  priorCantDo: ReadonlySet<string>,
  facts: ChannelFacts,
): DoneForYouEligibility {
  if (row.status !== "pending" && row.status !== "snoozed") return { eligible: false, reason: "not_open" };
  if (row.status === "snoozed" && row.snoozed_until) {
    const t = Date.parse(row.snoozed_until);
    if (Number.isFinite(t) && t > now) return { eligible: false, reason: "snoozed" };
  }
  if (row.exec_class !== null || row.exec_status !== null) return { eligible: false, reason: "not_a_card_task" };
  const body = obj(row.body);
  const step = obj(body.step);
  const deliverable = obj(step.deliverable);
  const dk = typeof deliverable.kind === "string" && deliverable.kind ? deliverable.kind : null;
  if (dk === "strategy") return { eligible: false, reason: "not_a_card_task" };

  const slug = row.channel_slug;
  const map = facts.agentMin ?? DEFAULT_TIER_AGENT_MIN;
  const alwaysPro = facts.alwaysPro ?? DEFAULT_TIER_ALWAYS_PRO;
  if (
    !isTierGatedChannel(slug) ||
    requiredTierFor(slug, map, alwaysPro) !== "starter" ||
    RETIRED_CHANNEL_SLUGS.has(slug) ||
    EXCLUDED_CHANNELS.has(slug) ||
    !facts.hasRecipe(slug)
  ) {
    return { eligible: false, reason: "channel_not_free_previewable" };
  }
  if (priorCantDo.has(row.id)) return { eligible: false, reason: "cannot_do_before" };

  if (body.intent === "answer") return { eligible: false, reason: "needs_founder" };
  if (/connect|authori[sz]e/i.test(String(step.action_type ?? ""))) return { eligible: false, reason: "needs_founder" };
  if (PROFILE_CHANNELS.has(slug) && obj(step.target).kind === "profile") return { eligible: false, reason: "needs_account" };

  const ck = row.card_kind ?? "";
  if (VISUAL_CHANNELS.has(slug) && VISUAL_CARD_KINDS.has(ck) && dk !== null && VISUAL_DELIVERABLES.has(dk)) {
    return { eligible: true, mode: "visual" };
  }
  if (ck === "task") {
    return RESEARCH_DELIVERABLES.has(dk) ? { eligible: true, mode: "research" } : { eligible: false, reason: "not_a_card_task" };
  }
  if (ck === "message") return { eligible: false, reason: "needs_account" };
  if (ck === "post") return VISUAL_CHANNELS.has(slug) ? { eligible: false, reason: "not_a_card_task" } : { eligible: false, reason: "needs_account" };
  if (ck === "copy_to_site" && dk !== null && FINAL_COPY_DELIVERABLES.has(dk)) return { eligible: false, reason: "already_final" };
  return { eligible: false, reason: "not_a_card_task" };
}

export function isDoneForYouClaim(claim: {
  tenant_id: string;
  trigger: string;
  enqueued_by?: string | null;
  cron_dedupe_key?: string | null;
}): boolean {
  return isDoneForYouIdentity(claim.tenant_id, {
    trigger: claim.trigger,
    enqueuedByUser: claim.enqueued_by != null,
    payload: null,
    cronDedupeKey: claim.cron_dedupe_key ?? null,
  });
}

export function doneForYouNote(mode: DoneForYouMode, why: string | null): string {
  const line =
    mode === "visual"
      ? "make the finished post images and caption"
      : "check it with your read tools and write what you found and what to do next";
  const tail = why && why.trim() ? ` Why this card matters: ${why.trim().slice(0, 600)}` : "";
  return `Carry out this card yourself: ${line}.${tail}`;
}

export type DoneForYouState = "available" | "running" | "done" | "used_up" | "unavailable";

export type DfyAttemptRow = {
  id: string;
  cron_dedupe_key: string | null;
  trigger?: string | null;
  enqueued_by?: string | null;
  status: string;
  enqueued_at: string | null;
  payload: unknown;
  parsed: unknown;
  output_text?: string | null;
};

export type DfyOutcome = "running" | "executed" | "cannot_do" | "failed";

export type DfyAttempt = {
  run_id: string;
  attempt: number;
  action_id: string | null;
  channel_slug: string | null;
  mode: DoneForYouMode | null;
  by_user_id: string | null;
  status: string;
  outcome: DfyOutcome;
  stale: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function firstStep(parsed: unknown): Record<string, unknown> | null {
  const steps = obj(parsed).steps;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const s = obj(steps[0]);
  return Object.keys(s).length > 0 ? s : null;
}

export function cannotDoOf(parsed: unknown): string | null {
  const step = firstStep(parsed);
  const title = step && typeof step.title === "string" ? step.title.trim() : "";
  const md = obj(parsed).rendered_markdown;
  const firstLine = typeof md === "string" ? (md.trim().split("\n")[0] ?? "").replace(/^[#>*\s]+/, "").trim() : "";
  for (const line of [title, firstLine]) {
    if (line.toLowerCase().startsWith(CANNOT_DO_PREFIX.toLowerCase())) {
      return line.slice(CANNOT_DO_PREFIX.length).replace(/\*+/g, "").trim().slice(0, 300);
    }
  }
  return null;
}

const MIN_RESULT_CHARS = 40;

export function classifyAttempt(tenant_id: string, r: DfyAttemptRow, now: number): DfyAttempt | null {
  const attempt = doneForYouAttemptOf(tenant_id, r.cron_dedupe_key);
  if (attempt === null) return null;
  if (r.trigger !== undefined && r.trigger !== "channel_recipe") return null;
  if (r.enqueued_by !== undefined && r.enqueued_by !== null) return null;
  const dfy = obj(obj(r.payload).done_for_you);
  const action_id = typeof dfy.action_id === "string" && UUID_RE.test(dfy.action_id) ? dfy.action_id : null;
  const by = typeof dfy.by_user_id === "string" && UUID_RE.test(dfy.by_user_id) ? dfy.by_user_id : null;
  const mode: DoneForYouMode | null = dfy.mode === "research" || dfy.mode === "visual" ? dfy.mode : null;
  const channel_slug = typeof obj(r.payload).channel_slug === "string" ? (obj(r.payload).channel_slug as string) : null;
  const base = { run_id: r.id, attempt, action_id, channel_slug, mode, by_user_id: by, status: r.status, stale: false };
  if (r.status === "queued" || r.status === "running") {
    const t = r.enqueued_at ? Date.parse(r.enqueued_at) : NaN;
    const stale = !Number.isFinite(t) || now - t >= DONE_FOR_YOU_STALE_MS;
    return { ...base, outcome: stale ? "failed" : "running", stale };
  }
  if (r.status !== "success") return { ...base, outcome: "failed" };
  if (cannotDoOf(r.parsed) !== null) return { ...base, outcome: "cannot_do" };
  const md = obj(r.parsed).rendered_markdown;
  const hasText = typeof md === "string" && md.trim().length >= MIN_RESULT_CHARS;
  if (!firstStep(r.parsed) && !hasText) return { ...base, outcome: "failed" };
  return { ...base, outcome: "executed" };
}

export type DfyGates = {
  enabled: boolean | null;
  tier: Tier | null;
};

export type DfyStateSummary = {
  state: DoneForYouState;
  attempts: DfyAttempt[];
  current: DfyAttempt | null;
  winner: DfyAttempt | null;
  priorCantDo: Set<string>;
  nextAttempt: number | null;
};

export function doneForYouState(
  attemptsIn: readonly DfyAttempt[],
  gates: DfyGates,
  highestKeyHeld: number = 0,
): DfyStateSummary {
  const attempts = [...attemptsIn].sort((a, b) => a.attempt - b.attempt);
  const latest = attempts[attempts.length - 1] ?? null;
  const winner = attempts.find((a) => a.outcome === "executed") ?? null;
  const priorCantDo = new Set(attempts.filter((a) => a.outcome === "cannot_do" && a.action_id).map((a) => a.action_id as string));
  const used = Math.max(latest ? latest.attempt : 0, highestKeyHeld);
  const base = { attempts, winner, priorCantDo };
  if (latest && latest.outcome === "running") return { ...base, state: "running", current: latest, nextAttempt: null };
  if (winner) return { ...base, state: "done", current: winner, nextAttempt: null };
  if (gates.enabled !== true || gates.tier !== "free") return { ...base, state: "unavailable", current: latest, nextAttempt: null };
  if (used >= DONE_FOR_YOU_MAX_ATTEMPTS) return { ...base, state: "used_up", current: latest, nextAttempt: null };
  return { ...base, state: "available", current: latest, nextAttempt: used + 1 };
}

export function doneForYouResult(r: Pick<DfyAttemptRow, "parsed" | "output_text">): { markdown: string; caption: string | null } | null {
  const step = firstStep(r.parsed);
  const env = obj(r.parsed);
  const md =
    (typeof env.rendered_markdown === "string" && env.rendered_markdown.trim()) ||
    (step && typeof step.body === "string" && step.body.trim()) ||
    (typeof r.output_text === "string" && r.output_text.trim()) ||
    "";
  if (!md) return null;
  const content = step ? obj(step.deliverable).content : null;
  return { markdown: md.slice(0, 20_000), caption: typeof content === "string" && content.trim() ? content.trim().slice(0, 4000) : null };
}

export function doneForYouKeys(tenant_id: string): string[] {
  return Array.from({ length: DONE_FOR_YOU_MAX_ATTEMPTS }, (_, i) => doneForYouKey(tenant_id, i + 1));
}

export function summarizeDoneForYou(tenant_id: string, rows: readonly DfyAttemptRow[], gates: DfyGates, now: number): DfyStateSummary {
  const attempts = rows.map((r) => classifyAttempt(tenant_id, r, now)).filter((a): a is DfyAttempt => a !== null);
  const held = Math.max(0, ...rows.map((r) => doneForYouAttemptOf(tenant_id, r.cron_dedupe_key) ?? 0));
  return doneForYouState(attempts, gates, held);
}
