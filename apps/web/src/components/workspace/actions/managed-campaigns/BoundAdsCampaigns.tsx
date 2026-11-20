"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Megaphone } from "lucide-react";
import { InfoIcon, PauseIcon, PlayIcon } from "../../videoStudio/libraryIcons";
import { platformFor } from "../platforms";
import { CampaignEditor } from "./CampaignEditor";
import { LaunchSheet } from "./LaunchSheet";
import { LINKEDIN_MIN_RUNWAY_MS, linkedinEndTimeProblem, linkedinLaunchSpend, linkedinMinTotalCents, linkedinMinTotalUsd, linkedinTotalBelowDailyWords, type LinkedinEndTimeProblem, type ManagedCampaign } from "@zavi/shared";
import { campaignFetch } from "./api";
import { AD_BUDGET_URL } from "@/lib/workspace/tabUrl";
import { useLiveRole } from "./liveRole";
import { sheetHint, sheetLabel } from "./AdsSheet";
import { CHANNEL_HISTORY_CHANGED_EVENT } from "../useChannelHistory";
import { AD_BUDGET_CHANGED_EVENT } from "../../growth/adBudgetEvents";
import { CHANNEL_DASHBOARD_STALE_EVENT, announceChannelDashboardStale, useCampaignStates } from "../campaignLinks";
import { linkedinCampaignPill } from "../../agent/linkedinAdsTables";
import { DatePicker, isoDay } from "../../ugc/DatePicker";
import { TimePicker } from "../../email/TimePicker";
import { useChannelPlanLock } from "../channelPlanLock";
import { LAUNCH_LOCK_ID, launchLockWords } from "./launchLock";

const createdWords = (at: string) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

type Campaign = {
  id: string;
  provider_campaign_id: string;
  funding_source: "wallet" | "provider";
  provider_account_id?: string | null;
  name?: string | null;
  created_at?: string;
  setting_up?: "retry" | "check" | "closed";
  status?: string | null;
  launch_pending?: boolean;
  pause_pending?: boolean;
  pause_only?: boolean;
};
type Review = {
  campaign_binding_id: string;
  name: string;
  account_id: string;
  funding_source: "wallet" | "provider";
  status: string;
  launch_blocker?: string | null;
  currency: string;
  fx?: { units_per_usd: number; as_of: string | null };
  snapshot: string;
  total_budget_cents: number | null;
  daily_budget_cents?: number | null;
  start_time?: number | null;
  observed_spend_cents?: number | null;
  own_hold_usd?: number | null;
  end_time: number | null;
  ads: Array<{ id: string; status: string }>;
};
type MonthBudget = {
  status: string;
  monthly_usd?: number | string;
  month_cap_usd?: number | string;
  left_usd?: number | string;
  daily_limit_usd?: number | string | null;
};
type LaunchRequest = { binding: string; signature: string; id: string; total_budget_cents: number; end_time: number; lost?: boolean };
const launchRequestKey = (bindingId: string) => `zavi.linkedinLaunch.${bindingId}`;
const storedLaunchRequest = (bindingId: string): LaunchRequest | null => {
  try {
    const v = JSON.parse(sessionStorage.getItem(launchRequestKey(bindingId)) ?? "null");
    return v && v.binding === bindingId && typeof v.signature === "string" && typeof v.id === "string" && Number.isSafeInteger(v.total_budget_cents) && Number.isSafeInteger(v.end_time) ? v : null;
  } catch {
    return null;
  }
};
const keepLaunchRequest = (bindingId: string, r: LaunchRequest | null) => {
  try {
    if (r) sessionStorage.setItem(launchRequestKey(bindingId), JSON.stringify(r));
    else sessionStorage.removeItem(launchRequestKey(bindingId));
  } catch {
    void 0;
  }
};
const DEFAULT_END_CLOCK = "23:45";
const END_CHECK_SLACK_MS = 60_000;
const endWords = (problem: LinkedinEndTimeProblem, now: number) => {
  if (problem === "too_far") return "Choose an end date within the next year.";
  if (problem === "before_start") return "Choose an end date after this campaign's start date.";
  const earliest = new Date(now + LINKEDIN_MIN_RUNWAY_MS + END_CHECK_SLACK_MS).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${problem === "passed" ? "This end date has already passed." : "A launch has to run for at least 12 hours."} Choose an end on or after ${earliest}.`;
};
const WALLET_OFF_LAUNCH = "Your shared wallet permission is withdrawn, so this campaign paid from it cannot launch. Authorize the shared wallet above to launch it again.";
const SERVER_END_REFUSAL = /has already passed|less than 12 hours from now/;
const REVIEW_AGAIN = /Review the launch again\.$/;
const CHECKING_LAUNCH = "Zavi is checking whether this launch went through…";
const CHECKING_NOTICE = `${CHECKING_LAUNCH} It may already be running: if it should not be, press Pause on it. Do not launch it again until this check finishes.`;
const PAUSING = "Pausing… Zavi keeps retrying.";
const LAUNCH_REPLY_LOST = "Zavi didn't hear back from this launch, so it may or may not have gone live. Nothing is charged twice: press Try again to check it safely. Zavi keeps this request even if you refresh the page.";
export const SETTING_UP_POLL_MS = 10_000;
const localDay = (t: number) => {
  const d = new Date(t);
  return isoDay(d.getFullYear(), d.getMonth(), d.getDate());
};
const field =
  "w-full rounded-[10px] border border-rule bg-cream px-3 text-[16px] font-medium text-ink outline-none focus:border-ink sm:text-[14px]";
function StatusPill({ label, title }: { label: string; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[12px] font-medium leading-4 ${
        label === "Live"
          ? "border-success/30 text-success"
          : "border-rule text-inkMuted"
      }`}
    >
      {label}
    </span>
  );
}
const statusLabel = (status?: string | null) => {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (s === "paused" || s === "draft") return "Paused";
  if (s === "active" || s === "live") return "Live";
  if (s === "out_of_budget") return "Out of budget";
  if (["ended", "completed", "archived", "canceled", "cancelled"].includes(s))
    return "Ended";
  return "";
};
const money = (c: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    c / 100,
  );
