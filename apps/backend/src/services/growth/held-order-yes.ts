import { adChangeHeadline } from "@zavi/shared";
import { asTenantId, tenantClient } from "@/services/tenant-client";

export type HeldAdOrderOnYes = {
  kind: "held_ad_order";
  exec_class: string;
  payload: Record<string, unknown>;
  object_id: string;
  from_usd: number;
  to_usd: number;
  cap_warned?: boolean;
};

const LIVE_BUDGET: Record<string, { channel: "meta_ads" | "google_ads"; id_key: "ad_set_id" | "campaign_id"; scope: "adset" | "campaign" }> = {
  "meta_ads.update_ad_set_budget": { channel: "meta_ads", id_key: "ad_set_id", scope: "adset" },
  "meta_ads.update_campaign_budget": { channel: "meta_ads", id_key: "campaign_id", scope: "campaign" },
  "google_ads.update_campaign_budget": { channel: "google_ads", id_key: "campaign_id", scope: "campaign" },
};

const CENT = 0.01;

export function heldOrderOnYes(exec_class: string, raw_payload: unknown): HeldAdOrderOnYes | null {
  const spec = LIVE_BUDGET[exec_class];
  if (!spec || !raw_payload || typeof raw_payload !== "object" || Array.isArray(raw_payload)) return null;
  const payload = raw_payload as Record<string, unknown>;
  const raw = payload[spec.id_key];
  const object_id = typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  const from = payload.expected_current_daily_budget_usd;
  const to = payload.daily_budget_usd;
  if (!object_id || typeof from !== "number" || typeof to !== "number" || !(from > 0) || !(to > 0)) return null;
  return { kind: "held_ad_order", exec_class, payload, object_id, from_usd: from, to_usd: to };
}

function consistent(o: HeldAdOrderOnYes): boolean {
  const again = heldOrderOnYes(o.exec_class, o.payload ?? {});
  return !!again && again.object_id === o.object_id && Math.abs(again.from_usd - o.from_usd) < CENT && Math.abs(again.to_usd - o.to_usd) < CENT;
}

export type LiveBudget = { usd: number } | { never: string } | null;

const usdOfMinor = (minor: string | null | undefined): number | null => {
  const cents = Number(minor ?? NaN);
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) / 100 : null;
};

export async function readLiveDailyBudget(tenant_id: string, exec_class: string, object_id: string): Promise<LiveBudget> {
  const spec = LIVE_BUDGET[exec_class];
  if (!spec) return { never: "not a budget change" };
  try {
    if (spec.channel === "meta_ads") {
      const { fbGet, getAdAccountCurrency } = await import("@/services/tools/meta-ads/_client");
      const { detectCbo } = await import("@/services/tools/meta-ads/write/_helpers");
      const currency = await getAdAccountCurrency(tenant_id);
      if (String(currency).toUpperCase() !== "USD") return { never: "the ad account is not in US dollars" };
      type B = { daily_budget?: string | null; lifetime_budget?: string | null };
      if (spec.scope === "campaign") {
        const c = (await fbGet(tenant_id, object_id, { fields: "daily_budget" })) as B;
        const usd = usdOfMinor(c.daily_budget);
        return usd === null ? { never: "the campaign has no daily budget" } : { usd };
      }
      const a = (await fbGet(tenant_id, object_id, { fields: "daily_budget,campaign{daily_budget,lifetime_budget}" })) as B & { campaign?: B | null };
      if (a.campaign && detectCbo(a.campaign)) return { never: "its campaign holds the budget" };
      const usd = usdOfMinor(a.daily_budget);
      return usd === null ? { never: "the ad set has no daily budget" } : { usd };
    }
    const { readGoogleAccountCurrency } = await import("@/services/tools/google-ads/write/_currency-guard");
    if (String(await readGoogleAccountCurrency(tenant_id, null)).toUpperCase() !== "USD") return { never: "the ad account is not in US dollars" };
    const { gadsGetCampaignBudget } = await import("@/services/tools/google-ads/_client");
    const live = await gadsGetCampaignBudget(tenant_id, object_id);
    const usd = Number(live.amount_micros) / 1_000_000;
    return Number.isFinite(usd) && usd > 0 ? { usd: Math.round(usd * 100) / 100 } : { never: "the campaign has no daily budget" };
  } catch {
    return null;
  }
}

