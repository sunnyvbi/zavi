
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { alert } from "@/services/logging/alert";
import { refreshShopifyBearerTokens } from "./shopify-token-refresh";

const MIN_RUNS = 3;
const MIN_TENANTS = 2;
const WINDOW_HOURS = 24;
const COOLDOWN_HOURS = 24;

export function selfHealNotifyEnabled(): boolean {
  return process.env.SELF_HEAL_NOTIFY_ENABLED === "1";
}

type EligibleRow = {
  signature: string;
  code_class: string;
  agent_slug: string;
  run_count: number;
  tenant_count: number;
};

export type SelfHealScanResult = {
  enabled: boolean;
  scanned: number;
  notified: number;
};

export async function runSelfHealScan(): Promise<SelfHealScanResult> {
  if (!selfHealNotifyEnabled()) {
    return { enabled: false, scanned: 0, notified: 0 };
  }
  const svc = serviceClient();
  const { data, error } = await svc.rpc("eligible_self_heal_signatures", {
    p_min_runs: MIN_RUNS,
    p_min_tenants: MIN_TENANTS,
    p_window_hours: WINDOW_HOURS,
  });
  if (error) {
    throw new Error(`self-heal-scan: eligible_self_heal_signatures failed: ${error.message}`);
  }
  const eligible = (data ?? []) as EligibleRow[];
  let notified = 0;
  for (const sig of eligible) {
    const { data: claim, error: claimErr } = await svc.rpc("claim_self_heal_notify", {
      p_signature: sig.signature,
      p_cooldown_hours: COOLDOWN_HOURS,
    });
    if (claimErr) {
      console.warn(
        `[self-heal-scan] claim error for sig=${sig.signature.slice(0, 8)}: ${claimErr.message}`,
      );
      continue;
    }
    const claimed = Array.isArray(claim) && claim.length > 0;
    if (!claimed) continue;
    await alert({
      source: "self-heal-scan",
      code: "platform_bug_recurred",
      msg:
        `platform bug recurred: sig=${sig.signature.slice(0, 8)} ` +
        `agent=${sig.agent_slug} class=${sig.code_class} ` +
        `runs=${sig.run_count} tenants=${sig.tenant_count} in ${WINDOW_HOURS}h. ` +
        `Recurring across tenants — likely a platform bug to fix in praxis.`,
    });
    notified += 1;
  }
  return { enabled: true, scanned: eligible.length, notified };
}

export const selfHealScanFn = inngest.createFunction(
  { id: "self-heal-scan", concurrency: 1 },
  { cron: "*/30 * * * *" },
  async ({ logger }) => {
    const [selfHeal, shopifyTokens] = await Promise.allSettled([
      runSelfHealScan(),
      refreshShopifyBearerTokens(new Date(), logger),
    ]);
    if (shopifyTokens.status === "rejected") {
      logger.warn(`shopify-token-refresh: sweep failed (${(shopifyTokens.reason as Error)?.message ?? "unknown"})`);
    }
    if (selfHeal.status === "rejected") throw selfHeal.reason;
    return {
      self_heal: selfHeal.value,
      shopify_tokens: shopifyTokens.status === "fulfilled" ? shopifyTokens.value : { error: "sweep_failed" },
    };
  },
);
