"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { HelpCircle, Plus } from "lucide-react";
import { CHANNEL_COLORS } from "./Chart";
import type { ChannelRow, ChannelsSection, PaidChannelRow, Section } from "./types";
import { Empty, Notice, Panel, Stat, TabHeader } from "../ui";
import { fmtCount, fmtDate, fmtPct, fmtRoas, fmtUsd } from "./format";

const COLUMNS: Array<{ key: string; label: string; render: (row: ChannelRow) => string }> = [
  { key: "spend", label: "Spend", render: (row) => fmtUsd(row.spend_usd) },
  { key: "leads", label: "Leads", render: (row) => fmtCount(row.leads) },
  { key: "customers", label: "Customers", render: (row) => fmtCount(row.customers) },
  { key: "cac", label: "CAC", render: (row) => fmtUsd(row.cac_usd) },
  { key: "roas", label: "ROAS", render: (row) => fmtRoas(row.roas) },
  { key: "conv", label: "Conv. rate", render: (row) => fmtPct(row.conversion_rate) },
  { key: "revenue", label: "Revenue", render: (row) => fmtUsd(row.revenue_usd) },
];

const PAID_COLUMNS = [
  { key: "ad-set", width: 271 },
  { key: "impressions", width: 101 },
  { key: "status", width: 176 },
  { key: "reach", width: 101 },
  { key: "result", width: 101 },
  { key: "cost-result", width: 101 },
  { key: "budget", width: 134 },
  { key: "spent", width: 134 },
  { key: "purchases", width: 134 },
  { key: "registrations", width: 134 },
  { key: "clicks", width: 134 },
  { key: "ctr", width: 134 },
  { key: "cpc", width: 134 },
  { key: "cpm", width: 134 },
  { key: "schedule", width: 246 },
  { key: "ends", width: 246 },
] as const;

function sourceLabel(source: string): string {
  if (source === "google_ads") return "Google Ads";
  if (source === "meta_ads") return "Meta Ads";
  return source.replace(/_/g, " ");
}

