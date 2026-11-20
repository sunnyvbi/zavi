
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { LEDGER_ONLY_READERS } from "@/services/decisions/ad-ledger-platforms";
import { readAdBudgetMonthView, type AdPlatform } from "@/services/decisions/ad-budget";
import { renderEmail, escapeEmailHtml, oneLineName } from "@/email/theme";
import { adBudgetUrl } from "@/services/web-base";
import { AD_CHANNEL_CONSTRAINTS } from "@zavi/shared";

export const RUNNING_STATUS: Record<string, ReadonlySet<string>> = {
  meta: new Set(["ACTIVE"]),
  chatgpt: new Set(["ACTIVE"]),
  google: new Set(["ENABLED"]),
  reddit: new Set(["ACTIVE"]),
  x: new Set(["ACTIVE"]),
};

export const STOPPED_STATUS: ReadonlySet<string> = new Set([
  "PAUSED",
  "CAMPAIGN_PAUSED",
  "DELETE",
  "DELETED",
  "ARCHIVED",
  "COMPLETED",
  "CANCELED",
  "DRAFT",
  "PENDING_DELETION",
  "BUDGETANDMANUALPAUSED",
  "SUSPENDED",
]);

export const PLATFORM_MIN_DAILY_USD: Record<string, number> = {
  ...Object.fromEntries(AD_CHANNEL_CONSTRAINTS.filter((c) => c.platform !== "linkedin" && c.platform !== "x").map((c) => [c.platform, c.min_daily_usd])),
  tiktok: 50,
  linkedin: AD_CHANNEL_CONSTRAINTS.find((c) => c.platform === "linkedin")?.min_daily_usd ?? 10,
};

const MAX_CAMPAIGN_ROWS = 1000;

export type BrakeObject = {
  platform: string;
  object_id: string;
  name: string | null;
  budget_kind: string;
  budget_usd: number | null;
};

export type BrakeCut = {
  platform: string;
  object_id: string;
  name: string | null;
  current_usd: number;
  suggested_usd: number;
};

export type MonthProjection = {
  spent_usd: number;
  creator_usd: number;
  month_cap_usd: number;
  days_left: number;
  running_daily_usd: number;
  projected_usd: number;
  over: boolean;
  daily: BrakeObject[];
  cannot_lower: BrakeObject[];
};

export type CampaignRow = {
  platform: string;
  object_id: string;
  name: string | null;
  budget_kind: string;
  budget_usd: number | string | null;
  status: string | null;
};

export type CampaignOverlay = (rows: (CampaignRow & { as_of: string })[]) => CampaignRow[];

const cents = (n: number) => Math.round(n * 100);

export function isRunning(r: Pick<CampaignRow, "platform" | "status">): boolean {
  const allow = RUNNING_STATUS[r.platform];
  if (allow) return r.status != null && allow.has(r.status);
  return r.status == null || !STOPPED_STATUS.has(r.status.toUpperCase());
}

export type CampaignBound = { left_usd: number; days: number };

