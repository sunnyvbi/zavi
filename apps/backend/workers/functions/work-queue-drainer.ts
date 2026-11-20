
import { inngest } from "../client";
import { enqueueAgentRun, InsufficientCreditsError } from "@/services/agents/runner";
import { asPlanUpgradeRequired, isCustomAgentSlug } from "@/services/billing/tiers";
import { customTriggerIdFromPayload } from "@/services/agents/custom-agent-payload";
import {
  claimWorkItems,
  completeWorkItem,
  releaseWorkItemToPending,
  isBackgroundSource,
  sourceToTrigger,
  relaneStaleLocalItems,
} from "@/services/agents/work-queue";
import type { WorkItemSource } from "@/services/agents/work-queue";
import { isFleetHalted, FleetHaltedError } from "@/services/agents/fleet-halt";
import { whatsappOwnsNumber } from "@/services/connectors/whatsapp/adapter";
import { imessageOwnsLine } from "@/services/connectors/imessage/sendblue";
import { telegramEnabled } from "@/services/connectors/telegram/adapter";
import { discordEnabled } from "@/services/connectors/discord/adapter";
import { callMcpTool } from "@/services/mcp/execute";
import { logEvent } from "@/services/logging/logEvent";
import { serviceClient } from "@/services/supabase";
import { shouldDrainSharedQueue } from "@/services/agents/boot-role";

const DRAIN_LIMIT = 25;
const LEASE_SECONDS = 300;

type ClaimedItem = { source: WorkItemSource; payload: Record<string, unknown> | null };
const SURFACE_CAN_REPLY: Partial<Record<WorkItemSource, (item: ClaimedItem) => boolean>> = {
  webhook_whatsapp: (item) => {
    const wa = (item.payload?.whatsapp ?? null) as { phone_number_id?: unknown } | null;
    return whatsappOwnsNumber(String(wa?.phone_number_id ?? ""));
  },
  webhook_imessage: (item) => {
    const im = (item.payload?.imessage ?? null) as { line?: unknown } | null;
    return imessageOwnsLine(String(im?.line ?? ""));
  },
  webhook_telegram: () => telegramEnabled(),
  webhook_discord: () => discordEnabled(),
  cron: (item) => {
    const deliver = (item.payload?.reminder ?? null) as {
      deliver?: { kind?: unknown; phone_number_id?: unknown; line?: unknown };
    } | null;
    const t = deliver?.deliver;
    if (t?.kind === "whatsapp") return whatsappOwnsNumber(String(t.phone_number_id ?? ""));
    if (t?.kind === "imessage") return imessageOwnsLine(String(t.line ?? ""));
    return true;
  },
};
const SURFACE_OFF_RELEASE_SECONDS = 5;
const SURFACE_OFF_MAX_ATTEMPTS = 20;

const SLACK_RECOVERY_TEXT_CREDITS =
  "I couldn't pick that up — this workspace is out of run credits. Top up and send it again and I'll get right on it.";
const SLACK_RECOVERY_TEXT_GENERIC =
  "I couldn't pick that up just now. Mind sending it again?";

async function recoverPreClaimedSlackReply(
  item: { tenant_id: string; source: string; payload: unknown },
  reason: "insufficient_credits" | "terminal_error" | "plan_upgrade_required",
  logger: DrainerLogger,
  planMessage?: string,
): Promise<void> {
  try {
    if (item.source !== "webhook_slack") return;
    const slack = (item.payload as { slack?: Record<string, unknown> } | null)?.slack;
    if (!slack) return;
    const channel_id = typeof slack.channel_id === "string" ? slack.channel_id : "";
    const event_id = typeof slack.event_id === "string" ? slack.event_id : "";
    const thread_ts = typeof slack.thread_ts === "string" ? slack.thread_ts : undefined;
    const team_id = typeof slack.team_id === "string" ? slack.team_id : undefined;
    if (!channel_id || !event_id) return;

    const { data: claimed } = await serviceClient()
      .from("slack_triage_claims")
      .update({ replied_at: new Date().toISOString(), answer_kind: "final" })
      .eq("tenant_id", item.tenant_id)
      .eq("event_id", event_id)
      .is("replied_at", null)
      .select("event_id");
    if (!claimed || claimed.length === 0) return;

    const result = await callMcpTool(
      { tenant_id: item.tenant_id, run_id: "", slack_target_team_id: team_id },
      "slack",
      "post_message",
      {
        channel_id,
        text:
          reason === "insufficient_credits"
            ? SLACK_RECOVERY_TEXT_CREDITS
            : reason === "plan_upgrade_required" && planMessage
              ? `I couldn't pick that up. ${planMessage} You can upgrade on the Billing page.`
              : SLACK_RECOVERY_TEXT_GENERIC,
        thread_ts,
      },
    );
    await logEvent({
      level: "warn",
      source: "slack.reply",
      code: "preclaim_recovered",
      tenant_id: item.tenant_id,
      meta: { event_id, reason, posted: !result.is_error },
    });
  } catch (e) {
    logger.error(
      `work-queue-drainer: slack pre-claim recovery failed for ${item.tenant_id}: ${(e as Error).message}`,
    );
  }
}

export type DrainerLogger = {
  warn: (s: string) => void;
  info: (s: string) => void;
  error: (s: string) => void;
};

