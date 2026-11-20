
import { AD_CHANGE_HEADLINE_FIELDS, adCardTitle, compareActions, getChannel, isCustomerChannelAction, isOpenAction } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { PREVIEW_RUN_KEY_PREFIX } from "@/services/billing/tiers";
import { isPlanBody } from "@/services/channels/channel-actions";
import { resultsEmailTaken } from "@/services/growth/results-email-claim";
import { loadTierGateConfig, resolveTenantTier } from "@/services/agents/entitlement";
import type { PlanFacts } from "./plan";

const HEADLINE_FIELDS = AD_CHANGE_HEADLINE_FIELDS;

export const EMAIL_CARD_COLUMNS =
  "id, channel_slug, title, status, snoozed_until, held_reason, blocking, position, score, proposed_at, action_type, " +
  "reason:body->step->>body, responsibility:body->step->>responsibility, deliverable_kind:body->step->deliverable->>kind, " +
  "exec_class, " +
  HEADLINE_FIELDS.map((f) => `hl_${f}:exec_payload->${f}`).join(", ");

const CARD_READ_CAP = 500;
const RUN_READ_CAP = 500;

export type EmailCard = {
  id: string;
  channel_slug: string;
  title: string;
  reason: string;
  blocking: boolean;
  position: number;
  score: number;
  proposed_at: string;
  status: string;
  snoozed_until: string | null;
  action_type: string | null;
  held?: boolean;
};

export type WorkspaceFacts = {
  company: string;
  cards: ReadonlyMap<string, readonly EmailCard[]>;
  plan: PlanFacts;
};

type CardRow = {
  id: string;
  channel_slug: string;
  title: string | null;
  status: string;
  snoozed_until: string | null;
  held_reason?: string | null;
  blocking: boolean | null;
  position: number | null;
  score: number | null;
  proposed_at: string;
  action_type: string | null;
  reason: string | null;
  responsibility: string | null;
  deliverable_kind: string | null;
  exec_class?: string | null;
} & { [K in `hl_${(typeof HEADLINE_FIELDS)[number]}`]?: unknown };

function headlinePayload(r: CardRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of HEADLINE_FIELDS) {
    const v = r[`hl_${f}`];
    if (v !== undefined && v !== null) out[f] = v;
  }
  return out;
}

export function openCardsByChannel(rows: readonly CardRow[], nowMs: number): Map<string, EmailCard[]> {
  const out = new Map<string, EmailCard[]>();
  for (const r of rows) {
    if (!r.id || !r.channel_slug) continue;
    const open = isOpenAction({ status: r.status, snoozed_until: r.snoozed_until }, nowMs);
    const held = !open && r.status === "snoozed" && r.held_reason === "pacing";
    if (!open && !held) continue;
    if (isPlanBody({ step: { deliverable: { kind: r.deliverable_kind } } })) continue;
    if (!isCustomerChannelAction(r.channel_slug, { step: { responsibility: r.responsibility ?? undefined } })) continue;
    const card: EmailCard = {
      id: String(r.id),
      channel_slug: String(r.channel_slug),
      title: adCardTitle({ title: typeof r.title === "string" ? r.title : "", exec_class: r.exec_class, exec_payload: headlinePayload(r) }),
      reason: typeof r.reason === "string" ? r.reason : "",
      blocking: r.blocking === true,
      position: typeof r.position === "number" ? r.position : 99,
      score: typeof r.score === "number" ? r.score : 0,
      proposed_at: String(r.proposed_at ?? ""),
      status: String(r.status),
      snoozed_until: r.snoozed_until ?? null,
      action_type: typeof r.action_type === "string" ? r.action_type : null,
      held,
    };
    if (!card.title.trim()) continue;
    const list = out.get(card.channel_slug) ?? [];
    list.push(card);
    out.set(card.channel_slug, list);
  }
  for (const list of out.values()) list.sort(compareActions);
  return out;
}

export function channelName(slug: string): string {
  return getChannel(slug)?.name ?? slug;
}

