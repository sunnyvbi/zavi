import { inngest } from "../client";
import { fleetSweepClient } from "@/services/tenant-client";
import { isFleetHalted } from "@/services/agents/fleet-halt";
import {
  isMentionAlertOptedIn,
  isMentionAlertRolloutEnabled,
  isMentionAlertRolloutPossible,
} from "@/services/alerts/mention-alert-flag";
import { sendTenantMentionAlert } from "@/services/alerts/mention-alert-send";
import { isWorkerCronStopped } from "@/services/agents/cron-stopped";

type TenantRow = { id: string; display_name: string | null };

type TenantOutcome =
  | { status: "skipped"; reason: string }
  | { status: "sent"; count: number; mentions: number };

export async function runMentionAlertForTenant(tenant: TenantRow): Promise<TenantOutcome> {
  if (await isFleetHalted()) {
    return { status: "skipped", reason: "fleet_halt" };
  }
  if (!(await isMentionAlertRolloutEnabled(tenant.id))) {
    return { status: "skipped", reason: "rollout_off" };
  }
  if (!(await isMentionAlertOptedIn(tenant.id))) {
    return { status: "skipped", reason: "tenant_opted_out" };
  }
  const out = await sendTenantMentionAlert(tenant);
  if (out.status === "sent") return { status: "sent", count: out.count, mentions: out.mentions };
  return { status: "skipped", reason: out.reason };
}

export const mentionAlertSendFn = inngest.createFunction(
  { id: "mention-alert-send", concurrency: 1 },
  { cron: "0 7,19 * * *" },
  async ({ step }) => {
    if (isWorkerCronStopped("mention-alert-send")) {
      return { halted: false, cron_stopped: true as const, sent: 0, skipped: 0 };
    }
    const halted = await step.run("check-fleet-halt", async () => isFleetHalted());
    if (halted) return { halted: true, sent: 0, skipped: 0 };

    const rolloutPossible = await step.run("check-rollout", async () =>
      isMentionAlertRolloutPossible(),
    );
    if (!rolloutPossible) return { halted: false, rollout_off: true as const, sent: 0, skipped: 0 };

    const tenants = await step.run("scan-tenants", async () => {
      const { data, error } = await fleetSweepClient("mention-alert twice-daily cross-tenant opt-in scan")
        .from("tenants")
        .select("id, display_name");
      if (error) throw new Error(`mention-alert-send: tenant scan failed: ${error.message}`);
      return (data ?? []) as TenantRow[];
    });

    let sent = 0;
    let skipped = 0;
    const skippedTenants: Array<{ tenant_id: string; reason: string }> = [];

    for (const tenant of tenants) {
      try {
        const outcome = (await step.run(`tenant-${tenant.id}`, () =>
          runMentionAlertForTenant(tenant),
        )) as TenantOutcome;
        if (outcome.status === "sent") {
          sent++;
          console.info(
            `[mention-alert] tenant=${tenant.id} sent ${outcome.mentions} mention(s) to ${outcome.count} recipient(s)`,
          );
        } else {
          skipped++;
          skippedTenants.push({ tenant_id: tenant.id, reason: outcome.reason });
        }
      } catch (e) {
        skipped++;
        skippedTenants.push({ tenant_id: tenant.id, reason: (e as Error).message });
        console.error(`[mention-alert] tenant=${tenant.id} threw: ${(e as Error).message}`);
      }
    }

    return { halted: false, tenants: tenants.length, sent, skipped, skipped_tenants: skippedTenants };
  },
);