export async function runWorkQueueDrainerHandler(
  logger: DrainerLogger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  claimed: number;
  dispatched: number;
  failed: number;
  skipped: number;
}> {
  if (!shouldDrainSharedQueue(env)) {
    return { claimed: 0, dispatched: 0, failed: 0, skipped: 0 };
  }

  if (await isFleetHalted()) {
    logger.info("work-queue-drainer: fleet halt active — drain tick skipped");
    return { claimed: 0, dispatched: 0, failed: 0, skipped: 0 };
  }

  const relaned = await relaneStaleLocalItems();
  if (relaned > 0) {
    logger.warn(
      `work-queue-drainer: re-laned ${relaned} stale local item(s) → e2b (laptop offline fallback)`,
    );
  }

  const owner = `drainer-${process.pid}-${Date.now()}`;
  const items = await claimWorkItems(owner, DRAIN_LIMIT, LEASE_SECONDS, "e2b", null);

  let dispatched = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    if (!isBackgroundSource(item.source)) {
      await completeWorkItem(
        item.id,
        "dropped",
        null,
        `source ${item.source} is synchronous-direct, not drainable`,
      );
      skipped += 1;
      continue;
    }

    const canReply = SURFACE_CAN_REPLY[item.source];
    if (canReply && !canReply(item as ClaimedItem)) {
      if (item.attempts >= SURFACE_OFF_MAX_ATTEMPTS) {
        await completeWorkItem(item.id, "failed", null, "surface_unclaimable");
        await logEvent({
          level: "error",
          source: "work-queue-drainer",
          code: "work_item.surface_unclaimable",
          message: `${item.source} item ${item.id} released ${item.attempts}x — no host can deliver its reply; terminalized`,
          tenant_id: item.tenant_id,
        });
        logger.error(
          `work-queue-drainer: TERMINALIZED ${item.source} item ${item.id} after ${item.attempts} attempts — no host owns this thread (check WHATSAPP_PHONE_NUMBER_ID / surface creds)`,
        );
        failed += 1;
        continue;
      }
      await releaseWorkItemToPending(item.id, SURFACE_OFF_RELEASE_SECONDS);
      logger.warn(
        `work-queue-drainer: released ${item.source} item ${item.id} — this host cannot deliver its reply (surface not configured here, or configured for another number)`,
      );
      skipped += 1;
      continue;
    }

    const customTriggerId =
      item.source === "cron" && isCustomAgentSlug(item.agent_slug)
        ? customTriggerIdFromPayload(item.payload)
        : null;
    try {
      const { run_id } = await enqueueAgentRun({
        tenant_id: item.tenant_id,
        agent_slug: item.agent_slug,
        trigger: sourceToTrigger(item.source),
        payload: item.payload,
        cron_dedupe_key: item.dedupe_key ?? null,
        ...(customTriggerId ? { custom_trigger_id: customTriggerId } : {}),
      });
      await completeWorkItem(item.id, "done", run_id || null);
      dispatched += 1;
    } catch (e) {
      if (e instanceof FleetHaltedError || (e as { code?: string }).code === "fleet_halted") {
        try {
          await releaseWorkItemToPending(item.id);
        } catch (relErr) {
          logger.error(
            `work-queue-drainer: release-on-halt failed for ${item.id}: ${(relErr as Error).message}`,
          );
        }
        skipped += 1;
        continue;
      }
      const planRefusal = asPlanUpgradeRequired(e);
      if (planRefusal) {
        await completeWorkItem(item.id, "dropped", null, "plan_upgrade_required");
        skipped += 1;
        await recoverPreClaimedSlackReply(item, "plan_upgrade_required", logger, planRefusal.message);
        logger.info(
          `work-queue-drainer: ${item.tenant_id}/${item.agent_slug} needs the ${planRefusal.required_tier} plan — dropped (plan_upgrade_required)`,
        );
        continue;
      }
      if (e instanceof InsufficientCreditsError) {
        await completeWorkItem(item.id, "failed", null, "insufficient_credits");
        failed += 1;
        await recoverPreClaimedSlackReply(item, "insufficient_credits", logger);
        if (customTriggerId) {
          const { noteCustomAgentCreditSkip } = await import("@/services/agents/custom-agent-runs");
          await noteCustomAgentCreditSkip(item.tenant_id, customTriggerId);
        }
        logger.info(
          `work-queue-drainer: ${item.tenant_id}/${item.agent_slug} out of credits — marked failed (insufficient_credits)`,
        );
        continue;
      }
      await completeWorkItem(item.id, "failed", null, (e as Error).message);
      failed += 1;
      await recoverPreClaimedSlackReply(item, "terminal_error", logger);
      logger.error(
        `work-queue-drainer: enqueue failed for ${item.tenant_id}/${item.agent_slug}: ${(e as Error).message}`,
      );
    }
  }

  logger.info(
    `work-queue-drainer: claimed ${items.length}, dispatched ${dispatched}, failed ${failed}, skipped ${skipped}`,
  );
  return { claimed: items.length, dispatched, failed, skipped };
}

export const workQueueDrainerFn = inngest.createFunction(
  { id: "work-queue-drainer", concurrency: 1 },
  [{ cron: "* * * * *" }, { event: "agent.work_item.enqueued" }],
  async ({ logger }) => runWorkQueueDrainerHandler(logger),
);
