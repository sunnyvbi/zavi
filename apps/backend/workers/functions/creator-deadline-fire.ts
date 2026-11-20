
import { inngest } from "../client";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { logEvent } from "@/services/logging/logEvent";
import {
  applyCreatorOrderTransition,
  baseVars,
  fireClaimedCreatorOrderDeadline,
  fireCreatorOrderDeadline,
  realCreatorOrderDeps,
  type CreatorOrderDeps,
} from "@/services/creators/order-transitions";
import {
  claimDueOrderDeadlines,
  listDuePayoutOrders,
  loadOrderForState,
  resolveCreatorOrderTenant,
} from "@/services/creators/orders-db";
import {
  armCreatorDeadlineTimer,
  armCreatorPayoutBufferTimer,
} from "@/services/creators/arm-timers";
import { isReminderWindow, windowReminders } from "@/services/creators/deadlines";
import { resolveBusinessName } from "@/services/creators/briefs-db";
import { settleUnpaidCheckout } from "@/services/creators/checkout-expiry";
import { realCreatorNotifyPort, type CreatorNotifyPort } from "@/services/creators/ports";
import { REMINDER_AUDIENCE, type ReminderWindow } from "@/services/creators/notify";
import type { DeadlineKind } from "@/services/creators/deadline-copy";

const CLAIM_LIMIT = 50;
const MAX_SWEEP_PAGES = 20;
const PAYOUT_LIMIT = 100;

export const armCreatorDeadline = armCreatorDeadlineTimer;

export const armCreatorPayoutBuffer = armCreatorPayoutBufferTimer;

export function timerDeps(): CreatorOrderDeps {
  return { ...realCreatorOrderDeps, settleUnpaidCheckout: (row) => settleUnpaidCheckout(row) };
}

function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Number.isFinite(ta) && ta === tb;
}

export async function sendCreatorWindowReminder(
  args: {
    order_id: string;
    window: DeadlineKind;
    deadline_at: string;
    at_hours: 24 | 60;
  },
  deps: {
    resolveTenant: typeof resolveCreatorOrderTenant;
    loadOrder: typeof loadOrderForState;
    notify: CreatorNotifyPort;
  } = {
    resolveTenant: resolveCreatorOrderTenant,
    loadOrder: loadOrderForState,
    notify: realCreatorNotifyPort,
  },
): Promise<"sent" | "window_closed"> {
  const tenant_id = await deps.resolveTenant(args.order_id);
  if (!tenant_id) return "window_closed";
  const order = await deps.loadOrder(tenant_id, args.order_id);
  if (!order || order.next_deadline_kind !== args.window || !sameInstant(order.next_deadline_at, args.deadline_at)) {
    return "window_closed";
  }
  if (order.status === "checkout_pending") return "window_closed";

  const vars = {
    job_title: null,
    price_cents: order.price_cents,
    payout_cents: order.payout_amount_cents ?? order.creator_payout_cents,
    business_total_cents: order.business_total_cents,
  };

  const audience = REMINDER_AUDIENCE[args.window as ReminderWindow] ?? null;
  const recipients = [
    { kind: "creator", human_member_id: order.human_member_id } as const,
    { kind: "tenant", tenant_id: order.tenant_id } as const,
  ].filter((r) => r.kind === audience);
  if (recipients.length === 0) return "window_closed";
  for (const recipient of recipients) {
    await deps.notify.sendWindowReminder({
      window: args.window,
      at_hours: args.at_hours,
      deadline_at: args.deadline_at,
      recipient,
      order_id: order.id,
      vars,
    });
  }
  return "sent";
}

export const GRACE_NUDGE_HOURS_BEFORE_END = 24;