export type HeldOrderYesResult =
  | { line: string; refused: null; reask: false }
  | { line: null; refused: string; reask: boolean };

export type HeldOrderYesDeps = {
  ownerId?: (tenant_id: string) => Promise<string | null>;
  loadRole?: (user_id: string, tenant_id: string) => Promise<string | null>;
  readLive?: typeof readLiveDailyBudget;
  planLocked?: (tenant_id: string, channel: string) => Promise<string | null>;
  bodyProblem?: (exec_class: string, body: Record<string, unknown>) => Promise<string | null>;
  findCard?: (tenant_id: string, question_id: string) => Promise<string | null>;
  file?: (a: { tenant_id: string; channel: "meta_ads" | "google_ads"; exec_class: string; payload: Record<string, unknown>; question_id: string; now: Date }) => Promise<{ id: string; kept: boolean }>;
  approve?: (a: { tenant_id: string; action_id: string; event_key: string; actor_user_id: string; source: "email" | null }) => Promise<{ ok: true; send: { id: string } | null } | { ok: false; code: string }>;
  send?: (event: { id: string; name: "channel-action.approved"; data: { action_id: string } }) => Promise<unknown>;
  capWarning?: (tenant_id: string, payload: unknown) => Promise<string | null>;
};

const OWNER_NEEDED = "an owner or admin needs to approve this";
const dollars = (n: number) => `$${n.toFixed(2)}`;

