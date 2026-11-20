
import { apifyRanAndBilled, recordApifyCall } from "@/services/vendors/usage";

const APIFY_BASE = "https://api.apify.com/v2/acts";

export const EMAIL_FINDER_ACTOR = "clearpath~email-finder-api";

const APIFY_TIMEOUT_MS = 30_000;

export type EnrichResult = {
  email: string;
  confidence: number;
  provider: "apify_clearpath";
  status: string;
  isSafeToSend: boolean;
  isCatchAll: boolean;
  isDisposable: boolean;
};

export type EnrichInvestorEmailParams = {
  firm: string;
  name: string;
  domain?: string;
};

export async function enrichInvestorEmail(
  params: EnrichInvestorEmailParams,
): Promise<EnrichResult | null> {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error("APIFY_TOKEN not set — cannot enrich investor email");
  }

  const url = `${APIFY_BASE}/${EMAIL_FINDER_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const nameParts = params.name.trim().split(/\s+/);
  const firstName = nameParts[0] ?? params.name;
  const lastName = nameParts.slice(1).join(" ") || undefined;

  const body: Record<string, unknown> = {
    firstName,
    ...(lastName ? { lastName } : {}),
    ...(params.domain ? { companyDomain: params.domain } : {}),
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), APIFY_TIMEOUT_MS);
  const startedAt = Date.now();
  let items: number | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (apifyRanAndBilled(res.status)) items = 0;
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Apify auth failed (${res.status}) — check APIFY_TOKEN`);
      }
      throw new Error(`Apify HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as unknown[];
    items = Array.isArray(json) ? json.length : 0;
    if (!Array.isArray(json) || json.length === 0) return null;
    const first = json[0] as Record<string, unknown>;
    const email = typeof first.email === "string" ? first.email.trim() : null;
    if (!email) return null;

    const status = typeof first.status === "string" ? first.status : "unknown";
    const overallScore = typeof first.overallScore === "number" ? first.overallScore : 0;
    const isSafeToSend = first.isSafeToSend === true;
    const isCatchAll = first.isCatchAll === true;
    const isDisposable = first.isDisposable === true;
    const isRoleAccount = first.isRoleAccount === true;

    return {
      email,
      confidence: overallScore / 100,
      provider: "apify_clearpath",
      status,
      isSafeToSend,
      isCatchAll,
      isDisposable: isDisposable || isRoleAccount,
    };
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      items = 0;
      throw new Error(`Apify enrichment timed out after ${APIFY_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (items !== null) recordApifyCall({ actor: EMAIL_FINDER_ACTOR, ms: Date.now() - startedAt, memoryMb: null, items, at: new Date(startedAt) });
  }
}

export function isSendableEmail(result: EnrichResult | null): result is EnrichResult {
  if (!result) return false;
  if (!result.email) return false;
  if (result.status !== "found") return false;
  if (!result.isSafeToSend) return false;
  if (result.confidence < 0.9) return false;
  if (result.isCatchAll) return false;
  if (result.isDisposable) return false;
  return true;
}