export async function sendCreatorGraceNudge(
  args: { order_id: string; deadline_at: string },
  deps: {
    resolveTenant: typeof resolveCreatorOrderTenant;
    loadOrder: typeof loadOrderForState;
    businessName: typeof resolveBusinessName;
    notify: CreatorNotifyPort;
  } = {
    resolveTenant: resolveCreatorOrderTenant,
    loadOrder: loadOrderForState,
    businessName: resolveBusinessName,
    notify: realCreatorNotifyPort,
  },
): Promise<"sent" | "window_closed"> {
  const tenant_id = await deps.resolveTenant(args.order_id);
  if (!tenant_id) return "window_closed";
  const order = await deps.loadOrder(tenant_id, args.order_id);
  if (
    !order ||
    order.status !== "in_progress" ||
    order.next_deadline_kind !== "no_show_grace" ||
    !sameInstant(order.next_deadline_at, args.deadline_at)
  ) {
    return "window_closed";
  }
  const business = await deps.businessName(order.tenant_id).catch(() => null);
  await deps.notify.notify({
    recipient: { kind: "creator", human_member_id: order.human_member_id },
    event: "grace_nudge",
    order_id: order.id,
    vars: {
      ...baseVars(order, business),
      deadline_kind: "no_show_grace",
      deadline_at: args.deadline_at,
    },
    dedupe_window: `grace:${new Date(args.deadline_at).getTime()}`,
  });
  return "sent";
}

export type DeadlineSweepOutcome = {
  claimed: number;
  acted: number;
  skipped: number;
  payouts_attempted: number;
  payouts_sent: number;
};

export async function runCreatorDeadlineSweep(
  logger: { info: (m: string) => void; error?: (m: string) => void },
  deps: CreatorOrderDeps = timerDeps(),
  io: {
    claimDue: typeof claimDueOrderDeadlines;
    listDuePayouts: typeof listDuePayoutOrders;
  } = { claimDue: claimDueOrderDeadlines, listDuePayouts: listDuePayoutOrders },
): Promise<DeadlineSweepOutcome> {
  const out: DeadlineSweepOutcome = {
    claimed: 0,
    acted: 0,
    skipped: 0,
    payouts_attempted: 0,
    payouts_sent: 0,
  };

  if (await isFleetHalted()) {
    logger.info("creator-deadline-sweep: fleet halt active, skipped");
    return out;
  }

  let pages = 0;
  while (pages < MAX_SWEEP_PAGES) {
    const page = await io.claimDue(CLAIM_LIMIT);
    if (page.length === 0) break;
    pages += 1;
    out.claimed += page.length;

    for (const row of page) {
      try {
        const res = await fireClaimedCreatorOrderDeadline(row, deps);
        if (res.acted) out.acted += 1;
        else out.skipped += 1;
      } catch (e) {
        out.skipped += 1;
        logger.error?.(`creator-deadline-sweep: ${row.id} failed: ${(e as Error).message}`);
        await logEvent({
          level: "warn",
          source: "creator.deadline",
          code: "sweep_action_failed",
          tenant_id: row.tenant_id,
          meta: { creator_order_id: row.id, op: row.next_deadline_kind ?? "none" },
        });
      }
    }

    if (page.length < CLAIM_LIMIT) break;
  }

  const duePayouts = await io.listDuePayouts(PAYOUT_LIMIT);
  out.payouts_attempted = duePayouts.length;
  for (const p of duePayouts) {
    try {
      const res = await applyCreatorOrderTransition(
        {
          tenant_id: p.tenant_id,
          order_id: p.id,
          trigger: "payout_buffer_elapsed",
          actor: "system",
        },
        deps,
      );
      if (res.ok && res.payout_sent === true) out.payouts_sent += 1;
    } catch (e) {
      logger.error?.(`creator-payout-sweep: ${p.id} failed: ${(e as Error).message}`);
      await logEvent({
        level: "warn",
        source: "creator.deadline",
        code: "payout_sweep_failed",
        tenant_id: p.tenant_id,
        meta: { creator_order_id: p.id },
      });
    }
  }

  if (out.claimed > 0 || out.payouts_attempted > 0) {
    logger.info(
      `creator-deadline-sweep: claimed=${out.claimed} acted=${out.acted} skipped=${out.skipped} ` +
        `payouts=${out.payouts_sent}/${out.payouts_attempted}`,
    );
  }
  return out;
}

