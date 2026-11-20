
import { unzipSync, strFromU8 } from "fflate";
import { getConnectorToken } from "@/services/connectors/core/token";
import type { AccountRead } from "@/services/decisions/ad-budget-reconcile";
import { DailySpend, ledgerConnected, onOffStatus, requireUsd, spendAmount, zoneDate } from "@/services/connectors/core/budget-ledger";
import { searchAccounts, type MsAccount } from "./client";
import { MICROSOFT_ADS_ACCESS_TOKEN_KEY, MICROSOFT_ADS_SLUG } from "./constants";
import { microsoftAdsPost } from "./http";

const LABEL = "Microsoft Ads";
const POLLS = 8;
const POLL_MS = 3000;

const ZONES: Record<string, string> = {
  PacificTimeUSCanadaTijuana: "America/Los_Angeles",
  MountainTimeUSCanada: "America/Denver",
  Arizona: "America/Phoenix",
  CentralTimeUSCanada: "America/Chicago",
  EasternTimeUSCanada: "America/New_York",
  IndianaEast: "America/Indiana/Indianapolis",
  Alaska: "America/Anchorage",
  Hawaii: "Pacific/Honolulu",
  AtlanticTimeCanada: "America/Halifax",
  GreenwichMeanTimeDublinEdinburghLisbonLondon: "Europe/London",
  AmsterdamBerlinBernRomeStockholmVienna: "Europe/Berlin",
  BrusselsCopenhagenMadridParis: "Europe/Paris",
  ChennaiKolkataMumbaiNewDelhi: "Asia/Kolkata",
  CanberraMelbourneSydney: "Australia/Sydney",
  OsakaSapporoTokyo: "Asia/Tokyo",
  Singapore: "Asia/Singapore",
};

type MsCampaign = { Id?: number | string; Name?: string; Status?: string; DailyBudget?: number | null; BudgetType?: string | null; BudgetId?: number | string | null };
type PollAnswer = { ReportRequestStatus?: { Status?: string; ReportDownloadUrl?: string | null } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const REPORT_HOSTS = [".api.bingads.microsoft.com", ".bingads.microsoft.com", ".blob.core.windows.net"];

export function zipUnpackedBytes(zip: Uint8Array): number | null {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.byteLength - 22; i >= Math.max(0, zip.byteLength - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.byteLength || v.getUint32(at, true) !== 0x02014b50) return null;
    const size = v.getUint32(at + 24, true);
    if (size === 0xffffffff) return null;
    total += size;
    at += 46 + v.getUint16(at + 28, true) + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return total;
}

export function isReportDownloadUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  return REPORT_HOSTS.some((suffix) => host.endsWith(suffix));
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const ymd = (s: string) => { const [Year, Month, Day] = s.split("-").map(Number); return { Year, Month, Day }; };

async function reportCsv(token: string, acct: MsAccount, since: string, until: string, deps: { sleep: (ms: number) => Promise<unknown>; fetch: typeof fetch }): Promise<string> {
  const scope = { customerId: acct.ParentCustomerId !== undefined ? String(acct.ParentCustomerId) : undefined, customerAccountId: String(acct.Id) };
  const submitted = await microsoftAdsPost<{ ReportRequestId?: string }>(token, "reporting", "GenerateReport/Submit", {
    ReportRequest: {
      Type: "CampaignPerformanceReportRequest",
      Aggregation: "Daily",
      Columns: ["TimePeriod", "CampaignId", "Spend", "CurrencyCode"],
      Scope: { AccountIds: [Number(acct.Id)] },
      Time: { CustomDateRangeStart: ymd(since), CustomDateRangeEnd: ymd(until), ...(acct.TimeZone ? { ReportTimeZone: acct.TimeZone } : {}) },
      Format: "Csv",
      FormatVersion: "2.0",
      ExcludeColumnHeaders: false,
      ExcludeReportHeader: true,
      ExcludeReportFooter: true,
      ReturnOnlyCompleteData: false,
    },
  }, scope);
  if (!submitted.ReportRequestId) throw new Error(`${LABEL} did not accept the spend report; spend is unknown.`);
  for (let i = 0; i < POLLS; i++) {
    const poll = await microsoftAdsPost<PollAnswer>(token, "reporting", "GenerateReport/Poll", { ReportRequestId: submitted.ReportRequestId }, scope);
    const status = poll.ReportRequestStatus?.Status;
    if (status === "Success") {
      const url = poll.ReportRequestStatus?.ReportDownloadUrl;
      if (!url) return "";
      if (!isReportDownloadUrl(url)) throw new Error(`${LABEL} returned a report link outside its download hosts; spend is unknown.`);
      const resp = await deps.fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) throw new Error(`${LABEL} report download HTTP ${resp.status}; spend is unknown.`);
      if (Number(resp.headers.get("content-length") ?? 0) > MAX_REPORT_BYTES) throw new Error(`${LABEL} report is too large to read; spend is unknown.`);
      const zipped = new Uint8Array(await resp.arrayBuffer());
      if (zipped.byteLength > MAX_REPORT_BYTES) throw new Error(`${LABEL} report is too large to read; spend is unknown.`);
      const unpacked = zipUnpackedBytes(zipped);
      if (unpacked === null || unpacked > MAX_REPORT_BYTES) throw new Error(`${LABEL} report is too large to read; spend is unknown.`);
      const files = unzipSync(zipped);
      const name = Object.keys(files).find((f) => f.toLowerCase().endsWith(".csv"));
      if (!name) throw new Error(`${LABEL} report had no CSV; spend is unknown.`);
      return strFromU8(files[name]).replace(/^﻿/, "");
    }
    if (status !== "Pending") throw new Error(`${LABEL} spend report ${status ?? "failed"}; spend is unknown.`);
    await deps.sleep(POLL_MS);
  }
  throw new Error(`${LABEL} spend report still running; spend is unknown this hour.`);
}

