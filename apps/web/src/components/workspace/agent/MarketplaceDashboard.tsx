"use client";

import { useCallback, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  CalendarCheck,
  CalendarRange,
  Info,
  Settings2,
  ShoppingBag,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import { MetricCard } from "../metrics/MetricCard";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  DashboardShell,
  KpiStrip,
  btn,
  num,
  useAgentDashboard,
} from "./dashboard-ui";
import { SetupNotice, SupplyDemandSetup, type SupplyDemandSetupState } from "./SupplyDemandSetup";

type Confidence = "high" | "medium" | "low" | "none";
type DemandBasis = "bookings" | "intent_events";
type BalanceLabel =
  | "demand_heavy"
  | "supply_heavy"
  | "balanced"
  | "supply_unknown"
  | "insufficient_data"
  | "not_enough_locations"
  | "not_compared";

type Region = {
  region_key: string;
  region_label: string;
  state: string | null;
  bookings_n: number;
  active_supply_n: number;
  total_listings: number | null;
  completed_listings: number | null;
  balance_label: BalanceLabel;
  demand_index?: number | null;
  confidence: Confidence;
  suppressed: boolean;
};

type Totals = {
  bookings_n: number;
  active_supply_n: number;
  total_listings: number | null;
};

type LegacyStateRow = Omit<Region, "region_key" | "region_label" | "demand_index"> & {
  geo_label: string;
};

interface MarketplaceIntel {
  generic?: boolean;
  setup?: SupplyDemandSetupState;
  tenant_id: string;
  configured: boolean;
  as_of: string;
  window_weeks: number;
  min_cell: number;
  demand_basis: DemandBasis;
  grouped_by?: "us_state" | "location";
  supply_unit?: "listings_created" | "listings" | "active_sellers" | null;
  active_supply_unit?: "listings" | "sellers" | null;
  regions?: Region[];
  states?: LegacyStateRow[];
  weeks: Array<{
    week_start: string;
    bookings_n: number;
    active_supply_n: number;
  }>;
  provenance: {
    source: string;
    validated: boolean;
    caveats: string[];
  };
  total?: Totals;
  us_total?: Totals;
}

const OTHER_REGION = "__other__";
const NO_LOCATION_REGION = "__no_location__";

const DEMAND = "#d97706";
const SUPPLY = "#2563eb";
const GOOD = "#059669";
const NEUTRAL = "#8c8c8c";

type Tone = "demand" | "supply" | "good" | "warn" | "neutral";

const TONE: Record<Tone, string> = {
  demand: "bg-amber-500/15 text-amber-600",
  supply: "bg-blue-500/15 text-blue-600",
  good: "bg-emerald-500/15 text-emerald-600",
  warn: "bg-amber-500/15 text-amber-600",
  neutral: "bg-bone text-inkMuted",
};

const CARD = "rounded-2xl border border-rule bg-cream";

const TOOLTIP_STYLE = {
  contentStyle: {
    background: "rgb(var(--c-cream))",
    border: "1px solid rgb(var(--c-rule))",
    borderRadius: 12,
    fontSize: 13,
    color: "rgb(var(--c-ink))",
  },
  labelStyle: { color: "rgb(var(--c-ink))", fontWeight: 600, marginBottom: 2 },
};

function regionsOf(data: MarketplaceIntel): Region[] {
  if (data.regions) return data.regions;
  return (data.states ?? []).map((row) => {
    const legacyUnknown = row.geo_label === "unknown_state";
    return {
      ...row,
      region_key: row.state ?? (legacyUnknown ? OTHER_REGION : row.geo_label),
      region_label: legacyUnknown ? "Other locations" : row.state ?? row.geo_label,
      balance_label: legacyUnknown ? "not_compared" : row.balance_label,
      demand_index: null,
    };
  });
}

function totalsOf(data: MarketplaceIntel): Totals {
  return data.total ?? data.us_total ?? { bookings_n: 0, active_supply_n: 0, total_listings: null };
}

function supplyHeaderOf(data: MarketplaceIntel): string {
  switch (data.supply_unit) {
    case "listings_created":
      return "Listings created";
    case "active_sellers":
      return "Active sellers";
    case "listings":
      return "Listings";
    default:
      return isSelfServe(data) ? "Listings" : "Supply";
  }
}

