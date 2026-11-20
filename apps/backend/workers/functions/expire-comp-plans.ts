
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import {
  COMP_WARNING_WINDOW_MS,
  sendCompEndingEmails,
  type EndingComp,
} from "@/services/billing/comp-ending-email";
import { loadTierGateConfig } from "@/services/agents/entitlement";

export const expireCompPlansFn = inngest.createFunction(
  { id: "expire-comp-plans" },
  { cron: "20 8 * * *" },
  async ({ step, logger }) => {
    const sb = serviceClient();

    const expired = await step.run("clear-ended-comps", async () => {
      const { data, error } = await sb
        .from("tenant_subscriptions")
        .update({ tier: null, comp_expires_at: null, updated_at: new Date().toISOString() })
        .lte("comp_expires_at", new Date().toISOString())
        .select("tenant_id");
      if (error) throw new Error(`expire_comp_plans failed: ${error.message}`);
      const ids = ((data ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
      for (const id of ids) {
        const { error: tErr } = await sb.rpc("_credit_balance_touch", { p_tenant_id: id });
        if (tErr) logger.warn(`expire_comp_plans: balance touch failed for ${id}: ${tErr.message}`);
      }
      logger.info(`expire_comp_plans: ended ${ids.length} comps`);
      return ids.length;
    });

    const emails = await step.run("email-ending-comps", async () => {
      const now = Date.now();
      const { data: ending, error: endErr } = await sb
        .from("tenant_subscriptions")
        .select("tenant_id, tier, comp_expires_at")
        .gt("comp_expires_at", new Date(now).toISOString())
        .lte("comp_expires_at", new Date(now + COMP_WARNING_WINDOW_MS).toISOString());
      if (endErr) throw new Error(`expire_comp_plans: ending-comp read failed: ${endErr.message}`);
      const cfg = await loadTierGateConfig();
      if (cfg.deferred) throw new Error("expire_comp_plans: tier config unreadable; comp-ending emails retry");
      const comps = ((ending ?? []) as EndingComp[]).filter((c) => !cfg.proTenants.includes(c.tenant_id));
      const out = await sendCompEndingEmails(comps, {
        warn: (m) => logger.warn(m),
        stillEnding: async (c) => {
          const { data: row, error } = await sb
            .from("tenant_subscriptions")
            .select("tier, comp_expires_at")
            .eq("tenant_id", c.tenant_id)
            .maybeSingle<{ tier: string | null; comp_expires_at: string | null }>();
          if (error) throw new Error(`comp re-read failed: ${error.message}`);
          return !!row && row.tier === c.tier && row.comp_expires_at === c.comp_expires_at;
        },
      });
      logger.info(`expire_comp_plans: comp-ending emails ${JSON.stringify(out)}`);
      if (out.failed > 0) throw new Error(`expire_comp_plans: ${out.failed} comp-ending email(s) failed; retrying`);
      return out;
    });

    return { expired, emails };
  },
);