async function findCardFor(tenant_id: string, question_id: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("channel_actions")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("body->>source_question_id", question_id)
    .order("proposed_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`held-order-yes: card read failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
}

async function fileCard(a: { tenant_id: string; channel: "meta_ads" | "google_ads"; exec_class: string; payload: Record<string, unknown>; question_id: string; now: Date }): Promise<{ id: string; kept: boolean }> {
  const orders = await import("./cgo-ad-orders");
  const run_id = await orders.ensureCgoOrderRun(a.tenant_id, a.channel, a.now);
  const { title, card } = await orders.orderCard({
    tenant_id: a.tenant_id,
    channel_slug: a.channel,
    exec_class: a.exec_class,
    body: a.payload,
    reason: "You said yes to this change when I asked.",
    idempotency_key: `held_yes:${a.question_id}`,
  });
  const { [orders.CGO_ORDER_KEY]: _k, [orders.CGO_ORDER_ORIGIN]: _o, ...body } = card;
  const { recordChannelExecAction } = await import("@/services/channels/exec-actions");
  const r = await recordChannelExecAction(
    {
      tenantId: a.tenant_id,
      runId: run_id,
      channelSlug: a.channel,
      execClass: a.exec_class,
      execPayload: a.payload,
      actionType: orders.orderActionType(a.exec_class, a.payload),
      title,
      body: { ...body, source_question_id: a.question_id },
    },
    undefined,
    { enabled: () => false, cgoDoor: false },
  );
  return { id: r.id, kept: r.kept === true };
}

async function approveAsPerson(a: { tenant_id: string; action_id: string; event_key: string; actor_user_id: string; source: "email" | null }) {
  const { approveChannelAction } = await import("@/services/channels/exec-actions");
  const r = await approveChannelAction(a.tenant_id, { actionId: a.action_id, eventKey: a.event_key, actorUserId: a.actor_user_id, source: a.source });
  if (!r.ok) return { ok: false as const, code: r.code };
  const send = !r.alreadyQueued || r.stillQueued ? { id: `approve:${a.action_id}:${r.attempt}` } : null;
  return { ok: true as const, send };
}

export async function applyHeldOrderYes(
  args: {
    tenant_id: string;
    question: { id: string; on_yes: HeldAdOrderOnYes };
    approver_user_id: string | null;
    via: "email" | "slack" | "web";
    now: Date;
  },
  deps: HeldOrderYesDeps = {},
): Promise<HeldOrderYesResult> {
  const { tenant_id } = args;
  const o = args.question.on_yes;
  try {
    if (!consistent(o)) return { line: null, refused: "the change I asked about could not be read", reask: true };
    const spec = LIVE_BUDGET[o.exec_class]!;

    let approver = args.approver_user_id;
    if (!approver && args.via === "email") approver = await (deps.ownerId ?? (async (t) => (await import("./cgo-auto-run")).tenantOwnerId(t)))(tenant_id);
    if (!approver) return { line: null, refused: "I could not check who approved it", reask: true };
    let role: string | null;
    try {
      role = await (deps.loadRole ?? (async (u, t) => (await import("@/services/auth/tenant-role")).loadTenantRoleFor(u, t)))(approver, tenant_id);
    } catch {
      return { line: null, refused: "I could not check who approved it", reask: true };
    }
    if (role !== "owner" && role !== "admin") return { line: null, refused: OWNER_NEEDED, reask: false };

    const headline = adChangeHeadline(o.exec_class, o.payload) ?? `${o.exec_class} on ${o.object_id}`;
    const source = args.via === "email" ? ("email" as const) : null;
    const approve = deps.approve ?? approveAsPerson;
    const send = deps.send ?? (async (e) => (await import("@/../workers/client")).inngest.send(e));
    const approveAndSend = async (action_id: string): Promise<HeldOrderYesResult> => {
      const r = await approve({ tenant_id, action_id, event_key: `held_yes:${args.question.id}`, actor_user_id: approver!, source });
      if (!r.ok) {
        return r.code === "already_executed"
          ? { line: `Already done: ${headline}.`, refused: null, reask: false }
          : { line: null, refused: `the change could not be approved (${r.code})`, reask: true };
      }
      if (r.send) {
        try {
          await send({ id: r.send.id, name: "channel-action.approved", data: { action_id } });
        } catch (e) {
          console.warn(`[held-order-yes] approved ${action_id}, the event was not sent: ${(e as Error).message}`);
          return { line: null, refused: "it is approved but has not started yet; reply yes again or tap Approve on its card to start it", reask: false };
        }
      }
      return { line: `Approved: ${headline}.`, refused: null, reask: false };
    };

    const prior = await (deps.findCard ?? findCardFor)(tenant_id, args.question.id);
    const live = await (deps.readLive ?? readLiveDailyBudget)(tenant_id, o.exec_class, o.object_id);
    if (prior && live && "usd" in live && Math.round(live.usd * 100) === Math.round(o.to_usd * 100)) {
      return { line: `Already done: ${headline}.`, refused: null, reask: false };
    }
    if (live === null) return { line: null, refused: "I could not read the budget live from the ad account", reask: true };
    if ("never" in live) return { line: null, refused: `I can't check this budget from here (${live.never}); change it in the ad account`, reask: false };
    if (Math.round(live.usd * 100) !== Math.round(o.from_usd * 100)) {
      return { line: null, refused: `the budget is ${dollars(live.usd)} a day now, not the ${dollars(o.from_usd)} I asked about`, reask: true };
    }

    const warning =
      o.cap_warned !== true && o.to_usd > o.from_usd
        ? await (deps.capWarning ?? (async (t, p) => (await import("./unattended-policy")).heldRaiseCapWarning(t, p)))(tenant_id, o.payload)
        : null;
    const capRefusal = warning ? `${warning.trim().replace(/[.\s]+$/, "")}. Approve it on its card to raise it anyway` : null;

    if (prior) return capRefusal ? { line: null, refused: capRefusal, reask: false } : await approveAndSend(prior);

    const locked = await (deps.planLocked ?? (async (t, c) => (await (await import("./preview-plan")).refuseIfChannelPlanLocked(t, c))?.message ?? null))(tenant_id, spec.channel);
    if (locked) return { line: null, refused: locked, reask: false };
    const problem = await (deps.bodyProblem ?? (async (c, b) => (await import("./cgo-order-validate")).orderBodyProblem(c, b)))(o.exec_class, o.payload);
    if (problem) return { line: null, refused: `the change is no longer valid (${problem.slice(0, 120)})`, reask: true };

    const filed = await (deps.file ?? fileCard)({ tenant_id, channel: spec.channel, exec_class: o.exec_class, payload: o.payload, question_id: args.question.id, now: args.now });
    if (filed.kept) return { line: null, refused: "a card you already have for it is waiting: approve or change it there", reask: false };
    if (capRefusal) return { line: null, refused: capRefusal, reask: false };
    return await approveAndSend(filed.id);
  } catch (e) {
    console.warn(`[held-order-yes] ${tenant_id} question ${args.question.id}: ${(e as Error).message}`);
    return { line: null, refused: "something went wrong applying it", reask: true };
  }
}
