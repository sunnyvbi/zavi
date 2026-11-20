
import { SENDGRID_GROUPS, SENDGRID_GROUP_LABEL, sendgridCampaignReady, type SendgridGroup } from "@zavi/shared";
export { SENDGRID_GROUPS, SENDGRID_GROUP_LABEL, type SendgridGroup };

export const SENDGRID_API_BASE = "https://api.sendgrid.com";
export const SENDGRID_SCOPES_PATH = "/v3/scopes";
export const SENDGRID_VERIFIED_SENDERS_PATH = "/v3/verified_senders";

export const SENDGRID_GROUP_SCOPES: Readonly<Record<SendgridGroup, readonly string[] | null>> = {
  mail_send: ["mail.send"],
  marketing_lists_read: ["marketing.read"],
  single_sends_write: ["marketing.read"],
  stats_read: ["stats.read"],
  senders_read: null,
  suppression_groups_read: ["asm.groups.read"],
};

export type SendgridGroups = Record<SendgridGroup, boolean>;

export type SendgridKeyCheck =
  | { status: "invalid" }
  | { status: "unreachable" }
  | { status: "ok"; groups: SendgridGroups; campaign_ready: boolean; missing: SendgridGroup[] };

const TIMEOUT_MS = 15_000;

export function campaignReady(groups: Partial<Record<string, boolean>>): boolean {
  return sendgridCampaignReady(groups);
}

export function groupsFromScopes(scopes: readonly string[], sendersReadable: boolean): SendgridGroups {
  const have = new Set(scopes);
  const out = {} as SendgridGroups;
  for (const g of SENDGRID_GROUPS) {
    const need = SENDGRID_GROUP_SCOPES[g];
    out[g] = need === null ? sendersReadable : need.some((s) => have.has(s));
  }
  return out;
}

export function passedGroups(groups: SendgridGroups): SendgridGroup[] {
  return SENDGRID_GROUPS.filter((g) => groups[g]);
}

export async function checkSendgridKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<SendgridKeyCheck> {
  const get = async (path: string): Promise<{ status: number; json: unknown } | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${SENDGRID_API_BASE}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: controller.signal,
        redirect: "manual",
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const scopesRes = await get(SENDGRID_SCOPES_PATH);
  if (!scopesRes) return { status: "unreachable" };
  if (scopesRes.status === 401 || scopesRes.status === 403) return { status: "invalid" };
  if (scopesRes.status < 200 || scopesRes.status >= 300) return { status: "unreachable" };
  const raw = (scopesRes.json as { scopes?: unknown } | null)?.scopes;
  if (!Array.isArray(raw)) return { status: "unreachable" };
  const scopes = raw.filter((s): s is string => typeof s === "string");

  const senders = await get(`${SENDGRID_VERIFIED_SENDERS_PATH}?limit=1`);
  if (!senders) return { status: "unreachable" };
  const sendersReadable = senders.status >= 200 && senders.status < 300;
  if (!sendersReadable && senders.status !== 401 && senders.status !== 403) return { status: "unreachable" };

  const groups = groupsFromScopes(scopes, sendersReadable);
  return {
    status: "ok",
    groups,
    campaign_ready: campaignReady(groups),
    missing: SENDGRID_GROUPS.filter((g) => !groups[g]),
  };
}
