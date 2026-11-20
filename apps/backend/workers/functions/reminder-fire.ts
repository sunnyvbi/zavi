
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueWorkItem } from "@/services/agents/work-queue";
import { loadTierGateConfig, resolveTenantTier } from "@/services/agents/entitlement";
import { tierRank } from "@/services/billing/tiers";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import { logEvent } from "@/services/logging/logEvent";
import { scrubAgentEgress } from "@/services/agents/scrub-agent-egress";
import { slackFetch } from "@/services/tools/slack/_client";
import {
  deliverReminderPing,
  nextCronFire,
  normalizeCronExpression,
  reminderDeliverSchema,
} from "@/services/agents/reminders";
import {
  reminderDeliveryDeps,
  isReminderDefer,
  isReminderTransient,
  REMINDER_DEFER_PREFIX,
} from "@/services/agents/reminder-delivery-deps";
import { whatsappOwnsNumber } from "@/services/connectors/whatsapp/adapter";
import { imessageOwnsLine } from "@/services/connectors/imessage/sendblue";
import { defaultReminderEmailDeps, sendReminderEmail } from "@/services/agents/reminder-email";

const CLAIM_LIMIT = 50;
const MAX_SWEEP_PAGES = 20;

type ReminderRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  mode: "ping" | "run";
  note: string;
  schedule_kind: "once" | "recurring";
  due_at: string;
  cron_expression: string | null;
  tz: string;
  deliver: unknown;
  fired_count: number;
  created_by?: string | null;
  slack_user_id?: string | null;
  lease_until?: string | null;
};

function pingDeps() {
  return reminderDeliveryDeps({
    scrub: (text: string) => scrubAgentEgress(text, { surface: "persist" }).text,
  });
}

async function closeOut(
  row: ReminderRow,
  error: string | null,
): Promise<"rearmed" | "done" | "unsaved" | "lost"> {
  const sb = serviceClient();
  const base = {
    last_fired_at: new Date().toISOString(),
    fired_count: row.fired_count + 1,
    last_error: error,
    lease_until: null,
  };

  const fenced = async (patch: Record<string, unknown>): Promise<"ok" | "unsaved" | "lost"> => {
    const q = sb.from("agent_reminders").update(patch).eq("id", row.id);
    const { data, error: upErr } = await (row.lease_until
      ? q.eq("lease_until", row.lease_until)
      : q.is("lease_until", null)
    ).select("id");
    if (upErr) {
      console.error(`[reminder-fire] close-out update failed for ${row.id}: ${upErr.message}`);
      return "unsaved";
    }
    if (!Array.isArray(data) || data.length === 0) {
      console.warn(`[reminder-fire] lease lost before close-out for ${row.id}; another claim owns it`);
      return "lost";
    }
    return "ok";
  };

  if (row.schedule_kind === "recurring" && row.cron_expression) {
    const cron = normalizeCronExpression(row.cron_expression);
    const next = nextCronFire(cron, new Date());
    if (next) {
      const saved = await fenced({
        ...base,
        status: "pending",
        due_at: next.toISOString(),
        ...(cron !== row.cron_expression ? { cron_expression: cron } : {}),
      });
      if (saved !== "ok") return saved;
      try {
        await scheduleReminder(row.id, next.toISOString());
      } catch (e) {
        console.error(`[reminder-fire] scheduling next fire failed for ${row.id}: ${(e as Error).message}`);
      }
      return "rearmed";
    }
  }

  const saved = await fenced({ ...base, status: error ? "failed" : "fired" });
  return saved === "ok" ? "done" : saved;
}

export async function scheduleReminder(reminder_id: string, due_at: string): Promise<void> {
  await inngest.send({
    name: "reminder/scheduled",
    data: { reminder_id, due_at },
  });
}

type FireOutcome = { pinged: number; enqueued: number; failed: number; deferred: number };

const MAX_DEFER_MS = 24 * 3600 * 1000;

