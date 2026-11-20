import { inngest } from "../client";
import { fleetSweepClient } from "@/services/tenant-client";
import { getCampaignBinding } from "@/services/ads-wallet/bindings";
import {
  isLinkedinPauseChecking,
  reconcileLinkedinOperation,
  pauseLinkedinBoundCampaign,
  recheckGoneLinkedinCampaign,
  expireLinkedinGoneRecheck,
} from "@/services/ads-wallet/adapters/linkedin";
import {
  alertFounderSafely,
  goneRecheckGaveUpBlocker,
  stuckLinkedinOperationBlocker,
  type Blocker,
} from "@/services/growth/cgo-blockers";
import { STUCK_AFTER_MS } from "@/services/growth/stuck-ad-changes";
import { logEvent } from "@/services/logging/logEvent";

async function unlessChecking(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (e) {
    if (!isLinkedinPauseChecking(e)) throw e;
  }
}

export const adsCampaignOperationsFn = inngest.createFunction(
  { id: "ads-campaign-operations", concurrency: { limit: 1 }, retries: 2 },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const operations = await step.run("read-unresolved", async () => {
      const rows: Array<{
        id: string;
        tenant_id: string;
        campaign_binding_id: string;
        created_at: string;
      }> = [];
      for (let offset = 0; offset < 50_000; offset += 500) {
        const r = await fleetSweepClient(
          "ads campaign operation recovery across tenants",
        )
          .from("ads_campaign_operations")
          .select("id,tenant_id,campaign_binding_id,created_at")
          .in("status", ["pending", "uncertain"])
          .eq("kind", "activate")
          .lt("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
          .order("id")
          .range(offset, offset + 499);
        if (r.error || !Array.isArray(r.data))
          throw new Error("Campaign operation inventory is unavailable");
        rows.push(...r.data);
        if (r.data.length < 500) return rows;
      }
      throw new Error("Campaign operation inventory is incomplete");
    });
    const failed: string[] = [];
    const cutoff = Date.now() - STUCK_AFTER_MS;
    type Stuck = { bindingId: string; id: string; since: string };
    const stuck = new Map<string, { stop: Stuck[]; launch: Stuck[] }>();
    const noteStuck = (
      tenantId: string,
      op: "stop" | "launch",
      c: { bindingId: string; id: string; since: string | null | undefined },
    ) => {
      const at = c.since ? Date.parse(c.since) : NaN;
      if (!c.since || !Number.isFinite(at) || at > cutoff) return;
      const t = stuck.get(tenantId) ?? { stop: [], launch: [] };
      t[op].push({ bindingId: c.bindingId, id: c.id, since: c.since });
      stuck.set(tenantId, t);
    };
    const stops = await step.run("read-pending-stops", async () => {
      const rows: Array<{
        tenant_id: string;
        campaign_binding_id: string;
        stop_requested_at: string | null;
      }> = [];
      for (let offset = 0; offset < 50000; offset += 500) {
        const r = await fleetSweepClient(
          "retry requested LinkedIn stops, including consent withdrawal",
        )
          .from("ads_campaign_pending_stops")
          .select("tenant_id,campaign_binding_id,stop_requested_at")
          .order("campaign_binding_id")
          .range(offset, offset + 499);
        if (r.error || !Array.isArray(r.data))
          throw new Error("Pending stops are unavailable");
        rows.push(...r.data);
        if (r.data.length < 500) return rows;
      }
      throw new Error("Pending stops are incomplete");
    });
    for (const row of stops) {
      try {
        await step.run(`stop-${row.campaign_binding_id}`, () =>
          unlessChecking(() =>
            pauseLinkedinBoundCampaign(
              row.tenant_id,
              row.campaign_binding_id,
              false,
            ),
          ),
        );
      } catch {
        failed.push(row.campaign_binding_id);
        noteStuck(row.tenant_id, "stop", {
          bindingId: row.campaign_binding_id,
          id: row.campaign_binding_id,
          since: row.stop_requested_at,
        });
      }
    }
    for (const row of operations) {
      try {
        const recovered = await step.run(`recover-${row.id}`, async () => {
          const binding = await getCampaignBinding(
            row.tenant_id,
            row.campaign_binding_id,
          );
          if (binding.platform !== "linkedin")
            return { platform: binding.platform };
          await unlessChecking(() =>
            reconcileLinkedinOperation(row.tenant_id, binding.id),
          );
          return { platform: binding.platform };
        });
        if (recovered.platform !== "linkedin") failed.push(row.id);
      } catch {
        failed.push(row.id);
        noteStuck(row.tenant_id, "launch", {
          bindingId: row.campaign_binding_id,
          id: row.id,
          since: row.created_at,
        });
      }
    }
    const rechecks = await step.run("read-gone-rechecks", async () => {
      const now = Date.now();
      const r = await fleetSweepClient(
        "re-read provider-billed LinkedIn campaigns recorded as gone",
      )
        .from("ads_campaign_operations")
        .select("id,tenant_id,campaign_binding_id")
        .eq("kind", "finalize")
        .eq("status", "succeeded")
        .eq("payload->>recheck", "due")
        .lt("created_at", new Date(now - 72 * 3600_000).toISOString())
        .gt("created_at", new Date(now - 7 * 86400_000).toISOString())
        .order("id")
        .range(0, 499);
      if (r.error || !Array.isArray(r.data))
        throw new Error("Campaign operation inventory is unavailable");
      return r.data as Array<{ tenant_id: string; campaign_binding_id: string }>;
    });
    for (const row of rechecks) {
      try {
        await step.run(`recheck-${row.campaign_binding_id}`, () =>
          recheckGoneLinkedinCampaign(row.tenant_id, row.campaign_binding_id),
        );
      } catch {
        await logEvent({
          level: "warn",
          source: "ads-wallet",
          code: "ads_wallet.gone_recheck_failed",
          tenant_id: row.tenant_id,
          message: "Zavi could not re-read a provider-billed LinkedIn campaign recorded as gone. It tries again on the next tick for up to seven days.",
        }).catch(() => undefined);
      }
    }
    const expired = await step.run("read-expired-gone-rechecks", async () => {
      const r = await fleetSweepClient(
        "provider-billed LinkedIn campaigns whose gone re-read ran out of time",
      )
        .from("ads_campaign_operations")
        .select("id,tenant_id,campaign_binding_id,created_at")
        .eq("kind", "finalize")
        .eq("status", "succeeded")
        .eq("payload->>recheck", "due")
        .lte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString())
        .order("id")
        .range(0, 499);
      if (r.error || !Array.isArray(r.data))
        throw new Error("Campaign operation inventory is unavailable");
      return r.data as Array<{ tenant_id: string; campaign_binding_id: string; created_at: string }>;
    });
    for (const row of expired) {
      try {
        await step.run(`recheck-expired-${row.campaign_binding_id}`, async () => {
          const answered = await recheckGoneLinkedinCampaign(row.tenant_id, row.campaign_binding_id).catch(() => null);
          if (answered) return;
          const told = await alertFounderSafely(row.tenant_id, "gone LinkedIn re-read gave up", [
            goneRecheckGaveUpBlocker({ bindingId: row.campaign_binding_id, since: row.created_at }),
          ]);
          if (!told) throw new Error("The founder could not be told");
          await expireLinkedinGoneRecheck(row.tenant_id, row.campaign_binding_id);
        });
      } catch {
        await logEvent({
          level: "warn",
          source: "ads-wallet",
          code: "ads_wallet.gone_recheck_failed",
          tenant_id: row.tenant_id,
          message: "A provider-billed LinkedIn campaign recorded as gone ran out of re-reads and the founder could not be told yet. It tries again on the next tick.",
        }).catch(() => undefined);
      }
    }
    const walletFunded = stuck.size
      ? new Set(
          await step.run("read-stuck-linkedin-funding", async () => {
            const ids: string[] = [];
            for (const [tenantId, t] of stuck)
              for (const c of [...t.stop, ...t.launch]) {
                const binding = await getCampaignBinding(tenantId, c.bindingId).catch(() => null);
                if (binding?.funding_source === "wallet") ids.push(c.bindingId);
              }
            return ids;
          }),
        )
      : new Set<string>();
    const blockers = new Map<string, Blocker[]>();
    for (const [tenantId, t] of stuck) {
      const stopped = new Set(t.stop.map((c) => c.bindingId));
      const groups = [
        { op: "stop" as const, list: t.stop },
        {
          op: "launch" as const,
          list: t.launch.filter((c) => !stopped.has(c.bindingId)),
        },
      ].flatMap((g) =>
        [true, false].map((wallet) => ({
          ...g,
          wallet,
          list: g.list.filter((c) => walletFunded.has(c.bindingId) === wallet),
        })),
      );
      blockers.set(
        tenantId,
        groups
          .filter((g) => g.list.length)
          .map((g) =>
            stuckLinkedinOperationBlocker({
              op: g.op,
              ids: g.list.map((c) => c.id),
              since: g.list.map((c) => c.since).sort()[0],
              wallet: g.wallet,
            }),
          ),
      );
    }
    if (blockers.size)
      await step.run("tell-founders-stuck-linkedin", async () => {
        for (const [tenantId, list] of blockers)
          await alertFounderSafely(
            tenantId,
            "stuck LinkedIn campaign operation",
            list,
          );
      });
    if (failed.length)
      throw new Error(
        `${failed.length} campaign operations still need reconciliation`,
      );
    return { checked: operations.length };
  },
);