function activeLabelsOf(data: MarketplaceIntel): { weeks: string; line: string } | null {
  const unit = data.active_supply_unit === undefined ? "listings" : data.active_supply_unit;
  if (unit === "listings") return { weeks: "Booked listing-weeks", line: "Listings booked" };
  if (unit === "sellers") return { weeks: "Seller-weeks with orders", line: "Sellers with orders" };
  return null;
}

function isBucket(region: Region): boolean {
  return region.region_key === OTHER_REGION || region.region_key === NO_LOCATION_REGION;
}

function count(n: number | null | undefined): string {
  return n === null || n === undefined ? "n/a" : num(n);
}

const notConfigured = (
  <SetupNotice title="Marketplace intelligence not configured for this workspace">
    This dashboard only renders once a tenant has a validated marketplace
    intelligence config. No supply or demand numbers are inferred here.
  </SetupNotice>
);

function SectionHead({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-[16px] font-semibold tracking-tight text-ink">{title}</h3>
      {sub ? <p className="mt-0.5 text-[16px] text-inkMuted">{sub}</p> : null}
    </div>
  );
}

function TextLink({
  onClick,
  icon: Icon,
  children,
}: {
  onClick: () => void;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group inline-flex cursor-pointer items-center gap-2 self-start text-[16px] text-inkMuted"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 group-hover:text-ink" aria-hidden />
      <span className="underline decoration-inkMuted/60 decoration-1 underline-offset-[3px] transition-colors group-hover:text-ink group-hover:decoration-ink">
        {children}
      </span>
    </button>
  );
}

function countMetric(key: string, value: number): ChannelMetric {
  return { key, value, unit: null, window_kind: null, day: "", grounded: true, prev_value: null, prev_day: null };
}

export function MarketplaceDashboard() {
  const state = useAgentDashboard<MarketplaceIntel>("marketplace-intelligence");
  const [editSetup, setEditSetup] = useState<SupplyDemandSetupState | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const openEditor = useCallback(async () => {
    setEditError(null);
    try {
      const res = await apiFetch("/api/agents/marketplace-intelligence/dashboard?edit_setup=1");
      const body = (await res.json().catch(() => null)) as { setup?: SupplyDemandSetupState } | null;
      if (!res.ok || !body?.setup) {
        setEditError(
          res.status === 403
            ? "Only a workspace owner or admin can change this setup."
            : "Couldn't open the setup. Try again.",
        );
        return;
      }
      setEditSetup(body.setup);
    } catch {
      setEditError("Couldn't open the setup. Try again.");
    }
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold leading-7 tracking-tight text-ink">
            Supply & Demand
          </h2>
          <p className="mt-0.5 text-[16px] text-inkMuted">
            Bookings and supply by location, week by week.
          </p>
        </div>
        <button
          type="button"
          onClick={state.refresh}
          disabled={state.refreshing}
          className={`${btn.secondary} shrink-0`}
        >
          {state.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <DashboardShell
        state={state}
        genericFallback={notConfigured}
        render={(data) =>
          editSetup ? (
            <div className="flex flex-col gap-4">
              <TextLink icon={ArrowLeft} onClick={() => setEditSetup(null)}>
                Back to the numbers
              </TextLink>
              <SupplyDemandSetup
                setup={editSetup}
                onChanged={() => {
                  setEditSetup(null);
                  state.refresh();
                }}
                onPoll={state.refreshSilent}
              />
            </div>
          ) : data.setup ? (
            <div className="flex flex-col gap-4">
              <SupplyDemandSetup
                setup={data.setup}
                onChanged={state.refresh}
                onPoll={state.refreshSilent}
              />
              {}
              {isSelfServe(data) && EDITABLE_SETUP_STATES.has(data.setup.state) ? (
                <EditSetupLink onEditSetup={openEditor} editError={editError} />
              ) : null}
            </div>
          ) : (
            <MarketplaceDashboardBody data={data} onEditSetup={openEditor} editError={editError} />
          )
        }
      />
    </div>
  );
}

const EDITABLE_SETUP_STATES = new Set(["calculation_failed", "no_recent_bookings", "waiting_first_run"]);

function EditSetupLink({
  onEditSetup,
  editError,
}: {
  onEditSetup: () => void;
  editError?: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <TextLink icon={Settings2} onClick={onEditSetup}>
        Change where these numbers come from
      </TextLink>
      {editError ? <div className="text-[13px] text-red-600">{editError}</div> : null}
    </div>
  );
}

function MarketplaceDashboardBody({
  data,
  onEditSetup,
  editError,
}: {
  data: MarketplaceIntel;
  onEditSetup?: () => void;
  editError?: string | null;
}) {
  if (!data.configured) {
    return notConfigured;
  }
  const totals = totalsOf(data);
  const active = activeLabelsOf(data);
  return (
    <div className="flex flex-col gap-7">
      <CaveatBanner data={data} />
      <KpiStrip>
        <MetricCard icon={ShoppingBag} label="Bookings" metric={countMetric("bookings", totals.bookings_n)} />
        {active ? (
          <MetricCard icon={CalendarCheck} label={active.weeks} metric={countMetric("active_supply", totals.active_supply_n)} />
        ) : null}
        {data.supply_unit === null || totals.total_listings === null ? null : (
          <MetricCard
            icon={data.supply_unit === "active_sellers" ? Users : Store}
            label={data.supply_unit === undefined || data.supply_unit === "listings" ? "Total listings" : supplyHeaderOf(data)}
            metric={countMetric("total_supply", totals.total_listings)}
          />
        )}
        <MetricCard icon={CalendarRange} label="Weeks in window" metric={countMetric("window_weeks", data.window_weeks)} />
      </KpiStrip>

      <WeeklyBookingsChart weeks={data.weeks ?? []} windowWeeks={data.window_weeks} activeLine={active?.line ?? null} />

      <RegionTable
        rows={regionsOf(data)}
        supplyHeader={data.supply_unit === null ? null : supplyHeaderOf(data)}
        activeHeader={active?.weeks ?? null}
      />

      {onEditSetup && isSelfServe(data) ? (
        <EditSetupLink onEditSetup={onEditSetup} editError={editError} />
      ) : null}
    </div>
  );
}

const SELF_SERVE_SOURCE = "self_serve_confirmed";
function isSelfServe(data: MarketplaceIntel): boolean {
  return data.provenance?.source === SELF_SERVE_SOURCE;
}

function currentWeekStart(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() || 7) - 1));
  return d.toISOString().slice(0, 10);
}