export async function upgradeEmailAlreadySent(
  tenantId: string,
  read: (tenantId: string) => Promise<boolean> = resultsEmailTaken,
): Promise<boolean> {
  try {
    return (await read(tenantId)) === true;
  } catch {
    return true;
  }
}

export async function isOnPaidTier(tenantId: string): Promise<boolean> {
  try {
    const cfg = await loadTierGateConfig();
    if (cfg.deferred) return true;
    return (await resolveTenantTier(tenantId, cfg)) !== "free";
  } catch {
    return true;
  }
}

export async function loadWorkspaceFacts(
  tenantId: string,
  startedAt: string,
  now: Date,
  deps: {
    readUpgradeEmailSent?: (tenantId: string) => Promise<boolean>;
    isPaid?: (tenantId: string) => Promise<boolean>;
  } = {},
): Promise<WorkspaceFacts> {
  const db = tenantClient(asTenantId(tenantId));
  const upgradeSent = upgradeEmailAlreadySent(tenantId, deps.readUpgradeEmailSent);

  const [tenant, cardsRes, eventsRes, runsRes, previewRes] = await Promise.all([
    db.from("tenants").select("display_name").eq("id", tenantId).maybeSingle(),
    db
      .from("channel_actions")
      .select(EMAIL_CARD_COLUMNS)
      .in("status", ["pending", "snoozed"])
      .order("proposed_at", { ascending: true })
      .limit(CARD_READ_CAP),
    db
      .from("channel_action_events")
      .select("action_id")
      .eq("actor_kind", "founder")
      .gte("at", startedAt)
      .limit(CARD_READ_CAP),
    db
      .from("agent_runs")
      .select("channel_slug")
      .is("cron_dedupe_key", null)
      .not("channel_slug", "is", null)
      .gte("enqueued_at", startedAt)
      .limit(RUN_READ_CAP),
    db
      .from("agent_runs")
      .select("agent_slug, status")
      .like("cron_dedupe_key", `${PREVIEW_RUN_KEY_PREFIX}${tenantId}:%`)
      .in("status", ["queued", "running"])
      .limit(50),
  ]);
  for (const [what, r] of [
    ["tenant", tenant],
    ["cards", cardsRes],
    ["card events", eventsRes],
    ["runs", runsRes],
    ["preview runs", previewRes],
  ] as const) {
    if (r.error) throw new Error(`onboarding emails: ${what} read failed: ${r.error.message}`);
  }

  const used = new Set<string>();
  for (const r of (runsRes.data ?? []) as Array<{ channel_slug: string | null }>) if (r.channel_slug) used.add(r.channel_slug);
  const actionIds = [...new Set(((eventsRes.data ?? []) as Array<{ action_id: string }>).map((e) => e.action_id))];
  if (actionIds.length > 0) {
    const acted = await db.from("channel_actions").select("channel_slug").in("id", actionIds.slice(0, CARD_READ_CAP));
    if (acted.error) throw new Error(`onboarding emails: acted cards read failed: ${acted.error.message}`);
    for (const r of (acted.data ?? []) as Array<{ channel_slug: string | null }>) if (r.channel_slug) used.add(r.channel_slug);
  }

  const inFlight = new Set(((previewRes.data ?? []) as Array<{ agent_slug: string }>).map((r) => r.agent_slug));
  const cards = openCardsByChannel((cardsRes.data ?? []) as unknown as CardRow[], now.getTime());
  const openCards = new Map([...cards].map(([slug, list]) => [slug, list.length]));
  const name = (tenant.data as { display_name?: string | null } | null)?.display_name;
  return {
    company: typeof name === "string" && name.trim() ? name.trim() : "your business",
    cards,
    plan: {
      openCards,
      used,
      inFlight,
      upgradeEmailSent: await upgradeSent,
      paidRerunsInFlight: inFlight.size > 0 && (await (deps.isPaid ?? isOnPaidTier)(tenantId)),
    },
  };
}
