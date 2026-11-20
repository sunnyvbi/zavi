import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_ADS_DAILY_LIMIT } from "./constants";

const PAUSE_REFUSED_CODES = ["ads_account_read_only", "linkedin_ads_forbidden", "linkedin_ads_token_revoked", "linkedin_ads_not_connected", "linkedin_ads_write_refused"];

export const isLinkedinDailyLimit = (e: unknown): boolean => e instanceof ExpectedToolError && e.message === LINKEDIN_ADS_DAILY_LIMIT;

export const LINKEDIN_ZAVI_FAULT_CODE = "linkedin_ads_zavi_fault";

export function linkedinZaviFaultPauseCopy(e: unknown, subject: string): string | null {
  if (!(e instanceof ExpectedToolError) || e.code !== LINKEDIN_ZAVI_FAULT_CODE) return null;
  return `Zavi could not pause ${subject} because of a problem on Zavi's side, so it keeps running on LinkedIn and can keep spending. To stop it now, pause it in LinkedIn Campaign Manager. Zavi has been told about the problem, and you can try again here later.`;
}

export function linkedinPauseRefusedCopy(e: unknown, subject: string): string | null {
  const zaviFault = linkedinZaviFaultPauseCopy(e, subject);
  if (zaviFault) return zaviFault;
  if (!(e instanceof ExpectedToolError) || (!PAUSE_REFUSED_CODES.includes(e.code) && !isLinkedinDailyLimit(e))) return null;
  return `Zavi could not pause ${subject}, so it keeps running on LinkedIn and can keep spending. ${e.message}`;
}