export function projectMonth(
  view: { spent_usd: number; month_cap_usd: number; days_left: number; creator_held_usd?: number; creator_spent_usd?: number },
  rows: CampaignRow[],
  bounds?: ReadonlyMap<string, CampaignBound>,
): MonthProjection {
  const daily: BrakeObject[] = [];
  const cannot_lower: BrakeObject[] = [];
  for (const r of rows) {
    if (!isRunning(r)) continue;
    const budget = r.budget_usd == null ? null : Number(r.budget_usd);
    const o: BrakeObject = {
      platform: r.platform,
      object_id: r.object_id,
      name: r.name,
      budget_kind: r.budget_kind,
      budget_usd: budget,
    };
    if (
      r.budget_kind === "daily" &&
      budget != null &&
      Number.isFinite(budget) &&
      budget > 0
    )
      daily.push(o);
    else cannot_lower.push(o);
  }
  const runningCents = daily.reduce(
    (s, o) => s + cents(o.budget_usd as number),
    0,
  );
  const days = Math.max(0, Math.floor(view.days_left));
  const creatorCents = cents(view.creator_held_usd ?? 0) + cents(view.creator_spent_usd ?? 0);
  const restCents = daily.reduce((s, o) => {
    const full = cents(o.budget_usd as number) * days;
    const b = bounds?.get(`${o.platform}:${o.object_id}`);
    if (!b) return s + full;
    const byDays = cents(o.budget_usd as number) * Math.min(days, Math.max(0, Math.floor(b.days)));
    return s + Math.min(full, byDays, Math.max(0, cents(b.left_usd)));
  }, 0);
  const projectedCents = cents(view.spent_usd) + creatorCents + restCents;
  return {
    spent_usd: view.spent_usd,
    creator_usd: creatorCents / 100,
    month_cap_usd: view.month_cap_usd,
    days_left: days,
    running_daily_usd: runningCents / 100,
    projected_usd: projectedCents / 100,
    over: projectedCents > cents(view.month_cap_usd),
    daily,
    cannot_lower,
  };
}

export function suggestCuts(p: MonthProjection): {
  cuts: BrakeCut[];
  fits: boolean;
  new_daily_usd: number;
} {
  const items = p.daily.map((o) => {
    const cur = cents(o.budget_usd as number);
    const floor = Math.min(cur, cents(PLATFORM_MIN_DAILY_USD[o.platform] ?? 1));
    return { o, cur, floor, next: cur };
  });
  const days = p.days_left;
  const targetCents =
    days > 0
      ? Math.max(
          0,
          Math.floor((cents(p.month_cap_usd) - cents(p.spent_usd) - cents(p.creator_usd)) / days),
        )
      : 0;
  const floored = new Set<number>();
  for (;;) {
    const fixedCents = items.reduce(
      (sum, it, i) => sum + (floored.has(i) ? it.floor : 0),
      0,
    );
    const freeCents = items.reduce(
      (sum, it, i) => sum + (floored.has(i) ? 0 : it.cur),
      0,
    );
    if (freeCents === 0) break;
    const room = targetCents - fixedCents;
    const ratio = room <= 0 ? 0 : Math.min(1, room / freeCents);
    let newlyFloored = false;
    items.forEach((it, i) => {
      if (floored.has(i)) return;
      const scaled = Math.floor(it.cur * ratio);
      if (scaled < it.floor) {
        floored.add(i);
        newlyFloored = true;
      } else {
        it.next = scaled;
      }
    });
    if (!newlyFloored) break;
  }
  items.forEach((it, i) => {
    if (floored.has(i)) it.next = it.floor;
  });
  const newCents = items.reduce((sum, it) => sum + it.next, 0);
  const fits = newCents <= targetCents;
  const cuts = items
    .filter((it) => it.next < it.cur)
    .map((it) => ({
      platform: it.o.platform,
      object_id: it.o.object_id,
      name: it.o.name,
      current_usd: it.cur / 100,
      suggested_usd: it.next / 100,
    }));
  return { cuts, fits, new_daily_usd: newCents / 100 };
}

export type ReadAccount = { platform: string; account_id: string };

export async function readMonthProjection(
  tenant_id: string,
  accounts: readonly ReadAccount[],
  known?: Awaited<ReturnType<typeof readAdBudgetMonthView>>,
  overlay?: CampaignOverlay,
): Promise<{ budget_id: string; projection: MonthProjection } | null> {
  const view = known === undefined ? await readAdBudgetMonthView(tenant_id) : known;
  if (!view || view.status !== "active") return null;
  const read = new Set(accounts.map((a) => `${a.platform}:${a.account_id}`));
  if (read.size === 0)
    return { budget_id: view.id, projection: projectMonth(view, []) };
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_campaigns")
    .select(
      "platform, account_id, object_id, name, budget_kind, budget_usd, status, as_of",
    )
    .in("account_id", [...new Set(accounts.map((a) => a.account_id))])
    .or("status.is.null,status.neq.removed")
    .limit(MAX_CAMPAIGN_ROWS);
  if (error) throw new Error(`ad_campaigns read failed: ${error.message}`);
  const all = (data ?? []) as (CampaignRow & { account_id: string; as_of: string })[];
  if (all.length >= MAX_CAMPAIGN_ROWS)
    throw new Error("ad_campaigns read hit its row limit");
  const rows = all.filter((r) =>
    read.has(`${r.platform}:${r.account_id}`),
  );
  const laid = overlay ? overlay(rows) : rows;
  return { budget_id: view.id, projection: projectMonth(view, laid, await readLaunchBounds(tenant_id, view, laid)) };
}