function statusLabel(value: string | null): string {
  if (!value) return "Unknown";
  if (/^(active|enabled)$/i.test(value)) return "Active";
  if (/^(draft|in_draft)$/i.test(value)) return "In draft";
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function fmtSchedule(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  const calendar = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${weekday} ${calendar}, ${time}`;
}

function fmtUsdPrecise(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function PaidSourceIcon({ source }: { source: string }) {
  const google = source === "google_ads";
  return (
    <span
      className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-[#f0f0f0] bg-white p-1"
      title={sourceLabel(source)}
    >
      <img
        alt=""
        aria-hidden="true"
        className="size-6"
        src={google
          ? "/figma/paid-channels/google.svg"
          : "/figma/paid-channels/facebook.svg"}
      />
      <span className="sr-only">{sourceLabel(source)}</span>
    </span>
  );
}

function PaidStatus({ value }: { value: string | null }) {
  const active = /^(active|enabled)$/i.test(value ?? "");
  return (
    <span
      className={active
        ? "inline-flex items-center gap-1.5 rounded-full bg-emerald-50 py-0.5 pl-1.5 pr-2 text-xs font-medium text-emerald-700"
        : "inline-flex items-center gap-1.5 rounded-full bg-neutral-100 py-0.5 pl-1.5 pr-2 text-xs font-medium text-neutral-700"}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {statusLabel(value)}
    </span>
  );
}

const paidHeadClass = "h-11 border-b border-[#e5e5e5] bg-[#fafafa] px-6 text-left text-xs font-medium text-[#525252]";
const paidCellClass = "h-[72px] border-b border-[#e5e5e5] px-6 py-4 text-sm font-normal text-[#525252]";

export function PaidChannelsTable({ rows }: { rows: PaidChannelRow[] }) {
  if (rows.length === 0) {
    return (
      <Panel title="Paid channels">
        <p className="px-6 py-5 text-sm text-muted-foreground">
          No connected source reports paid channels.
        </p>
      </Panel>
    );
  }

  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-[14px] border border-[#f0f0f0] bg-white">
      <div className="flex h-[52px] items-center justify-between gap-4 px-6 py-4">
        <h2 className="text-base font-bold text-[#141b34]">Paid channels</h2>
        <p className="text-[11px] font-bold uppercase tracking-[0.0055px] text-[#8c8c8c]">
          Source • Ad platforms
        </p>
      </div>

      <div className="min-w-0 max-w-full [contain:inline-size] overflow-x-auto overflow-y-hidden border-t border-[#e5e5e5] shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
        <table className="w-max min-w-[2415px] table-fixed border-collapse bg-white">
          <colgroup>
            {PAID_COLUMNS.map((column) => (
              <col key={column.key} style={{ width: column.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={paidHeadClass}>Ad set</th>
              <th scope="col" className={paidHeadClass}>Impressions</th>
              <th scope="col" className={paidHeadClass}>
                <span className="flex items-center gap-1">
                  Status
                  <HelpCircle className="size-4 text-[#8c8c8c]" aria-label="Current delivery status" />
                </span>
              </th>
              <th scope="col" className={paidHeadClass}>Reach</th>
              <th scope="col" className={paidHeadClass}>Result</th>
              <th scope="col" className={paidHeadClass}>Cost Result</th>
              <th scope="col" className={paidHeadClass}>Budget</th>
              <th scope="col" className={paidHeadClass}>Amount Spent</th>
              <th scope="col" className={paidHeadClass}>Website Purchase</th>
              <th scope="col" className={paidHeadClass}>Website registration</th>
              <th scope="col" className={paidHeadClass}>Clicks</th>
              <th scope="col" className={paidHeadClass}>CTR</th>
              <th scope="col" className={paidHeadClass}>CPC</th>
              <th scope="col" className={paidHeadClass}>CPM</th>
              <th scope="col" className={paidHeadClass}>Schedule</th>
              <th scope="col" className={`${paidHeadClass} relative`}>
                Ends
                <Plus className="absolute right-2.5 top-2.5 size-6 text-[#8c8c8c]" aria-hidden="true" />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.source}-${row.id || row.channel}`} className="last:[&>td]:border-b-0">
                <td className={paidCellClass}>
                  <div className="flex items-center gap-3">
                    <PaidSourceIcon source={row.source} />
                    <div className="min-w-0 leading-5">
                      <p className="truncate font-medium text-[#171717]">{row.channel}</p>
                      <p className="truncate text-[#525252]">
                        {row.ads_count === null
                          ? row.campaign_name ?? sourceLabel(row.source)
                          : `Results from ${fmtCount(row.ads_count)} ${row.ads_count === 1 ? "ad" : "ads"}`}
                      </p>
                    </div>
                  </div>
                </td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtCount(row.impressions)}</td>
                <td className={paidCellClass}><PaidStatus value={row.status} /></td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtCount(row.reach)}</td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtCount(row.result)}</td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtUsdPrecise(row.cost_result_usd)}</td>
                <td className={paidCellClass}>
                  <span className="block tabular-nums text-[#171717]">{fmtUsd(row.budget_usd)}</span>
                  {row.budget_period && (
                    <span className="block text-xs capitalize text-[#525252]">{row.budget_period}</span>
                  )}
                </td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtUsd(row.spend_usd)}</td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtCount(row.website_purchases)}</td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtCount(row.website_registrations)}</td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtCount(row.clicks)}</td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtPct(row.ctr)}</td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtUsdPrecise(row.cpc_usd)}</td>
                <td className={`${paidCellClass} tabular-nums`}>{fmtUsdPrecise(row.cpm_usd)}</td>
                <td className={`${paidCellClass} whitespace-nowrap`}>{fmtSchedule(row.schedule_at)}</td>
                <td className={`${paidCellClass} whitespace-nowrap`}>{row.ends_at ? fmtSchedule(row.ends_at) : "Ongoing"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ChannelTable({
  title,
  rows,
  total,
}: {
  title: string;
  rows: ChannelRow[];
  total: ChannelRow | null;
}) {
  if (rows.length === 0) {
    return (
      <Panel title={title}>
        <p className="px-6 py-5 text-sm text-muted-foreground">
          No connected source reports {title.toLowerCase()}.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title={title} meta={`source · ${[...new Set(rows.map((row) => row.source))].join(" + ")}`}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Channel</TableHead>
            {COLUMNS.map((column) => (
              <TableHead key={column.key}>{column.label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={`${row.source}-${row.channel}`}>
              <TableCell className="flex items-center gap-2 font-medium text-foreground">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: CHANNEL_COLORS[index % CHANNEL_COLORS.length] }}
                />
                {row.channel}
              </TableCell>
              {COLUMNS.map((column) => (
                <TableCell key={column.key} className="tabular-nums">
                  {column.render(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
        {total && (
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">{total.channel}</TableCell>
              {COLUMNS.map((column) => (
                <TableCell key={column.key} className="font-semibold tabular-nums">
                  {column.render(total)}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        )}
      </Table>
    </Panel>
  );
}

export function ChannelsTab({ section }: { section: Section<ChannelsSection> }) {
  const { paid, organic, totals, window: range } = section.data;

  if (paid.length === 0 && organic.length === 0) {
    return (
      <div>
        <TabHeader title="Growth channels" />
        <Empty title="No channel data for this client" detail={section.detail} />
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full">
      <TabHeader title="Growth channels" meta={`${fmtDate(range.since)} – ${fmtDate(range.until)}`} />
      <Notice status={section.status} detail={section.detail} />

      <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        {(["paid", "organic"] as const).map((kind) => {
          const total = totals[kind];
          return (
            <Panel key={kind} title={kind === "paid" ? "Paid" : "Organic"}>
              {total ? (
                <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-3">
                  <Stat label="Revenue" value={fmtUsd(total.revenue_usd)} />
                  <Stat label="Spend" value={fmtUsd(total.spend_usd)} />
                  <Stat label="Customers" value={fmtCount(total.customers)} />
                  <Stat label="CAC" value={fmtUsd(total.cac_usd)} />
                  <Stat label="ROAS" value={fmtRoas(total.roas)} />
                  <Stat label="Conv. rate" value={fmtPct(total.conversion_rate)} />
                </div>
              ) : (
                <p className="px-6 py-5 text-sm text-muted-foreground">
                  No {kind} source is connected for this client.
                </p>
              )}
            </Panel>
          );
        })}
      </div>

      <div className="space-y-6">
        <PaidChannelsTable rows={paid} />
        <ChannelTable title="Organic channels" rows={organic} total={totals.organic} />
      </div>
    </div>
  );
}
