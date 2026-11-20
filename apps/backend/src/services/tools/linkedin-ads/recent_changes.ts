import { z } from "zod";
import { listLinkedInCampaigns, readLinkedInCreatives, readLinkedInCreativesWithToken, type LinkedInAdCampaign, type LinkedInCampaignGroup, type LinkedInCreative } from "@/services/connectors/linkedin-ads/client";
import { changeDaily, readOutsideChanges, type AdChangeRow } from "@/services/decisions/ad-changes";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";
import { linkedinCampaignGroups } from "./_groups";
import { linkedinAccountAccess } from "./_wallet";
import { walletCampaigns } from "./list_campaigns";

const CAMPAIGN_LIST_LIMIT = 500;
const LEDGER_LIMIT = 200;

export type LinkedInEditLevel = "campaign_group" | "campaign" | "ad";
export type LinkedInEditedThatDay = "yes" | "no" | "unknown";

export type LinkedInEditRow = {
  level: LinkedInEditLevel;
  id: string;
  name: string;
  campaign_id: string | null;
  campaign_group_id: string | null;
  status: string | null;
  last_modified_at: string | null;
  edited_that_day: LinkedInEditedThatDay;
};

export type LinkedInLedgerChange = {
  level: string | null;
  object_id: string;
  object_name: string | null;
  campaign_id: string | null;
  change_kind: AdChangeRow["change_kind"];
  before_status: string | null;
  after_status: string | null;
  before_daily_usd: number | null;
  after_daily_usd: number | null;
  occurred_at: string;
  on_day: boolean;
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const todayUtc = (now: Date) => ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
const dayOf = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

export function editedThatDay(last_modified_at: string | null, day: string): LinkedInEditedThatDay {
  const stamp = dayOf(last_modified_at);
  if (stamp === null || stamp > day) return "unknown";
  return stamp === day ? "yes" : "no";
}

export function linkedinEditWindow(day: string, lookback_days: number): { since: string; until: string } {
  const end = Date.parse(`${day}T00:00:00Z`);
  return { since: ymd(new Date(end - (lookback_days - 1) * 86_400_000)), until: day };
}

export const LINKEDIN_RECENT_CHANGES_METHOD =
  "LinkedIn keeps no activity log and no field-level history; each campaign group, campaign and ad carries only the time of its LATEST edit. So edited_that_day is yes when that latest edit falls on the day (UTC), no when the latest edit is earlier, and unknown when it is later than the day or missing: a later edit hides whether the day had one. LinkedIn's own system changes (review, completion) may also move the stamp, so yes means the object changed that day, not that a person changed it. ledger_changes are the status and budget changes Zavi's hourly reconcile noticed outside Zavi, with before and after; Zavi's own applied changes are in growth__read_action_outcomes. Nobody's name is read or returned.";

const inputSchema = z
  .object({
    account_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[1-9]\d*$/, "account_id must be a numeric LinkedIn ad-account id")
      .describe("LinkedIn Ads account id, from linkedin_ads_list_accounts."),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("The day (UTC, YYYY-MM-DD) the numbers moved, from linkedin_ads_daily_series. Default today."),
    lookback_days: z.number().int().min(1).max(30).default(7).describe("recent_edits lists objects whose latest edit falls in the lookback_days ending on day."),
    campaign_id: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("Only this LinkedIn campaign (ad set), its campaign group and its ads."),
  })
  .strict();