function MetaChip({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded-full bg-bone px-2.5 py-0.5 text-[13px] text-inkMuted">
      {children}
    </span>
  );
}

function CaveatBanner({ data }: { data: MarketplaceIntel }) {
  const caveats =
    (data.provenance?.caveats?.length ?? 0) > 0
      ? data.provenance.caveats
      : ["booking-based demand, not unmet demand"];
  const asOf = formatDate(data.as_of);

  return (
    <section className={`${CARD} px-4 py-3.5`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${TONE.warn}`}
            aria-hidden="true"
          >
            <Info className="h-3.5 w-3.5" />
          </span>
          <span className="text-[14px] font-semibold text-ink">Caveats</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MetaChip>{data.demand_basis === "bookings" ? "Bookings demand" : "Intent events demand"}</MetaChip>
          <MetaChip>Min cell {num(data.min_cell)}</MetaChip>
          <MetaChip>
            {isSelfServe(data)
              ? "Your confirmed setup"
              : data.provenance?.validated
                ? "Reviewed setup"
                : "Unreviewed setup"}
          </MetaChip>
          {asOf ? <MetaChip>As of {asOf}</MetaChip> : null}
        </div>
      </div>
      <ul className="mt-2.5 flex flex-col gap-1 pl-8 text-[16px] leading-5 text-inkMuted">
        {caveats.map((c, i) => (
          <li key={`${c}-${i}`} className="list-disc first-letter:uppercase marker:text-inkLight">
            {c}
          </li>
        ))}
      </ul>
    </section>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function WeeklyBookingsChart({
  weeks,
  windowWeeks,
  activeLine,
}: {
  weeks: MarketplaceIntel["weeks"];
  windowWeeks: number;
  activeLine: string | null;
}) {
  const sorted = [...weeks].sort(
    (a, b) => Date.parse(a.week_start) - Date.parse(b.week_start),
  );
  const thisWeek = currentWeekStart();

  return (
    <section>
      <SectionHead
        title={activeLine ? `Bookings and ${activeLine.toLowerCase()}, by week` : "Bookings by week"}
        sub={`Last ${windowWeeks} weeks`}
      />
      {sorted.length === 0 ? (
        <SetupNotice title="No weekly numbers yet">
          No weekly booking rows returned for this window.
        </SetupNotice>
      ) : (
        <div className={`${CARD} px-4 pb-3 pt-4 text-inkMuted`}>
          <div className="mb-2 flex flex-wrap justify-end gap-x-4 gap-y-1 text-[13px]">
            <LegendSwatch color={DEMAND} label="Bookings" />
            {activeLine ? <LegendSwatch color={SUPPLY} label={activeLine} /> : null}
          </div>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={sorted}
                margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
              >
                <CartesianGrid stroke="currentColor" strokeOpacity={0.15} vertical={false} />
                <XAxis
                  dataKey="week_start"
                  tickFormatter={(value: string) =>
                    value === thisWeek
                      ? `${formatWeekAxis(value)} (so far)`
                      : formatWeekAxis(value)
                  }
                  tick={{ fill: "currentColor", fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: "currentColor", strokeOpacity: 0.25 }}
                />
                <YAxis
                  tick={{ fill: "currentColor", fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  cursor={{ stroke: "currentColor", strokeOpacity: 0.25 }}
                  labelFormatter={(value) =>
                    String(value) === thisWeek
                      ? `${formatWeek(String(value))} (week so far)`
                      : formatWeek(String(value))
                  }
                  formatter={(value, name) => [
                    num(typeof value === "number" ? value : Number(value)),
                    name,
                  ]}
                />
                <Line
                  type="linear"
                  dataKey="bookings_n"
                  name="Bookings"
                  stroke={DEMAND}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                  connectNulls={false}
                />
                {activeLine ? (
                  <Line
                    type="linear"
                    dataKey="active_supply_n"
                    name={activeLine}
                    stroke={SUPPLY}
                    strokeWidth={2}
                    dot={{ r: 2 }}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                  />
                ) : null}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}

const TH = "whitespace-nowrap bg-creamDeep px-4 py-2.5 text-[16px] font-semibold text-inkMuted";
const TD = "px-4 py-3 align-middle";

function RegionTable({
  rows,
  supplyHeader,
  activeHeader,
}: {
  rows: Region[];
  supplyHeader: string | null;
  activeHeader: string | null;
}) {
  const chartRows = [...rows].sort((a, b) => b.bookings_n - a.bookings_n);
  const tooFewToCompare = rows.some((row) => row.balance_label === "not_enough_locations");
  const chartHeight = Math.max(220, Math.min(420, chartRows.length * 34 + 56));

  return (
    <section>
      <SectionHead
        title="By location"
        sub={
          tooFewToCompare
            ? "Balance compares each location with your others. You need at least three locations with enough supply and bookings before any location can be called busier or quieter than the rest."
            : undefined
        }
      />
      {rows.length === 0 ? (
        <SetupNotice title="No locations yet">
          No locations returned for this window.
        </SetupNotice>
      ) : (
        <div className="flex flex-col gap-3">
          <div className={`${CARD} px-4 pb-3 pt-4 text-inkMuted`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <div className="text-[14px] font-semibold text-ink">Bookings by location</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                <LegendSwatch color={DEMAND} label="Busier" />
                <LegendSwatch color={GOOD} label="In line" />
                <LegendSwatch color={SUPPLY} label="Quieter" />
                <LegendSwatch color={NEUTRAL} label="No comparison" />
              </div>
            </div>
            <div style={{ height: chartHeight }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartRows}
                  layout="vertical"
                  margin={{ top: 4, right: 16, bottom: 0, left: 8 }}
                >
                  <CartesianGrid stroke="currentColor" strokeOpacity={0.15} horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fill: "currentColor", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "currentColor", strokeOpacity: 0.25 }}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="region_label"
                    width={120}
                    tick={{ fill: "currentColor", fontSize: 13 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    {...TOOLTIP_STYLE}
                    cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
                    formatter={(value, name) => [
                      num(typeof value === "number" ? value : Number(value)),
                      name === "bookings_n" ? "Bookings" : name,
                    ]}
                    labelFormatter={(_, payload) =>
                      payload?.[0]?.payload
                        ? String(payload[0].payload.region_label)
                        : "Location"
                    }
                  />
                  <Bar dataKey="bookings_n" name="Bookings" radius={[0, 4, 4, 0]}>
                    {chartRows.map((row) => (
                      <Cell
                        key={`${row.region_key}-bar`}
                        fill={balanceColor(row.balance_label)}
                        fillOpacity={row.suppressed ? 0.42 : 1}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {}
          <div className={`${CARD} overflow-x-auto`}>
            <table className="w-full min-w-[640px] text-[16px]">
              <thead>
                <tr className="border-b border-rule">
                  <th className={`${TH} w-full text-left`}>Location</th>
                  <th className={`${TH} w-px text-right`}>Bookings</th>
                  {activeHeader ? (
                    <th className={`${TH} w-px text-right`}>{activeHeader}</th>
                  ) : null}
                  {supplyHeader ? (
                    <th className={`${TH} w-px text-right`}>{supplyHeader}</th>
                  ) : null}
                  <th className={`${TH} w-px text-left`}>Balance</th>
                  <th className={`${TH} w-px text-left`}>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.region_key}
                    className="border-b border-rule transition-colors last:border-0 hover:bg-creamDeep/50"
                  >
                    <td className={`${TD} w-full max-w-0`}>
                      <div
                        className={`min-w-0 truncate font-semibold ${row.suppressed ? "text-inkMuted" : "text-ink"}`}
                        title={row.region_label}
                      >
                        {row.region_label}
                      </div>
                      {row.suppressed && !isBucket(row) ? (
                        <div className="mt-0.5 text-[13px] text-inkMuted">Few bookings</div>
                      ) : null}
                    </td>
                    <td
                      className={`${TD} w-px whitespace-nowrap text-right font-semibold tabular-nums ${
                        row.suppressed ? "text-inkMuted" : "text-ink"
                      }`}
                    >
                      {count(row.bookings_n)}
                    </td>
                    {activeHeader ? (
                      <td className={`${TD} w-px whitespace-nowrap text-right tabular-nums text-inkMuted`}>
                        {count(row.active_supply_n)}
                      </td>
                    ) : null}
                    {supplyHeader ? (
                      <td className={`${TD} w-px whitespace-nowrap text-right tabular-nums text-inkMuted`}>
                        {count(row.completed_listings)}
                      </td>
                    ) : null}
                    <td className={`${TD} w-px whitespace-nowrap`}>
                      {isBucket(row) ? null : <BalancePill label={row.balance_label} />}
                    </td>
                    <td className={`${TD} w-px whitespace-nowrap`}>
                      <ConfidenceBadge confidence={row.confidence} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function balanceColor(label: BalanceLabel): string {
  switch (label) {
    case "demand_heavy":
      return DEMAND;
    case "supply_heavy":
      return SUPPLY;
    case "balanced":
      return GOOD;
    case "supply_unknown":
    case "insufficient_data":
    case "not_enough_locations":
    case "not_compared":
      return NEUTRAL;
  }
}

function balanceTone(label: BalanceLabel): Tone {
  switch (label) {
    case "demand_heavy":
      return "demand";
    case "supply_heavy":
      return "supply";
    case "balanced":
      return "good";
    default:
      return "neutral";
  }
}

function BalancePill({ label }: { label: BalanceLabel }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium ${TONE[balanceTone(label)]}`}
    >
      {balanceLabel(label)}
    </span>
  );
}

const CONFIDENCE: Record<Confidence, { label: string; tone: Tone }> = {
  high: { label: "High", tone: "good" },
  medium: { label: "Medium", tone: "warn" },
  low: { label: "Low", tone: "neutral" },
  none: { label: "None", tone: "neutral" },
};

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const c = CONFIDENCE[confidence] ?? CONFIDENCE.none;
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium ${TONE[c.tone]}`}
    >
      {c.label}
    </span>
  );
}

function balanceLabel(label: BalanceLabel): string {
  switch (label) {
    case "demand_heavy":
      return "Busier than your other locations";
    case "supply_heavy":
      return "Quieter than your other locations";
    case "balanced":
      return "In line with your other locations";
    case "supply_unknown":
      return "Demand only";
    case "insufficient_data":
      return "Too little to compare";
    case "not_enough_locations":
      return "Not enough locations to compare";
    case "not_compared":
      return "Not compared";
  }
}

function formatWeek(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatWeekAxis(iso: string): string {
  const datePart = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (datePart) {
    return `${datePart[2]}-${datePart[3]}`;
  }

  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