export const creatorDeadlineWaitFn = inngest.createFunction(
  { id: "creator-deadline-wait", concurrency: 20 },
  { event: "creator/order.deadline.armed" },
  async ({ event, step, logger }) => {
    const { order_id, deadline_at, kind } = event.data as {
      order_id: string;
      deadline_at: string;
      kind: DeadlineKind;
    };

    const armedAt = await step.run("armed-at", () => Date.now());

    if (isReminderWindow(kind)) {
      for (const r of windowReminders({ kind, deadline_at })) {
        if (new Date(r.fire_at).getTime() <= armedAt) continue;
        await step.sleepUntil(`until-${r.at_hours}h`, new Date(r.fire_at));
        await step.run(`remind-${r.at_hours}h`, () =>
          sendCreatorWindowReminder({
            order_id,
            window: kind,
            deadline_at,
            at_hours: r.at_hours,
          }),
        );
      }
    }

    if (kind === "no_show_grace") {
      const nudgeAt = new Date(deadline_at).getTime() - GRACE_NUDGE_HOURS_BEFORE_END * 3_600_000;
      if (nudgeAt > armedAt) {
        await step.sleepUntil("until-grace-nudge", new Date(nudgeAt));
        await step.run("grace-nudge", () => sendCreatorGraceNudge({ order_id, deadline_at }));
      }
    }

    await step.sleepUntil("until-deadline", new Date(deadline_at));
    return step.run("fire", async () => {
      if (await isFleetHalted()) {
        logger.info(`creator-deadline-wait: fleet halt, ${order_id} deferred to sweep`);
        return { acted: false, reason: "fleet_halt" };
      }
      const res = await fireCreatorOrderDeadline(order_id, timerDeps());
      logger.info(
        `creator-deadline-wait: ${order_id} ${res.acted ? `fired ${res.trigger}` : `no-op (${res.reason})`}`,
      );
      return res.acted ? { acted: true, trigger: res.trigger } : { acted: false, reason: res.reason };
    });
  },
);

export const creatorPayoutBufferWaitFn = inngest.createFunction(
  { id: "creator-payout-buffer-wait", concurrency: 20 },
  { event: "creator/order.payout.armed" },
  async ({ event, step, logger }) => {
    const { order_id, payout_ready_at } = event.data as {
      order_id: string;
      payout_ready_at: string;
    };
    await step.sleepUntil("until-buffer-end", new Date(payout_ready_at));
    return step.run("pay", async () => {
      if (await isFleetHalted()) {
        logger.info(`creator-payout-wait: fleet halt, ${order_id} deferred to sweep`);
        return { paid: false, reason: "fleet_halt" };
      }
      const tenant_id = await resolveCreatorOrderTenant(order_id);
      if (!tenant_id) return { paid: false, reason: "order_gone" };
      const res = await applyCreatorOrderTransition(
        { tenant_id, order_id, trigger: "payout_buffer_elapsed", actor: "system" },
        timerDeps(),
      );
      logger.info(
        `creator-payout-wait: ${order_id} ${res.ok ? (res.payout_waiting ? "waiting on Stripe setup" : res.payout_sent === true ? "released" : "not sent") : `no-op (${res.code})`}`,
      );
      return res.ok ? { paid: res.payout_sent === true } : { paid: false, reason: res.code };
    });
  },
);

export const creatorDeadlineSweepFn = inngest.createFunction(
  { id: "creator-deadline-sweep", concurrency: 1 },
  { cron: "40 * * * *" },
  async ({ logger }) => runCreatorDeadlineSweep(logger),
);