export async function fetchLinkedInRecentChanges(tenant_id: string, opts: { account_id: string; day?: string; lookback_days: number; campaign_id?: string }, now = new Date()) {
  const today = todayUtc(now);
  const day = opts.day ?? today;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed) || ymd(new Date(parsed)) !== day) throw new ExpectedToolError("linkedin_ads_bad_day", `day ${day} is not a calendar date; pass YYYY-MM-DD from linkedin_ads_daily_series.`);
  if (day > today) throw new ExpectedToolError("linkedin_ads_bad_day", `day ${day} is after today (${today}); pass a day from linkedin_ads_daily_series.`);
  const window = linkedinEditWindow(day, opts.lookback_days);
  const access = await linkedinAccountAccess(tenant_id, opts.account_id);
  const all: LinkedInAdCampaign[] = access.kind === "wallet" ? await walletCampaigns(tenant_id, access, CAMPAIGN_LIST_LIMIT) : await listLinkedInCampaigns(tenant_id, opts.account_id, CAMPAIGN_LIST_LIMIT);
  const campaigns = opts.campaign_id ? all.filter((c) => c.id === opts.campaign_id) : all;
  const groupIds = new Set(campaigns.map((c) => c.campaign_group_id).filter((g): g is string => g !== null));
  const ids = campaigns.map((c) => c.id);
  const own = new Set(ids);
  const [groups, creatives, ledger] = await Promise.all([
    linkedinCampaignGroups(tenant_id, access, opts.account_id, campaigns).then((gs: LinkedInCampaignGroup[]) => gs.filter((g) => groupIds.has(g.id))),
    ids.length ? (access.kind === "wallet" ? readLinkedInCreativesWithToken(access.token, opts.account_id, ids) : readLinkedInCreatives(tenant_id, opts.account_id, ids)) : Promise.resolve([] as LinkedInCreative[]),
    readOutsideChanges(tenant_id, `${window.since}T00:00:00.000Z`, LEDGER_LIMIT),
  ]);
  const objects: LinkedInEditRow[] = [
    ...groups.map((g) => ({ level: "campaign_group" as const, id: g.id, name: g.name, campaign_id: null, campaign_group_id: g.id, status: g.status, last_modified_at: g.last_modified_at, edited_that_day: editedThatDay(g.last_modified_at, day) })),
    ...campaigns.map((c) => ({ level: "campaign" as const, id: c.id, name: c.name, campaign_id: c.id, campaign_group_id: c.campaign_group_id, status: c.status, last_modified_at: c.last_modified_at ?? null, edited_that_day: editedThatDay(c.last_modified_at ?? null, day) })),
    ...creatives
      .filter((a): a is LinkedInCreative & { id: string } => a.id !== null && own.has(a.campaign_id))
      .map((a) => ({
        level: "ad" as const,
        id: a.id,
        name: a.name ?? a.id,
        campaign_id: a.campaign_id,
        campaign_group_id: campaigns.find((c) => c.id === a.campaign_id)?.campaign_group_id ?? null,
        status: a.intended_status,
        last_modified_at: a.last_modified_at,
        edited_that_day: editedThatDay(a.last_modified_at, day),
      })),
  ];
  const known = new Set([...groupIds, ...ids, ...objects.filter((o) => o.level === "ad").map((o) => o.id)]);
  const ledger_changes: LinkedInLedgerChange[] = ledger
    .filter((r) => r.platform === "linkedin" && (known.has(r.object_id) || (r.campaign_id !== null && own.has(r.campaign_id))) && r.occurred_at.slice(0, 10) <= day)
    .map((r) => ({
      level: r.level,
      object_id: r.object_id,
      object_name: r.object_name,
      campaign_id: r.campaign_id,
      change_kind: r.change_kind,
      before_status: r.before_status,
      after_status: r.after_status,
      before_daily_usd: changeDaily(r.before_daily_usd),
      after_daily_usd: changeDaily(r.after_daily_usd),
      occurred_at: r.occurred_at,
      on_day: r.occurred_at.slice(0, 10) === day,
    }));
  const inWindow = (iso: string | null) => {
    const d = dayOf(iso);
    return d !== null && d >= window.since && d <= window.until;
  };
  return {
    day,
    window,
    objects,
    edited_that_day: objects.filter((o) => o.edited_that_day === "yes"),
    unknown: objects.filter((o) => o.edited_that_day === "unknown"),
    recent_edits: objects.filter((o) => inWindow(o.last_modified_at)).sort((a, b) => String(b.last_modified_at).localeCompare(String(a.last_modified_at))),
    ledger_changes,
    ledger_capped: ledger.length >= LEDGER_LIMIT,
  };
}

export const linkedinAdsRecentChangesTool: ToolSpec = {
  name: "linkedin_ads_recent_changes",
  effect: "read",
  description:
    "Was the campaign group, campaign (ad set) or ad edited in the account on the day the cost changed? For one LinkedIn Ads account (or one campaign) it reads every object's latest-edit time and says edited_that_day yes / no / unknown per object, lists recent_edits in the lookback window, and adds ledger_changes: the status and budget changes Zavi's reconcile saw made outside Zavi, with before and after values. Use it before blaming the auction, the creative or the market for a number that moved: an edit on that day is a different story. LinkedIn has no activity log, so a later edit hides an earlier one (unknown), and nobody's name is returned. Read-only.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { account_id, day, lookback_days, campaign_id } = inputSchema.parse(input);
    const out = await fetchLinkedInRecentChanges(ctx.tenant_id, { account_id, day, lookback_days, campaign_id });
    return {
      account_id,
      ...(campaign_id ? { campaign_id } : {}),
      day: out.day,
      window: out.window,
      edited_that_day: out.edited_that_day,
      unknown: out.unknown,
      recent_edits: out.recent_edits,
      ledger_changes: out.ledger_changes,
      ...(out.ledger_capped ? { ledger_capped: true, ledger_note: `Only the newest ${LEDGER_LIMIT} outside changes since ${out.window.since} were read; older ones in the window may be missing. Ask for a shorter lookback_days.` } : {}),
      objects: out.objects,
      counts: { objects: out.objects.length, edited_that_day: out.edited_that_day.length, unknown: out.unknown.length, recent_edits: out.recent_edits.length, ledger_changes: out.ledger_changes.length },
      method: LINKEDIN_RECENT_CHANGES_METHOD,
    };
  },
};