async function recurringRunPlanCheck(tenant_id: string): Promise<"ok" | "below_starter" | "unknown"> {
  try {
    const cfg = await loadTierGateConfig();
    if (cfg.deferred) return "unknown";
    const tier = await resolveTenantTier(tenant_id, cfg);
    return tierRank(tier) >= tierRank("starter") ? "ok" : "below_starter";
  } catch {
    return "unknown";
  }
}

async function cancelForPlan(row: ReminderRow): Promise<void> {
  const { error } = await serviceClient()
    .from("agent_reminders")
    .update({ status: "cancelled", last_error: "plan_upgrade_required", lease_until: null })
    .eq("id", row.id);
  if (error) console.error(`[reminder-fire] plan cancel failed for ${row.id}: ${error.message}`);
}

type Fired = { out: FireOutcome; email: (() => Promise<void>) | null };

async function fireOne(row: ReminderRow): Promise<Fired> {
  let deliveryError: string | null = null;
  const out: FireOutcome = { pinged: 0, enqueued: 0, failed: 0, deferred: 0 };
  let planCheck: "ok" | "below_starter" | "unknown" = "ok";

  try {
    if (row.mode === "ping") {
      deliveryError = await deliverReminderPing(
        { tenant_id: row.tenant_id, note: row.note, deliver: row.deliver },
        pingDeps(),
      );
      if (!deliveryError) out.pinged = 1;
    } else {
      const target = reminderDeliverSchema.safeParse(row.deliver);
      if (!target.success) {
        deliveryError = "reminder deliver target malformed";
      } else if (
        target.data.kind === "whatsapp" &&
        !whatsappOwnsNumber(target.data.phone_number_id)
      ) {
        deliveryError = `${REMINDER_DEFER_PREFIX}whatsapp number ${target.data.phone_number_id} is not served by this host`;
      } else if (target.data.kind === "imessage" && !imessageOwnsLine(target.data.line)) {
        deliveryError = `${REMINDER_DEFER_PREFIX}imessage line ${target.data.line} is not served by this host`;
      } else if (
        row.schedule_kind === "recurring" &&
        (planCheck = await recurringRunPlanCheck(row.tenant_id)) !== "ok"
      ) {
        if (planCheck === "below_starter") {
          await cancelForPlan(row);
          return { out, email: null };
        }
        deliveryError = "plan check unavailable; recurring run skipped";
      } else {
        await enqueueWorkItem({
          tenant_id: row.tenant_id,
          agent_slug: row.agent_slug,
          source: "cron",
          payload: {
            reminder: { prompt: row.note, deliver: target.data },
          },
          dedupe_key: `reminder:${row.id}:${row.due_at}`,
        });
        out.enqueued = 1;
      }
    }
  } catch (e) {
    deliveryError = (e as Error).message.slice(0, 500);
  }

  if (isReminderDefer(deliveryError) || isReminderTransient(deliveryError)) {
    const overdueMs = Date.now() - new Date(row.due_at).getTime();
    if (overdueMs < MAX_DEFER_MS) {
      out.deferred = 1;
      return { out, email: null };
    }
    deliveryError = `no host served this reminder within 24h (${deliveryError})`;
  }

  if (deliveryError) {
    out.failed = 1;
    await logEvent({
      level: "warn",
      source: "reminder.fire",
      code: "delivery_failed",
      tenant_id: row.tenant_id,
      meta: { mode: row.mode, kind: row.schedule_kind },
    });
  }

  const closed = await closeOut(row, deliveryError);

  if (!((closed === "done" || closed === "rearmed") && (row.mode === "ping" || out.enqueued === 1))) {
    return { out, email: null };
  }
  const email = async (): Promise<void> => {
    const mail = await sendReminderEmail({
      tenant_id: row.tenant_id,
      agent_slug: row.agent_slug,
      mode: row.mode,
      note: row.note,
      created_by: row.created_by ?? null,
      slack_user_id: row.slack_user_id ?? null,
      deliver: row.deliver,
    }, defaultReminderEmailDeps(serviceClient())).catch((e: unknown) => ({ sent: false as const, reason: `threw: ${(e as Error).message}` }));
    if (!mail.sent) {
      console.warn(`[reminder-fire] reminder email not sent for ${row.id}: ${mail.reason}`);
    }
  };
  return { out, email };
}

