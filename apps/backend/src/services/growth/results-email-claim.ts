
import { claimTenantFlag, getBoolSettingStrict, setTenantSetting } from "@/services/settings";
import { logEvent } from "@/services/logging/logEvent";

export const RESULTS_EMAIL_CLAIM_KEY = "results_email_claimed" as const;
export const LEGACY_SENT_KEY = "upgrade_actions_ready_email_sent" as const;

export async function claimResultsEmail(tenant_id: string, by: string): Promise<boolean> {
  if (await getBoolSettingStrict(LEGACY_SENT_KEY, tenant_id)) return false;
  return claimTenantFlag(tenant_id, RESULTS_EMAIL_CLAIM_KEY, by);
}

export async function releaseResultsEmail(tenant_id: string, by: string): Promise<void> {
  try {
    await setTenantSetting(tenant_id, RESULTS_EMAIL_CLAIM_KEY, null, by);
  } catch (e) {
    await logEvent({ level: "warn", source: "growth.results-email-claim", code: "results_email_claim_release_failed", tenant_id, error: e });
  }
}

export async function resultsEmailTaken(tenant_id: string): Promise<boolean> {
  return (
    (await getBoolSettingStrict(LEGACY_SENT_KEY, tenant_id)) ||
    (await getBoolSettingStrict(RESULTS_EMAIL_CLAIM_KEY, tenant_id))
  );
}