const DAY_MS = 86_400_000;

export async function readLaunchBounds(
  tenant_id: string,
  view: { next_month_start: string; days_left: number },
  rows: readonly CampaignRow[],
): Promise<Map<string, CampaignBound>> {
  const out = new Map<string, CampaignBound>();
  const ids = [...new Set(rows.filter((r) => r.platform === "linkedin" && r.budget_kind === "daily" && isRunning(r)).map((r) => r.object_id))];
  const next = Date.parse(`${view.next_month_start}T00:00:00Z`);
  if (!ids.length || !Number.isFinite(next) || !Number.isFinite(view.days_left)) return out;
  const today = next - Math.floor(view.days_left) * DAY_MS;
  try {
    const db = tenantClient(asTenantId(tenant_id));
    const h = await db
      .from("ad_budget_reservations")
      .select("object_id, status, cap_usd, ends_on, spend_baseline_usd, spend_from, created_at")
      .eq("platform", "linkedin")
      .in("status", ["reserved", "committed"])
      .in("object_id", ids)
      .limit(MAX_CAMPAIGN_ROWS);
    if (h.error || !Array.isArray(h.data) || h.data.length >= MAX_CAMPAIGN_ROWS) return out;
    type Hold = { object_id: string; cap_usd: number | string | null; ends_on: string | null; spend_baseline_usd: number | string | null; spend_from: string | null; created_at: string };
    const newest = new Map<string, Hold>();
    for (const r of h.data as Hold[]) {
      if (!ids.includes(r.object_id) || r.cap_usd == null || !Number.isFinite(Number(r.cap_usd)) || !/^\d{4}-\d{2}-\d{2}$/.test(r.ends_on ?? "")) continue;
      const cur = newest.get(r.object_id);
      if (!cur || Date.parse(r.created_at) > Date.parse(cur.created_at)) newest.set(r.object_id, r);
    }
    if (!newest.size) return out;
    const s = await db
      .from("ad_spend_daily")
      .select("object_id, spend_date, amount_usd")
      .eq("platform", "linkedin")
      .in("object_id", [...newest.keys()])
      .limit(MAX_CAMPAIGN_ROWS);
    if (s.error || !Array.isArray(s.data) || s.data.length >= MAX_CAMPAIGN_ROWS) return out;
    const spend = s.data as Array<{ object_id: string; spend_date: string; amount_usd: number | string }>;
    if (spend.some((r) => !Number.isFinite(Number(r.amount_usd)))) return out;
    for (const [id, r] of newest) {
      const baseline = r.spend_baseline_usd == null ? null : Number(r.spend_baseline_usd);
      if (baseline !== null && !Number.isFinite(baseline)) continue;
      const since = r.spend_from ?? new Date(r.created_at).toISOString().slice(0, 10);
      const perDay = new Map<string, number>();
      for (const x of spend)
        if (x.object_id === id && (baseline !== null || x.spend_date >= since))
          perDay.set(x.spend_date, Math.max(perDay.get(x.spend_date) ?? 0, Number(x.amount_usd)));
      const spentCents = [...perDay.values()].reduce((a, v) => a + cents(v), 0) - cents(baseline ?? 0);
      const ends = Date.parse(`${r.ends_on}T00:00:00Z`);
      out.set(`linkedin:${id}`, {
        left_usd: Math.max(0, cents(Number(r.cap_usd)) - Math.max(0, spentCents)) / 100,
        days: Math.max(0, Math.round((ends - today) / DAY_MS)),
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

export const LIVE_ACCOUNT_MS = 26 * 3_600_000;

export async function readLiveMonthProjection(
  tenant_id: string,
  now: Date = new Date(),
  overlay?: CampaignOverlay,
): Promise<{ budget_id: string; projection: MonthProjection } | null> {
  const view = await readAdBudgetMonthView(tenant_id);
  if (!view || view.status !== "active") return null;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_campaigns")
    .select("platform, account_id")
    .gte("as_of", new Date(now.getTime() - LIVE_ACCOUNT_MS).toISOString())
    .limit(MAX_CAMPAIGN_ROWS);
  if (error) throw new Error(`ad_campaigns read failed: ${error.message}`);
  const rows = (data ?? []) as ReadAccount[];
  if (rows.length >= MAX_CAMPAIGN_ROWS)
    throw new Error("ad_campaigns read hit its row limit");
  const seen = new Map(rows.map((r) => [`${r.platform}:${r.account_id}`, { platform: r.platform, account_id: r.account_id }]));
  return readMonthProjection(tenant_id, [...seen.values()], view, overlay);
}

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

const PLATFORM_NAME: Record<string, string> = {
  meta: "Meta",
  google: "Google Ads",
  chatgpt: "ChatGPT Ads",
  reddit: "Reddit Ads",
  x: "X Ads",
  ...Object.fromEntries(LEDGER_ONLY_READERS.map((r) => [r.platform, r.name])),
};
const OBJECT_NAME: Record<string, string> = {
  meta: "ad set",
  google: "campaign",
  chatgpt: "campaign",
  reddit: "ad group",
  x: "campaign",
  ...Object.fromEntries(LEDGER_ONLY_READERS.map((r) => [r.platform, r.object])),
};

function objectLabel(o: {
  platform: string;
  object_id: string;
  name: string | null;
}): string {
  const what = `${PLATFORM_NAME[o.platform] ?? o.platform} ${OBJECT_NAME[o.platform] ?? "campaign"}`;
  return o.name ? `${what} "${o.name}"` : `${what} ${o.object_id}`;
}

const BUDGET_WRITABLE: Partial<Record<AdPlatform, true>> = { meta: true, google: true, chatgpt: true, reddit: true, x: true, tiktok: true };

function readOnlyNote(platform: string, wallet = false): string {
  if (Object.prototype.hasOwnProperty.call(BUDGET_WRITABLE, platform)) return "";
  const name = PLATFORM_NAME[platform] ?? platform;
  if (wallet) return `. Zavi can't lower this yet. It runs in Zavi's own ${name} account from your Zavi ads balance, so pause it from the ${name} channel in Zavi if it must spend less.`;
  return `. Zavi can't lower this yet. Change it in ${name}.`;
}

export async function walletObjectKeys(tenant_id: string): Promise<ReadonlySet<string>> {
  const { data, error } = await Promise.resolve()
    .then(() => tenantClient(asTenantId(tenant_id))
      .from("ads_campaign_binding_details")
      .select("id,platform,provider_campaign_id")
      .eq("funding_source", "wallet")
      .range(0, 999))
    .catch(() => ({ data: null, error: true }));
  if (error || !Array.isArray(data)) return new Set();
  return new Set(
    (data as Array<{ id: string; platform: string; provider_campaign_id: string | null }>).flatMap((b) => [
      `${b.platform}:${b.id}`,
      ...(b.provider_campaign_id ? [`${b.platform}:${b.provider_campaign_id}`] : []),
    ]),
  );
}

const KIND_REASON: Record<string, string> = {
  lifetime: "lifetime budget",
  campaign_level: "budget set on the campaign",
  shared: "shared budget",
  none: "no budget of its own",
};

function usdShort(n: number): string {
  if (Math.abs(n) < 10) return usd(n);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export type BrakeWarningContext = {
  incompletePlatforms?: readonly string[];
  companyName: string | null;
  autopilot: "off" | "unknown";
  url: string;
  walletObjects?: ReadonlySet<string>;
};

export function renderBrakeWarning(
  p: MonthProjection,
  s: { cuts: BrakeCut[]; fits: boolean },
  ctx: BrakeWarningContext,
) {
  const company = oneLineName(ctx.companyName);
  const cap = usdShort(p.month_cap_usd);
  const over = usdShort(Math.max(0, p.projected_usd - p.month_cap_usd));
  const nothingChanged =
    ctx.autopilot === "off"
      ? "Zavi changed nothing. Autopilot is off, so no budget is lowered without you."
      : "Zavi changed nothing, and no budget is lowered without you.";
  const incomplete = !!ctx.incompletePlatforms?.length;
  const isWallet = (o: { platform: string; object_id: string }) => !!ctx.walletObjects?.has(`${o.platform}:${o.object_id}`);
  const ownCannot = p.cannot_lower.filter((o) => !isWallet(o));
  const walletCannot = p.cannot_lower.filter(isWallet);
  const intro = `At today's daily budgets you'll spend ${incomplete ? "at least" : "about"} ${over} more than this month's ${cap} budget. ${nothingChanged}`;

  const lines: string[] = [];
  if (incomplete) lines.push(`${ctx.incompletePlatforms!.join(", ")} could not be read. These are minimum known totals; suggested cuts cover only the accounts read and do not prove the whole budget will fit.`);
  lines.push(
    `On track for ${usd(p.projected_usd)} of ${usd(p.month_cap_usd)} this month.`,
  );
  lines.push(
    `Spent so far: ${usd(p.spent_usd)}. Running daily budgets add up to ${usd(p.running_daily_usd)} a day, with ${p.days_left} day${p.days_left === 1 ? "" : "s"} left including today.`,
  );
  if (p.creator_usd > 0) lines.push(`Creator hires this month: ${usd(p.creator_usd)}.`);
  const sections: Array<{ title: string; items: string[] }> = [];
  if (s.cuts.length > 0) {
    sections.push({
      title: incomplete ? "Suggested reductions for the accounts read; the complete budget still needs verification:" : s.fits
        ? "To stay within the budget, lower these daily budgets:"
        : "Even at each platform's minimum these do not fit this month's budget. Pause some of them, or lower them to the lowest they can go:",
      items: s.cuts.map(
        (c) =>
          `${objectLabel(c)}: ${usd(c.current_usd)} a day to ${usd(c.suggested_usd)} a day${readOnlyNote(c.platform, isWallet(c))}`,
      ),
    });
  }
  if (ownCannot.length > 0) {
    sections.push({
      title:
        "Zavi cannot lower these yet. Change them in the ad platform if you need to:",
      items: ownCannot.map(
        (o) =>
          `${objectLabel(o)} (${KIND_REASON[o.budget_kind] ?? o.budget_kind})`,
      ),
    });
  }
  if (walletCannot.length > 0) {
    sections.push({
      title:
        "Zavi cannot lower these yet. They run in Zavi's own ad accounts from your Zavi ads balance, so pause them from their channel in Zavi if they must spend less:",
      items: walletCannot.map(
        (o) =>
          `${objectLabel(o)} (${KIND_REASON[o.budget_kind] ?? o.budget_kind})`,
      ),
    });
  }

  const n = s.cuts.length;
  const ctaText = "Review ad budget";
  const preheader = incomplete ? `Known ad activity already exceeds ${cap}; some accounts could not be read. Zavi changed nothing.` :
    n > 0 && s.fits
      ? `Lower ${n === 1 ? "1 daily budget" : `${n} daily budgets`} to stay within ${cap} this month. Zavi changed nothing.`
      : n > 0
        ? `Even at each platform's minimum your ads pass ${cap} this month. Zavi changed nothing.`
        : ownCannot.length > 0
          ? `Change ${ownCannot.length === 1 ? "1 budget" : `${ownCannot.length} budgets`} in the ad platform to stay within ${cap}. Zavi changed nothing.`
          : `Your ads are on track to pass ${cap} this month. Zavi changed nothing.`;
  const subject = company
    ? `${company}: ads on track for ${usdShort(p.projected_usd)} of your ${cap} budget`
    : `Your ads are on track for ${usdShort(p.projected_usd)} of your ${cap} budget`;

  const text = [
    intro,
    "",
    ...lines,
    ...sections.flatMap((sec) => [
      "",
      sec.title,
      ...sec.items.map((i) => `- ${i}`),
    ]),
    "",
    `${ctaText}: ${ctx.url}`,
  ].join("\n");
  const p_ = (t: string) =>
    `<p style="font-family:sans-serif;font-size:15px;line-height:1.5;">${escapeEmailHtml(t)}</p>`;
  const body = [
    ...lines.map(p_),
    ...sections.map(
      (sec) =>
        `${p_(sec.title)}<ul style="font-family:sans-serif;font-size:15px;line-height:1.5;">${sec.items
          .map((i) => `<li>${escapeEmailHtml(i)}</li>`)
          .join("")}</ul>`,
    ),
  ].join("");
  const html = renderEmail({
    preheader,
    kicker: "Ad budget",
    eyebrow: company ? `${escapeEmailHtml(company)} · Budget watch` : "Budget watch",
    title: "Your ads may <em>overspend</em>",
    intro: escapeEmailHtml(intro),
    body,
    ctaText: escapeEmailHtml(ctaText),
    ctaUrl: escapeEmailHtml(ctx.url),
    footerVariant: "founder-growth",
  });
  return { subject, text, html };
}

export type BrakeOutcome =
  | { status: "read_failed"; error: string }
  | { status: "no_budget" }
  | { status: "already_checked" }
  | { status: "on_track"; projected_usd: number; cap_usd: number }
  | { status: "warned"; projected_usd: number; cap_usd: number; cuts: number }
  | { status: "send_failed"; error: string }
  | { status: "brake_due"; projected_usd: number; cap_usd: number }
  | { status: "event_failed"; error: string }
  | { status: "error"; error: string };

export type BrakeDeps = {
  incompletePlatforms?: readonly string[];
  send: (
    tenant_id: string,
    note: { subject: string; html: string; text: string },
  ) => Promise<unknown>;
  companyName?: (tenant_id: string) => Promise<string | null>;
  alertFounder?: (
    tenant_id: string,
    o: { budget_id: string; day: string; projected_usd: number; cap_usd: number },
  ) => Promise<void>;
};

async function autopilotState(tenant_id: string): Promise<"on" | "off" | "unknown"> {
  try {
    const { getBoolSettingStrictResolved } =
      await import("@/services/settings");
    return (await getBoolSettingStrictResolved(
      "cgo_autopilot_enabled",
      tenant_id,
    ))
      ? "on"
      : "off";
  } catch (e) {
    console.warn(
      `[ad-budget-brake] autopilot read failed for tenant ${tenant_id}; treating it as off: ${(e as Error).message}`,
    );
    return "unknown";
  }
}

async function companyNameOrNull(
  deps: BrakeDeps,
  tenant_id: string,
): Promise<string | null> {
  if (!deps.companyName) return null;
  try {
    return await deps.companyName(tenant_id);
  } catch (e) {
    console.warn(
      `[ad-budget-brake] company name read failed for tenant ${tenant_id}; sending without it: ${(e as Error).message}`,
    );
    return null;
  }
}

async function releaseClaim(
  tenant_id: string,
  budget_id: string,
): Promise<void> {
  try {
    const r = await tenantRpc(
      asTenantId(tenant_id),
      "release_ad_budget_brake",
      { p_budget_id: budget_id },
    );
    if (r.error) throw new Error(r.error.message);
  } catch (e) {
    console.error(
      `[ad-budget-brake] could not give back today's claim for ${budget_id}: ${(e as Error).message}`,
    );
  }
}

export async function runBudgetBrake(
  b: { id: string; tenant_id: string },
  accounts: readonly ReadAccount[],
  deps: BrakeDeps,
): Promise<BrakeOutcome> {
  let read: Awaited<ReturnType<typeof readMonthProjection>>;
  try {
    read = await readMonthProjection(b.tenant_id, accounts);
  } catch (e) {
    console.warn(
      `[ad-budget-brake] budget ${b.id}: read failed, not checking this hour: ${(e as Error).message}`,
    );
    return { status: "read_failed", error: (e as Error).message };
  }
  if (!read || read.budget_id !== b.id) return { status: "no_budget" };

  if (deps.incompletePlatforms?.length && !read.projection.over) {
    return { status: "read_failed", error: `Incomplete projection: ${deps.incompletePlatforms.join(", ")} unavailable; retry after a complete read.` };
  }
  let day: string;
  try {
    const r = await tenantRpc(
      asTenantId(b.tenant_id),
      "claim_ad_budget_brake",
      { p_budget_id: b.id },
    );
    if (r.error) throw new Error(r.error.message);
    const ans = (r.data ?? {}) as { claimed?: boolean; day?: string };
    if (ans.claimed !== true) return { status: "already_checked" };
    if (typeof ans.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ans.day)) {
      await releaseClaim(b.tenant_id, b.id);
      return {
        status: "error",
        error: "claim_ad_budget_brake returned no day",
      };
    }
    day = ans.day;
  } catch (e) {
    return { status: "error", error: `claim failed: ${(e as Error).message}` };
  }

  const p = read.projection;
  if (!p.over)
    return {
      status: "on_track",
      projected_usd: p.projected_usd,
      cap_usd: p.month_cap_usd,
    };

  const autopilot = await autopilotState(b.tenant_id);
  if (autopilot === "on") {
    console.log(
      `[ad-budget-brake] brake_due budget=${b.id} tenant=${b.tenant_id} projected=${p.projected_usd} cap=${p.month_cap_usd} day=${day}`,
    );
    try {
      const { inngest } = await import("@/../workers/client");
      await inngest.send({
        name: "ad-budget/brake.due",
        id: `ad-budget-brake:${b.id}:${day}`,
        data: {
          tenant_id: b.tenant_id,
          budget_id: b.id,
          projected_usd: p.projected_usd,
          cap_usd: p.month_cap_usd,
          day,
        },
      });
    } catch (e) {
      console.error(
        `[ad-budget-brake] brake.due event failed for ${b.id}; retrying next hour: ${(e as Error).message}`,
      );
      await releaseClaim(b.tenant_id, b.id);
      return { status: "event_failed", error: (e as Error).message };
    }
    await deps.alertFounder?.(b.tenant_id, { budget_id: b.id, day, projected_usd: p.projected_usd, cap_usd: p.month_cap_usd }).catch(() => undefined);
    return {
      status: "brake_due",
      projected_usd: p.projected_usd,
      cap_usd: p.month_cap_usd,
    };
  }

  const suggestion = suggestCuts(p);
  const warning = renderBrakeWarning(p, suggestion, {
    companyName: await companyNameOrNull(deps, b.tenant_id), autopilot, url: adBudgetUrl(b.tenant_id), incompletePlatforms: deps.incompletePlatforms,
    walletObjects: await walletObjectKeys(b.tenant_id),
  });
  try {
    await deps.send(
      b.tenant_id,
      warning,
    );
  } catch (e) {
    console.error(
      `[ad-budget-brake] warning failed for budget ${b.id}; retrying next hour: ${(e as Error).message}`,
    );
    await releaseClaim(b.tenant_id, b.id);
    return { status: "send_failed", error: (e as Error).message };
  }
  return {
    status: "warned",
    projected_usd: p.projected_usd,
    cap_usd: p.month_cap_usd,
    cuts: suggestion.cuts.length,
  };
}