export async function runReminderWaitHandler(
  reminder_id: string,
  logger: { info: (m: string) => void; error?: (m: string) => void },
): Promise<FireOutcome & { claimed: number }> {
  const none = { claimed: 0, pinged: 0, enqueued: 0, failed: 0, deferred: 0 };

  if (await isFleetHalted()) {
    logger.info(`reminder-wait: fleet halt active — ${reminder_id} deferred to sweep`);
    return none;
  }

  const { data, error } = await serviceClient().rpc("claim_reminder_by_id", {
    p_reminder_id: reminder_id,
  });
  if (error) {
    logger.error?.(`reminder-wait: claim failed — ${error.message}`);
    return none;
  }

  const row = ((data ?? []) as ReminderRow[])[0];
  if (!row) return none;

  const { out, email } = await fireOne(row);
  if (email) await email();
  logger.info(`reminder-wait: fired ${reminder_id} (${row.mode})`);
  return { claimed: 1, ...out };
}

export async function runReminderFireHandler(logger: {
  info: (m: string) => void;
  error?: (m: string) => void;
}): Promise<{ claimed: number; pinged: number; enqueued: number; failed: number; deferred: number }> {
  if (await isFleetHalted()) {
    logger.info("reminder-fire: fleet halt active — skipped");
    return { claimed: 0, pinged: 0, enqueued: 0, failed: 0, deferred: 0 };
  }

  const sb = serviceClient();
  let claimed = 0;
  let pinged = 0;
  let enqueued = 0;
  let failed = 0;
  let deferred = 0;
  let pages = 0;

  while (pages < MAX_SWEEP_PAGES) {
    const { data, error } = await sb.rpc("claim_due_reminders", { p_limit: CLAIM_LIMIT });
    if (error) {
      logger.error?.(`reminder-fire: claim failed — ${error.message}`);
      break;
    }
    const page = (data ?? []) as ReminderRow[];
    if (page.length === 0) break;
    pages += 1;
    claimed += page.length;

    const emails: Array<() => Promise<void>> = [];
    for (const row of page) {
      const { out, email } = await fireOne(row);
      pinged += out.pinged;
      enqueued += out.enqueued;
      failed += out.failed;
      deferred += out.deferred;
      if (email) emails.push(email);
    }
    await Promise.allSettled(emails.map((send) => send()));

    if (page.length < CLAIM_LIMIT) break;
  }

  if (pages >= MAX_SWEEP_PAGES) {
    logger.info(
      `reminder-sweep: hit the ${MAX_SWEEP_PAGES}-page cap (${claimed} claimed) — remainder waits for the next tick`,
    );
  }

  if (claimed > 0) {
    logger.info(
      `reminder-sweep: claimed=${claimed} pages=${pages} pinged=${pinged} enqueued=${enqueued} failed=${failed} deferred=${deferred} (sleeper missed these)`,
    );
  }

  return { claimed, pinged, enqueued, failed, deferred };
}

export const reminderWaitFn = inngest.createFunction(
  { id: "reminder-wait", concurrency: 20 },
  { event: "reminder/scheduled" },
  async ({ event, step, logger }) => {
    const { reminder_id, due_at } = event.data as { reminder_id: string; due_at: string };
    await step.sleepUntil("until-due", new Date(due_at));
    return step.run("fire", () => runReminderWaitHandler(reminder_id, logger));
  },
);

export const reminderSweepFn = inngest.createFunction(
  { id: "reminder-sweep", concurrency: 1 },
  { cron: "*/15 * * * *" },
  async ({ logger }) => runReminderFireHandler(logger),
);