export async function readMicrosoftAccountsForBudget(
  tenantId: string,
  start: Date,
  now = new Date(),
  deps: { sleep: (ms: number) => Promise<unknown>; fetch: typeof fetch } = { sleep, fetch },
): Promise<AccountRead[]> {
  if (!(await ledgerConnected(tenantId, MICROSOFT_ADS_SLUG, LABEL))) return [];
  const token = await getConnectorToken(tenantId, MICROSOFT_ADS_SLUG, MICROSOFT_ADS_ACCESS_TOKEN_KEY);
  if (!token) throw new Error(`${LABEL} is connected but its token is missing; reconnect it.`);
  const accounts = await searchAccounts(token);
  if (accounts.length >= 100) throw new Error(`${LABEL} has more ad accounts than one read covers; spend is unknown.`);
  requireUsd(LABEL, accounts.map((a) => a.CurrencyCode));
  const reads: AccountRead[] = [];
  for (const acct of accounts) {
    const zone = ZONES[acct.TimeZone ?? ""];
    if (!zone) throw new Error(`${LABEL} account time zone ${acct.TimeZone ?? "(none)"} is not mapped; spend is unknown.`);
    const window = { since: start.toISOString().slice(0, 10), until: zoneDate(now, zone) };
    const campaigns = await microsoftAdsPost<{ Campaigns?: MsCampaign[] | null }>(token, "campaign", "Campaigns/QueryByAccountId",
      { AccountId: String(acct.Id), ReturnAdditionalFields: null },
      { customerId: acct.ParentCustomerId !== undefined ? String(acct.ParentCustomerId) : undefined, customerAccountId: String(acct.Id) });
    const spend = new DailySpend();
    if (window.since <= window.until) {
      const rows = parseCsv(await reportCsv(token, acct, window.since, window.until, deps));
      if (rows.length > 0) {
        const head = rows[0].map((h) => h.trim());
        const at = (n: string) => head.indexOf(n);
        const [iDay, iCamp, iSpend, iCur] = [at("TimePeriod"), at("CampaignId"), at("Spend"), at("CurrencyCode")];
        if (iDay < 0 || iCamp < 0 || iSpend < 0) throw new Error(`${LABEL} report is missing its columns; spend is unknown.`);
        for (const r of rows.slice(1)) {
          const day = (r[iDay] ?? "").slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${LABEL} report row has no day; spend is unknown.`);
          if (iCur >= 0 && r[iCur] && r[iCur].toUpperCase() !== "USD") throw new Error(`Shared ad budgets require USD ${LABEL} accounts.`);
          spend.add(r[iCamp], day, spendAmount(LABEL, r[iSpend]));
        }
      }
    }
    reads.push({
      platform: "microsoft",
      account_id: String(acct.Id),
      window,
      campaigns: (campaigns.Campaigns ?? []).map((c) => {
        const shared = c.BudgetId != null && Number(c.BudgetId) > 0;
        const amount = typeof c.DailyBudget === "number" && c.DailyBudget > 0 ? c.DailyBudget : null;
        return {
          object_id: String(c.Id ?? ""), level: "campaign" as const, campaign_id: String(c.Id ?? ""), name: c.Name ?? null,
          budget_kind: shared ? ("shared" as const) : amount == null ? ("none" as const) : c.BudgetType === "LifetimeBudgetStandard" ? ("lifetime" as const) : ("daily" as const),
          budget_usd: amount,
          status: onOffStatus(c.Status === "Active" ? true : c.Status === "Paused" ? false : null, c.Status),
          currency: acct.CurrencyCode ?? "UNKNOWN",
        };
      }),
      spend: spend.toRows(window.until, 3),
    });
  }
  return reads;
}