export function BoundAdsCampaigns({
  platform,
  newCampaign,
  onCampaigns,
  walletOff = false,
  pauseOnly = false,
  refreshKey = 0,
}: {
  platform: "chatgpt" | "linkedin";
  newCampaign?: ReactNode;
  refreshKey?: number;
  walletOff?: boolean;
  pauseOnly?: boolean;
  onCampaigns?: (campaigns: Campaign[]) => void;
}) {
  const config = platformFor(`${platform}_ads`);
  const workspace = config.campaignWorkspace;
  const spec = workspace?.controls?.resources
    ? { ...workspace, apiBase: `/api/ads/${platform}` }
    : null;
  const [launchSheet, setLaunchSheet] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    campaign: ManagedCampaign;
    prefix: string;
    currency: string | null;
  } | null>(null);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [budget, setBudget] = useState("");
  const [adBudget, setAdBudget] = useState<"set" | "missing" | "unknown">(
    "unknown",
  );
  const [month, setMonth] = useState<MonthBudget | null>(null);
  const [monthReading, setMonthReading] = useState(false);
  const monthRead = useRef(0);
  const [endDay, setEndDay] = useState("");
  const [endClock, setEndClock] = useState(DEFAULT_END_CLOCK);
  const end = endDay ? `${endDay}T${endClock}` : "";
  const [error, setError] = useState("");
  const [launchError, setLaunchError] = useState("");
  const [, setClockTick] = useState(0);
  const launchProblem = useRef<HTMLDivElement>(null);
  const [listError, setListError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [states, setStates] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<Record<string, number>>({});
  const [pausing, setPausing] = useState<Record<string, number>>({});
  const [walletFunds, setWalletFunds] = useState<number | null>(null);
  const liveRole = useLiveRole();
  const role = liveRole.role;
  const canLaunch = !liveRole.unknown && (role === "owner" || role === "admin");
  const planLock = useChannelPlanLock();
  const lockWords = platform === "linkedin" && !pauseOnly ? launchLockWords(planLock, config.name) : "";
  const [at, setAt] = useState<string | null>(null);
  const launchForm = useRef<HTMLFormElement>(null);
  const latch = useRef(false);
  const request = useRef<LaunchRequest | null>(null);
  const [pendingRequest, setPendingRequest] = useState<LaunchRequest | null>(null);
  const rememberRequest = (bindingId: string, r: LaunchRequest | null) => {
    request.current = r;
    setPendingRequest(r);
    keepLaunchRequest(bindingId, r);
  };
  const settleRequest = (bindingId: string) => {
    if (request.current?.binding === bindingId) rememberRequest(bindingId, null);
    else keepLaunchRequest(bindingId, null);
  };
  const liveStates = useCampaignStates(`${platform}_ads`);
  const seenLiveStates = useRef(liveStates);
  const campaignsNow = useRef(campaigns);
  campaignsNow.current = campaigns;
  useEffect(() => {
    if (seenLiveStates.current === liveStates) return;
    seenLiveStates.current = liveStates;
    setStates((s) =>
      Object.fromEntries(
        Object.entries(s).filter(([bound, state]) => {
          if (state !== "Paused" && state !== "Ended") return false;
          const c = campaignsNow.current.find((x) => x.id === bound);
          return !!c && !liveStates[c.provider_campaign_id];
        }),
      ),
    );
  }, [liveStates]);
  const reportCampaigns = useRef(onCampaigns);
  reportCampaigns.current = onCampaigns;
  const [listVersion, setListVersion] = useState(0);
  const listVersionNow = useRef(listVersion);
  listVersionNow.current = listVersion;
  const seenRefresh = useRef(refreshKey);
  useEffect(() => {
    if (seenRefresh.current === refreshKey) return;
    seenRefresh.current = refreshKey;
    setListVersion((v) => v + 1);
  }, [refreshKey]);
  useEffect(() => {
    const slug = `${platform}_ads`;
    const changed = (e: Event) => {
      if ((e as CustomEvent<{ slug?: string }>).detail?.slug !== slug) return;
      setListVersion((v) => v + 1);
      if (platform === "linkedin") announceChannelDashboardStale(slug);
    };
    const reselected = (e: Event) => {
      const detail = (e as CustomEvent<{ slug?: string; scope?: string }>).detail;
      if (detail?.slug !== slug || detail?.scope !== "selection") return;
      setListVersion((v) => v + 1);
    };
    window.addEventListener(CHANNEL_HISTORY_CHANGED_EVENT, changed);
    window.addEventListener(CHANNEL_DASHBOARD_STALE_EVENT, reselected);
    return () => {
      window.removeEventListener(CHANNEL_HISTORY_CHANGED_EVENT, changed);
      window.removeEventListener(CHANNEL_DASHBOARD_STALE_EVENT, reselected);
    };
  }, [platform]);
  useEffect(() => {
    let stopped = false;
    void campaignFetch<{ campaigns: Campaign[] }>(
      `/api/ads/campaigns?platform=${platform}`,
    )
      .then((r) => {
        if (stopped) return;
        setListError("");
        setChecking((s) => Object.fromEntries(Object.entries(s).filter(([, at]) => at >= listVersion)));
        setPausing((s) => Object.fromEntries(Object.entries(s).filter(([, at]) => at >= listVersion)));
        setCampaigns(r.campaigns);
        reportCampaigns.current?.(r.campaigns);
      })
      .catch((e) => {
        if (!stopped) setListError(e.message);
      });
    return () => {
      stopped = true;
    };
  }, [platform, listVersion]);
  useEffect(() => {
    if (launchError) launchProblem.current?.scrollIntoView?.({ block: "center" });
  }, [launchError]);
  const reviewing = review?.campaign_binding_id ?? null;
  useEffect(() => {
    if (reviewing) launchForm.current?.scrollIntoView?.({ block: "nearest" });
  }, [reviewing]);
  useEffect(() => {
    if (!reviewing) return;
    const reread = () => void readMonthNow.current();
    const shown = () => {
      if (document.visibilityState === "visible") reread();
    };
    window.addEventListener("focus", reread);
    window.addEventListener(AD_BUDGET_CHANGED_EVENT, reread);
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.removeEventListener("focus", reread);
      window.removeEventListener(AD_BUDGET_CHANGED_EVENT, reread);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [reviewing]);
  const pendingLaunch = (c: Campaign) => c.launch_pending === true || checking[c.id] !== undefined;
  const pendingPause = (c: Campaign) => c.pause_pending === true || pausing[c.id] !== undefined;
  const settingUp = campaigns.some((c) => (c.setting_up && c.setting_up !== "closed") || pendingLaunch(c) || pendingPause(c));
  useEffect(() => {
    if (!settingUp) return;
    const id = setTimeout(
      () => setListVersion((v) => v + 1),
      SETTING_UP_POLL_MS,
    );
    return () => clearTimeout(id);
  }, [settingUp, listVersion]);
  async function perform(work: () => Promise<void>, report: (message: string) => void = setError, row: string | null = null) {
    if (latch.current) return;
    latch.current = true;
    setAt(row);
    setBusy(true);
    setError("");
    setLaunchError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      report(
        e instanceof Error ? e.message : "The change could not be confirmed.",
      );
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }
  async function manage(id: string, pause = false) {
    const path = `/api/ads/${platform}/campaigns/${id}`;
    const r = await campaignFetch<{
      campaign: ManagedCampaign;
      campaign_name_prefix: string;
      currency: string | null;
    }>(path);
    if (pause) {
      await campaignFetch(path, {
        method: "POST",
        body: JSON.stringify({
          status: "paused",
          expected_updated_at: r.campaign.updated_at,
        }),
      });
      setStates((s) => ({ ...s, [id]: "Paused" }));
      setSelected(null);
    } else
      setSelected({
        campaign: r.campaign,
        prefix: r.campaign_name_prefix ?? "",
        currency: r.currency,
      });
  }
  async function read(id: string) {
    if (spec) {
      setLaunchSheet(id);
      return;
    }
    await loadReview(id);
  }
  const walletFundsFor = (id: string) =>
    Promise.all([
      campaignFetch<{ available_cents?: unknown }>("/api/ads/wallet"),
      campaignFetch<{ reservations?: Array<{ campaign_binding_id: string; reserved_cents: unknown }> }>("/api/ads/wallet/reservations"),
    ]).then(([w, r]) => {
      const own = Array.isArray(r?.reservations) ? Number(r.reservations.find((x) => x.campaign_binding_id === id)?.reserved_cents ?? 0) : NaN;
      const total = Number(w?.available_cents) + own;
      return Number.isFinite(total) ? total : null;
    }, () => null);
  const fetchMonth = () =>
    campaignFetch<{ budget: MonthBudget | null }>(
      "/api/workspace/ad-budget",
    ).then(
      (b) => b.budget,
      () => undefined,
    );
  const applyMonth = (monthly: MonthBudget | null | undefined) => {
    setAdBudget(
      monthly === undefined
        ? "unknown"
        : monthly?.status === "active"
          ? "set"
          : "missing",
    );
    setMonth(monthly?.status === "active" ? monthly : null);
  };
  async function readMonth() {
    const seq = ++monthRead.current;
    setMonthReading(true);
    const monthly = await fetchMonth();
    if (seq !== monthRead.current) return;
    setMonthReading(false);
    applyMonth(monthly);
  }
  const readMonthNow = useRef(readMonth);
  readMonthNow.current = readMonth;
  async function loadReview(id: string, keepInputs = false) {
    const seq = ++monthRead.current;
    const [r, monthly, funds] = await Promise.all([
      campaignFetch<Review>(`/api/ads/campaigns/${id}/launch`),
      fetchMonth(),
      campaigns.find((c) => c.id === id)?.funding_source === "wallet" ? walletFundsFor(id) : Promise.resolve(null),
    ]);
    setWalletFunds(funds);
    if (seq === monthRead.current) {
      setMonthReading(false);
      applyMonth(monthly);
    }
    setReview(r);
    if (keepInputs) return;
    const pending = storedLaunchRequest(id) ?? (request.current?.binding === id ? request.current : null);
    request.current = pending;
    setPendingRequest(pending);
    const total = pending ? pending.total_budget_cents : r.total_budget_cents;
    const endAt = pending ? pending.end_time : r.end_time;
    setBudget(total === null ? "" : String(total / 100));
    const local =
      endAt === null
        ? ""
        : new Date(
            endAt - new Date(endAt).getTimezoneOffset() * 60_000,
          )
            .toISOString()
            .slice(0, 16);
    setEndDay(local.slice(0, 10));
    setEndClock(local.slice(11, 16) || DEFAULT_END_CLOCK);
  }
  const cents = Math.round(Number(budget) * 100);
  const minUsdCents = Math.round(linkedinMinTotalUsd() * 100);
  const minCents = review ? linkedinMinTotalCents(review.currency, review.fx?.units_per_usd) : minUsdCents;
  const dailyCents =
    typeof review?.daily_budget_cents === "number" &&
    Number.isFinite(review.daily_budget_cents) &&
    review.daily_budget_cents > 0
      ? review.daily_budget_cents
      : null;
  const floorCents = Math.max(minCents, dailyCents ?? 0);
  const floorWords = !review
    ? ""
    : `${money(floorCents, review.currency)}${floorCents === minCents && minCents > minUsdCents ? ` (about ${money(minUsdCents, "USD")})` : ""}`;
  const endTime = new Date(end).getTime();
  const reviewStart = typeof review?.start_time === "number" ? review.start_time : 0;
  const checkEnd = () => linkedinEndTimeProblem(endTime, reviewStart, Date.now() + END_CHECK_SLACK_MS);
  const budgetReadable = /^\d+(\.\d{1,2})?$/.test(budget) && Number.isSafeInteger(cents);
  const spentCents =
    typeof review?.observed_spend_cents === "number" &&
    Number.isFinite(review.observed_spend_cents) &&
    review.observed_spend_cents > 0
      ? review.observed_spend_cents
      : null;
  const spentCopy =
    review && spentCents !== null && budgetReadable && cents > 0 && cents <= spentCents
      ? `This campaign has already spent ${money(spentCents, review.currency)}, and its total budget covers its whole life, so enter a total above ${money(spentCents, review.currency)}.`
      : "";
  const budgetOk = budgetReadable && cents >= floorCents && !spentCopy;
  const belowDailyCopy =
    review && !spentCopy && dailyCents !== null && budgetReadable && cents > 0 && cents < dailyCents
      ? linkedinTotalBelowDailyWords(dailyCents, minCents, review.currency)
      : "";
  const endProblem = Number.isFinite(endTime) ? checkEnd() : null;
  const valid = budgetOk && Number.isFinite(endTime) && !endProblem;
  const endCopy = endProblem ? endWords(endProblem, Date.now()) : "";
  const ownHoldUsd =
    typeof review?.own_hold_usd === "number" &&
    Number.isFinite(review.own_hold_usd) &&
    review.own_hold_usd > 0
      ? review.own_hold_usd
      : 0;
  const leftUsd =
    Math.round((Number(month?.left_usd) + ownHoldUsd) * 100) / 100;
  const observed =
    typeof review?.observed_spend_cents === "number" &&
    Number.isFinite(review.observed_spend_cents)
      ? review.observed_spend_cents
      : null;
  const remainingCents = cents - (observed ?? 0);
  const spend =
    review && valid
      ? linkedinLaunchSpend({
          total_cents: cents,
          observed_cents: observed ?? 0,
          end_time: endTime,
          start_time: typeof review.start_time === "number" ? review.start_time : Date.now(),
          now: Date.now(),
        })
      : null;
  const holdCents = spend ? spend.spendable_cents : remainingCents;
  const totalUsd =
    review?.currency === "USD"
      ? holdCents / 100
      : review?.fx
        ? holdCents / 100 / review.fx.units_per_usd
        : NaN;
  const overMonth =
    !!review &&
    adBudget === "set" &&
    month?.left_usd !== undefined &&
    Number.isFinite(leftUsd) &&
    Number.isFinite(totalUsd) &&
    remainingCents > 0 &&
    Math.ceil(Math.round(Number(totalUsd.toFixed(6)) * 1e6) / 1e4) > Math.round(leftUsd * 100);
  const overMonthKnown = overMonth && observed !== null;
  const partMonth =
    Number(month?.month_cap_usd) < Number(month?.monthly_usd);
  const monthName = new Date().toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  const leftInCurrency =
    review && review.currency !== "USD" && review.fx
      ? Math.floor(leftUsd * review.fx.units_per_usd * 100)
      : Math.floor(leftUsd * 100);
  const fitsTotal = (observed ?? 0) + leftInCurrency;
  const leftWords = `${money(Math.round(leftUsd * 100), "USD")} left this month in your monthly ad budget${ownHoldUsd > 0 ? `, counting the ${money(Math.round(ownHoldUsd * 100), "USD")} already set aside for this campaign` : ""}${partMonth ? ` (it started part-way through ${monthName})` : ""}`;
  const nextStep = !review
    ? ""
    : fitsTotal < floorCents || leftInCurrency < 1
      ? `A launch needs at least ${floorWords}, so raise your monthly ad budget to launch.`
      : `Raise your monthly ad budget, or lower the total to ${money(fitsTotal, review.currency)}${review.currency !== "USD" ? ` (about ${money(Math.round(leftUsd * 100), "USD")}${observed ? " still to spend" : ""})` : ""} or less.`;
  const overMonthCopy = !overMonth || !review
    ? ""
    : overMonthKnown
    ? `${
        observed
          ? `The ${money(remainingCents, review.currency)} still to spend on this ${money(cents, review.currency)} launch (${money(observed, review.currency)} already spent)`
          : `This ${money(cents, review.currency)} launch`
      } does not fit the ${leftWords}, so it cannot be approved. ${nextStep}`
    : `Your monthly ad budget has ${money(Math.round(leftUsd * 100), "USD")} left this month${ownHoldUsd > 0 ? `, counting the ${money(Math.round(ownHoldUsd * 100), "USD")} already set aside for this campaign` : ""}${partMonth ? ` (it started part-way through ${monthName})` : ""}, so this ${money(cents, review.currency)} launch may not fit. ${nextStep}`;
  const dailyLimitUsd = month?.daily_limit_usd == null ? NaN : Number(month.daily_limit_usd);
  const dailyUsdCents =
    dailyCents === null || !review
      ? NaN
      : review.currency === "USD"
        ? dailyCents
        : review.fx
          ? Math.ceil(Math.round((dailyCents / review.fx.units_per_usd) * 1e4) / 1e4)
          : NaN;
  const overDaily =
    !!review &&
    adBudget === "set" &&
    Number.isFinite(dailyLimitUsd) &&
    dailyLimitUsd > 0 &&
    Number.isFinite(dailyUsdCents) &&
    dailyUsdCents > Math.round(dailyLimitUsd * 100);
  const overDailyCopy = overDaily && review && dailyCents !== null
    ? `This campaign spends up to ${money(dailyCents, review.currency)} a day${review.currency !== "USD" ? ` (about ${money(dailyUsdCents, "USD")})` : ""}, more than the ${money(Math.round(dailyLimitUsd * 100), "USD")} daily limit on your monthly ad budget, so it cannot be approved. Raise the daily limit to at least ${money(dailyUsdCents, "USD")}, or lower this campaign's daily budget, then review the launch again.`
    : "";
  const walletHold = review?.funding_source === "wallet";
  const walletRefused = walletHold && walletOff;
  const walletKnown = walletHold && walletFunds !== null;
  const fundsCents = Math.max(0, walletFunds ?? 0);
  const walletNeedCents = Math.max(0, remainingCents);
  const walletShort = walletKnown && valid && walletNeedCents > fundsCents;
  const walletShortCopy = walletShort && review
    ? `Your shared wallet has ${money(fundsCents, "USD")} available for this campaign, and this launch needs ${money(walletNeedCents, review.currency)} set aside, so it cannot launch. Add funds to your shared wallet above, or lower the total budget.`
    : "";
  const serverBlocker = review && review.status === "PAUSED" && !walletRefused ? review.launch_blocker?.trim() ?? "" : "";
  const reviewed = campaigns.find((c) => c.id === review?.campaign_binding_id);
  const summaryRows: Array<[string, string]> = !review
    ? []
    : [
        ...(spend && dailyCents !== null
          ? ([
              ["Daily limit", `${money(dailyCents, review.currency)} a day`],
              ["Total", `${money(cents, review.currency)}, then it stops`],
              ...(Number.isFinite(endTime) && !endProblem
                ? [["End date", new Date(endTime).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })]]
                : []),
              ["Set aside", observed ? `${money(holdCents, review.currency)} still to spend of the ${money(cents, review.currency)} total, from your monthly ad budget` : `${money(cents, review.currency)} from your monthly ad budget`],
              ["Unspent money", "Goes back to your monthly ad budget when the campaign ends or is paused"],
            ] as Array<[string, string]>)
          : []),
        ...(walletKnown && valid
          ? ([["Shared wallet", `${money(fundsCents, "USD")} available, ${money(walletNeedCents, review.currency)} needed`]] as Array<[string, string]>)
          : []),
        ...(walletHold
          ? ([["Wallet hold", "Full remaining budget, reserved before launch. Pausing keeps it held until the campaign ends and spend is stable for 72 hours"]] as Array<[string, string]>)
          : []),
      ];
  const launchSignature = review ? JSON.stringify({ id: review.campaign_binding_id, snapshot: review.snapshot, total_budget_cents: cents, end_time: endTime }) : "";
  const retryLaunch = !!review && pendingRequest?.lost === true && pendingRequest.signature === launchSignature;
  const firstDay = localDay(Date.now() + LINKEDIN_MIN_RUNWAY_MS + END_CHECK_SLACK_MS);
  const lastDay = localDay(Date.now() + 365 * 86400000);
  async function launch() {
    if (
      !canLaunch ||
      !review ||
      !valid ||
      review.status !== "PAUSED" ||
      adBudget !== "set" ||
      overMonthKnown ||
      overDaily ||
      walletRefused ||
      !!serverBlocker ||
      walletShort ||
      !!lockWords
    )
      return;
    if (checkEnd()) {
      setClockTick((t) => t + 1);
      return;
    }
    const body = {
      snapshot: review.snapshot,
      total_budget_cents: cents,
      end_time: endTime,
    };
    const launched = review.campaign_binding_id;
    const signature = launchSignature;
    const previous = request.current?.binding === launched ? request.current : storedLaunchRequest(launched);
    const attempt: LaunchRequest = previous?.signature === signature ? previous : { binding: launched, signature, id: crypto.randomUUID(), total_budget_cents: cents, end_time: endTime };
    rememberRequest(launched, attempt);
    let result: { status: string; record_pending?: boolean; notice?: string };
    try {
      result = await campaignFetch<{ status: string; record_pending?: boolean; notice?: string }>(
        `/api/ads/campaigns/${review.campaign_binding_id}/launch`,
        {
          method: "POST",
          body: JSON.stringify({
            ...body,
            request_id: attempt.id,
            reviewed_units_per_usd: review.fx?.units_per_usd ?? null,
          }),
        },
      );
    } catch (e) {
      if (
        e instanceof Error &&
        "code" in e &&
        e.code === "ads_launch_not_sent" &&
        "status" in e &&
        e.status === 409
      ) {
        settleRequest(launched);
      }
      if (e instanceof Error && SERVER_END_REFUSAL.test(e.message)) {
        settleRequest(launched);
        throw new Error(endWords("too_soon", Date.now()));
      }
      if (e instanceof Error && "status" in e && e.status === 409 && "code" in e && e.code === "linkedin_launch_outcome_unknown") {
        result = { status: "unclear" };
      } else if (e instanceof Error && "status" in e && e.status === 409 && REVIEW_AGAIN.test(e.message)) {
        await loadReview(launched, true).catch(() => {
          throw e;
        });
        throw new Error(e.message.replace(REVIEW_AGAIN, "The launch review below is now up to date. Check it, then approve again."));
      } else if (e instanceof TypeError || (e instanceof Error && "reply_lost" in e && e.reply_lost === true)) {
        rememberRequest(launched, { ...attempt, lost: true });
        throw new Error(LAUNCH_REPLY_LOST);
      } else throw e;
    }
    settleRequest(launched);
    if (platform === "linkedin") announceChannelDashboardStale(`${platform}_ads`);
    setReview(null);
    if (result.status === "active") {
      setStates((s) => ({ ...s, [launched]: "Active" }));
      setNotice(result.record_pending === true && typeof result.notice === "string" && result.notice.trim() ? result.notice.trim() : `${config.name} confirmed the campaign is active.`);
      return;
    }
    setChecking((s) => ({ ...s, [launched]: listVersionNow.current }));
    setListVersion((v) => v + 1);
    setNotice(CHECKING_NOTICE);
  }
  const rowPrimary =
    "inline-flex min-h-11 w-full flex-1 items-center justify-center gap-1.5 rounded-cta bg-ink px-3.5 text-[13px] font-semibold text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-9 sm:w-auto sm:flex-none";
  const rowSecondary =
    "inline-flex min-h-11 w-full flex-1 items-center justify-center gap-1.5 rounded-cta border border-rule px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-ink/[0.05] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9 sm:w-auto sm:flex-none";
  const callout =
    "flex items-start gap-2.5 rounded-lg bg-ink/[0.05] px-3 py-2.5 text-[13px] leading-5 text-ink";
  const launchPrimary =
    "inline-flex min-h-11 items-center justify-center rounded-cta bg-ink px-4 text-[14px] font-semibold text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
  const launchSecondary =
    "inline-flex min-h-11 items-center justify-center rounded-cta border border-rule bg-cream px-4 text-[14px] font-medium text-ink transition-colors hover:bg-bone disabled:cursor-not-allowed disabled:opacity-50";
  const atRow = at && campaigns.some((c) => c.id === at) ? at : null;
  const blocked = !review
    ? ""
    : walletRefused
      ? WALLET_OFF_LAUNCH
    : review.status === "ACTIVE"
      ? "This campaign is already running."
      : ["COMPLETED", "ARCHIVED", "CANCELED"].includes(review.status)
        ? "This campaign has ended, so it cannot be launched again."
        : review.status !== "PAUSED"
          ? `Only a paused campaign can be launched. Check it in ${config.name}.`
          : serverBlocker || adBudget !== "set"
            ? ""
            : belowDailyCopy || spentCopy || walletShortCopy || overDailyCopy
              ? ""
              : !budgetOk || !Number.isFinite(endTime)
                ? `Enter a total budget of at least ${floorWords} and an end date within the next year.`
                : "";
  return (
    <section
      className="space-y-3"
      aria-label={`${config.name} campaign launches`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-ca-title font-semibold text-ca-xdark">Campaigns with verified accounts</h3>
        {!pauseOnly && newCampaign}
      </div>
      {lockWords && (
        <p id={LAUNCH_LOCK_ID} role="status" className="text-sm text-inkMuted">
          {lockWords}
          {planLock?.tierName && (
            <>
              {" "}
              <button type="button" className="font-medium text-ink underline underline-offset-2" onClick={() => planLock.upgrade(null, { clicked: true })}>
                {`Upgrade to ${planLock.tierName}`}
              </button>
            </>
          )}
        </p>
      )}
      {error && !atRow && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {listError && listError !== error && (
        <p role="alert" className="text-sm text-danger">
          {listError}
        </p>
      )}
      {notice && !atRow && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {liveRole.unknown && campaigns.length > 0 && (
        <p role="status" data-testid="role-unread" className="text-sm text-inkMuted">
          {liveRole.checking
            ? "Checking your workspace role…"
            : "Zavi could not check your workspace role just now, so Launch and Pause are hidden until it can."}{" "}
          {!liveRole.checking && (
            <button type="button" className="font-medium text-ink underline underline-offset-2" onClick={liveRole.recheck}>
              Try again
            </button>
          )}
        </p>
      )}
      {!liveRole.unknown && !canLaunch && campaigns.length > 0 && (
        <p className="text-sm text-inkMuted">
          Only workspace owners and admins can launch or pause campaigns.
        </p>
      )}
      {!campaigns.length && !pauseOnly && (
        <p className="text-sm text-inkMuted">
          {newCampaign
            ? "Press New campaign to start a draft. Review it, create it paused, and launch it here."
            : "Create a paused campaign from a reviewed draft to launch it here."}
        </p>
      )}
      {campaigns.length > 0 && (
        <ul className="space-y-2">
          {campaigns.map((c) => {
            const live = platform === "linkedin" && !states[c.id] && !c.setting_up
              ? liveStates[c.provider_campaign_id]
              : undefined;
            const pill = live ? linkedinCampaignPill(live) : null;
            const stored = statusLabel(c.status);
            const checkingLaunch = !states[c.id] && pendingLaunch(c);
            const pausingRow = !states[c.id] && pendingPause(c);
            const shown =
              states[c.id] === "Active"
                ? "Live"
                : pausingRow
                  ? "Pausing"
                : checkingLaunch
                  ? "Checking launch"
                  : states[c.id] ||
                  (c.setting_up
                    ? c.setting_up === "closed" ? "Not finished" : "Setting up"
                    : pill?.label ?? (platform === "linkedin" && stored === "Live" ? "Active" : stored));
            const running =
              platform === "linkedin" &&
              (states[c.id]
                ? states[c.id] === "Active"
                : live
                  ? live.status.toUpperCase() === "ACTIVE"
                  : stored === "Live" || stored === "Out of budget");
            const knownPaused =
              platform === "linkedin" &&
              (states[c.id] === "Paused" || pill?.label === "Paused");
            const ended = platform === "linkedin" && shown === "Ended";
            const knownEnded = platform === "linkedin" && (states[c.id] === "Ended" || pill?.label === "Ended");
            const nothingToPause = knownEnded || c.setting_up === "closed";
            const shownTitle = pill?.title ?? (shown === "Active" && !states[c.id] ? "Zavi has not read this campaign from LinkedIn just now, so it cannot say its ads are delivering." : undefined);
            return (
            <li
              key={c.id}
              data-campaign-row
              className="flex flex-col gap-3 rounded-xl border border-ink/10 bg-cream px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ink/[0.06] text-inkMuted">
                <Megaphone className="h-4 w-4" strokeWidth={1.5} aria-hidden />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 max-w-full items-center gap-2">
                  <span
                    className="truncate text-[14px] font-semibold leading-5 text-ink"
                    title={c.name || undefined}
                  >
                    {c.name || `Campaign ${c.provider_campaign_id}`}
                  </span>
                  {shown && <StatusPill label={shown} title={shownTitle} />}
                </span>
                <span className="text-[12px] leading-5 text-inkMuted">
                  {c.funding_source === "wallet"
                    ? "Paid from your Zavi shared wallet"
                    : c.provider_account_id
                    ? `Paid by your ad account ${c.provider_account_id}`
                    : `Billed to your own ${config.name} account`}
                  {c.created_at ? ` · Created ${createdWords(c.created_at)}` : ""}
                </span>
                {canLaunch && c.setting_up && (
                  <span className="text-[13px] leading-5 text-inkMuted">
                    {c.setting_up === "retry"
                      ? "Still being set up. Press Try again on its campaign card to finish it before launching."
                      : c.setting_up === "closed"
                      ? c.funding_source === "wallet"
                        ? "This campaign has no ad and its setup card is closed, so it cannot launch and has nothing to pause. It stays paused in Zavi's ad account and cannot spend. Start a new campaign."
                        : "This campaign has no ad and its setup card is closed, so it cannot launch and has nothing to pause. Start a new campaign, and remove this one in LinkedIn Campaign Manager."
                      : "Zavi could not confirm this campaign finished setting up. Check it in LinkedIn Campaign Manager before launching."}
                  </span>
                )}
                {pausingRow && (
                  <span data-testid="pause-pending" className="text-[13px] leading-5 text-inkMuted">
                    {PAUSING}
                  </span>
                )}
                {checkingLaunch && (
                  <span data-testid="launch-checking" className="text-[13px] leading-5 text-inkMuted">
                    {CHECKING_LAUNCH}
                  </span>
                )}
                {canLaunch && !c.setting_up && ended && (
                  <span data-testid="ended-row" className="text-[13px] leading-5 text-inkMuted">
                    {knownEnded ? "This campaign has ended, so it cannot be launched or paused." : "This campaign has ended, so it cannot be launched again."}
                  </span>
                )}
                {canLaunch && !c.setting_up && !running && !checkingLaunch && !ended && walletOff && c.funding_source === "wallet" && (
                  <span data-testid="wallet-off-launch" className="text-[13px] leading-5 text-inkMuted">
                    {WALLET_OFF_LAUNCH}
                  </span>
                )}
                {atRow === c.id && error && (
                  <p role="alert" data-testid="row-error" className="text-[13px] font-medium leading-5 text-danger">
                    {error}
                  </p>
                )}
                {atRow === c.id && notice && (
                  <p role="status" data-testid="row-notice" className="text-[13px] leading-5 text-ink">
                    {notice}
                  </p>
                )}
              </div>
              </div>
              <div className="flex gap-2 sm:shrink-0 sm:items-center">
                {!canLaunch || pauseOnly || c.pause_only || c.setting_up || running || checkingLaunch || pausingRow || ended || (walletOff && c.funding_source === "wallet") ? null : (
                  <button
                    className={rowPrimary}
                    disabled={busy || !!lockWords}
                    aria-describedby={lockWords ? LAUNCH_LOCK_ID : undefined}
                    onClick={() => void perform(() => read(c.id), setError, c.id)}
                  >
                    <PlayIcon className="h-3.5 w-3.5" />
                    Review launch
                  </button>
                )}
                {spec && (
                  <button
                    className={rowSecondary}
                    disabled={busy}
                    onClick={() => void perform(() => manage(c.id), setError, c.id)}
                  >
                    Manage ads
                  </button>
                )}
                {canLaunch && (!spec || shown !== "Ended") && !nothingToPause && !knownPaused && !pausingRow && (
                  <button
                    className={rowSecondary}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        if (spec) {
                          await manage(c.id, true);
                          return;
                        }
    
                        let paused: { status?: string };
                        try {
                          paused = await campaignFetch<{ status?: string }>(`/api/ads/campaigns/${c.id}/pause`, {
                            method: "POST",
                            body: "{}",
                          });
                        } catch (e) {
                          if (!(e instanceof Error && "status" in e && e.status === 503 && "code" in e && e.code === "ads_pause_queued")) throw e;
                          setReview((r) => (r?.campaign_binding_id === c.id ? null : r));
                          setStates((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== c.id)));
                          setPausing((s) => ({ ...s, [c.id]: listVersionNow.current }));
                          setListVersion((v) => v + 1);
                          if (platform === "linkedin") announceChannelDashboardStale(`${platform}_ads`);
                          setNotice(e.message);
                          return;
                        }
                        setReview((r) => (r?.campaign_binding_id === c.id ? null : r));
                        setStates((s) => ({
                          ...s,
                          [c.id]: paused?.status === "ended" ? "Ended" : "Paused",
                        }));
                        setListVersion((v) => v + 1);
                        if (platform === "linkedin") announceChannelDashboardStale(`${platform}_ads`);
                        const state =
                          paused?.status === "ended"
                            ? "LinkedIn shows this campaign already ended, so there was nothing to pause."
                            : paused?.status === "already_paused"
                              ? "LinkedIn shows this campaign was already paused."
                              : "LinkedIn confirmed the campaign is paused.";
                        setNotice(
                          c.funding_source === "wallet"
                            ? `${state} Reserved funds remain until final spending is settled.`
                            : state,
                        );
                      }, setError, c.id)
                    }
                  >
                    <PauseIcon className="h-3.5 w-3.5" />
                    Pause
                  </button>
                )}
              </div>
            </li>
            );
          })}
        </ul>
      )}
      {spec && selected && (
        <CampaignEditor
          spec={spec}
          campaign={selected.campaign}
          prefix={selected.prefix}
          currency={selected.currency}
          onBack={() => setSelected(null)}
          onSaved={() => setSelected(null)}
        />
      )}
      {spec && launchSheet && (
        <LaunchSheet
          spec={spec}
          campaignId={launchSheet}
          onClose={() => setLaunchSheet(null)}
        />
      )}
      {review && canLaunch && !pauseOnly && (
        <form
          ref={launchForm}
          className="mt-2 flex animate-pane-fade flex-col gap-4 rounded-xl border border-rule bg-ink/[0.03] p-4 motion-reduce:animate-none"
          onSubmit={(e) => {
            e.preventDefault();
            void perform(launch, setLaunchError, review.campaign_binding_id);
          }}
        >
          <div>
            <p className="text-[15px] font-semibold leading-6 text-ink">{review.name}</p>
            <p data-testid="launch-identity" className="text-[13px] font-medium leading-5 text-ink [overflow-wrap:anywhere]">
              {[
                reviewed?.created_at ? `Created ${createdWords(reviewed.created_at)}` : null,
                dailyCents !== null ? `${money(dailyCents, review.currency)} a day now` : null,
                `Campaign ${reviewed?.provider_campaign_id ?? review.campaign_binding_id}`,
              ].filter(Boolean).join(" · ")}
            </p>
            <p className={`${sheetHint} !mt-0.5`}>
              {review.funding_source === "wallet" ? (
                walletKnown
                  ? `Paid from your shared wallet, ${money(fundsCents, "USD")} available for this campaign`
                  : "Paid from your shared wallet"
              ) : (
                `Billed to your ${config.name} account (${review.account_id})`
              )}{" "}
              · {review.ads.length} {review.ads.length === 1 ? "ad" : "ads"}
            </p>
          </div>
          {serverBlocker && (
            <div id="launch-blocker" role="alert" className={callout}>
              <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-inkMuted" />
              <p>{serverBlocker} It cannot launch until this is fixed.</p>
            </div>
          )}
          <label className={sheetLabel}>
            Total campaign budget ({review.currency})
            <input
              className={`mt-1.5 block min-h-11 max-w-[240px] tabular-nums ${field} disabled:opacity-60`}
              aria-label={`Total campaign budget (${review.currency})`}
              type="number"
              inputMode="decimal"
              min={floorCents / 100}
              step="0.01"
              required
              disabled={busy || !!serverBlocker}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          {spentCopy && (
            <p id="launch-total-spent" role="alert" className="text-[13px] font-medium leading-5 text-danger">
              {spentCopy}
            </p>
          )}
          {belowDailyCopy && (
            <p id="launch-below-daily" role="alert" className="text-[13px] font-medium leading-5 text-danger">
              {belowDailyCopy}
            </p>
          )}
          <div role="group" aria-labelledby="launch-end-label">
            <span id="launch-end-label" className={sheetLabel}>
              End date and time (your timezone)
            </span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <DatePicker
                label="End date"
                field="end-day"
                fieldClass={field}
                className="min-h-11 w-[200px] max-w-full"
                value={endDay}
                min={firstDay}
                max={lastDay}
                invalid={!!endProblem}
                disabled={busy || !!serverBlocker}
                onChange={setEndDay}
              />
              <TimePicker
                label="End time"
                className="min-h-11 w-[140px] max-w-full"
                value={endClock}
                disabled={busy || !!serverBlocker}
                onChange={setEndClock}
              />
            </div>
            {endCopy && (
              <p id="launch-end-problem" role="alert" className="mt-1.5 text-[13px] font-medium leading-5 text-danger">
                {endCopy}
              </p>
            )}
          </div>
          {summaryRows.length > 0 && (
            <dl id="launch-pace" className="divide-y divide-rule rounded-xl border border-rule bg-cream px-3.5 text-[13px] leading-5">
              {summaryRows.map(([label, value]) => (
                <div key={label} className="flex min-w-0 items-baseline justify-between gap-4 py-2">
                  <dt className="shrink-0 text-inkMuted">{label}</dt>
                  <dd className="min-w-0 text-right font-medium tabular-nums text-ink [overflow-wrap:anywhere]">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="flex items-start gap-2 text-[13px] leading-5 text-inkMuted">
            <InfoIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{walletHold ? "Late spend is still charged." : "This launch does not debit your Zavi wallet."}</span>
          </p>
          {review.currency !== "USD" && review.fx && (
            <p className="text-[13px] leading-5 text-inkMuted">
              Amounts are in {review.currency}; the monthly USD budget uses
              converted amounts
              {Number.isFinite(cents)
                ? ` (approximately USD ${(cents / 100 / review.fx.units_per_usd).toFixed(2)})`
                : ""}
              . Daily rates from{" "}
              <a
                href="https://www.exchangerate-api.com"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-ink underline underline-offset-2"
              >
                ExchangeRate-API
              </a>
              .
            </p>
          )}
          {adBudget !== "set" && (
            <div role="alert" className={callout}>
              <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-inkMuted" />
              <p>
                {adBudget === "missing" ? (
                  <>
                    Launching needs a Zavi monthly ad budget, and none is set.{" "}
                    <a
                      href={AD_BUDGET_URL}
                      target="_blank"
                      rel="noopener"
                      className="font-medium underline underline-offset-2"
                    >
                      Set a monthly ad budget
                    </a>{" "}
                    in a new tab. Your total and end date stay here, and this form updates when you come back.
                  </>
                ) : (
                  <>
                    Could not check your Zavi monthly ad budget, so launching is off for now.{" "}
                    <button
                      type="button"
                      className="font-medium underline underline-offset-2 disabled:opacity-60"
                      disabled={monthReading}
                      onClick={() => void readMonth()}
                    >
                      {monthReading ? "Checking…" : "Try again"}
                    </button>
                  </>
                )}
              </p>
            </div>
          )}
          {walletShortCopy && (
            <div id="launch-wallet-short" role="alert" className={callout}>
              <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-inkMuted" />
              <p>{walletShortCopy}</p>
            </div>
          )}
          {overDailyCopy && (
            <div id="launch-over-daily" role="alert" className={callout}>
              <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-inkMuted" />
              <p>
                {overDailyCopy}{" "}
                <a
                  href={AD_BUDGET_URL}
                  target="_blank"
                  rel="noopener"
                  className="font-medium underline underline-offset-2"
                >
                  Open your monthly ad budget
                </a>
              </p>
            </div>
          )}
          {overMonthCopy && (
            <div id="launch-over-month" aria-live="polite" className={callout}>
              <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-inkMuted" />
              <p>
                {overMonthCopy}{" "}
                <a
                  href={AD_BUDGET_URL}
                  target="_blank"
                  rel="noopener"
                  className="font-medium underline underline-offset-2"
                >
                  Open your monthly ad budget
                </a>
              </p>
            </div>
          )}
          {blocked && (
            <p id="launch-blocked" className="text-[13px] leading-5 text-inkMuted">
              {blocked}
            </p>
          )}
          <div ref={launchProblem}>
            {launchError && (
              <p role="alert" className="text-[13px] font-medium leading-5 text-danger">
                {launchError}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              className={launchPrimary}
              type="submit"
              aria-describedby={lockWords ? LAUNCH_LOCK_ID : serverBlocker ? "launch-blocker" : spentCopy ? "launch-total-spent" : walletShortCopy ? "launch-wallet-short" : overDailyCopy ? "launch-over-daily" : belowDailyCopy ? "launch-below-daily" : endCopy ? "launch-end-problem" : blocked ? "launch-blocked" : overMonthKnown ? "launch-over-month" : undefined}
              disabled={
                busy ||
                !valid ||
                review.status !== "PAUSED" ||
                adBudget !== "set" ||
                overMonthKnown ||
                overDaily ||
                walletRefused ||
                !!serverBlocker ||
                walletShort ||
                !!lockWords
              }
            >
              {busy
                ? "Checking launch…"
                : retryLaunch
                  ? "Try again"
                  : `Approve and launch${valid ? ` · ${money(cents, review.currency)} total` : ""}`}
            </button>
            <button
              className={launchSecondary}
              type="button"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
