"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChevronRight } from "lucide-react";
import { adminApiFetch } from "@/lib/api-admin";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

type Scope = "real" | "all" | "test";

type Counts = { total: number; d30: number; d7: number; d1: number; tenants: number };
type Breakdown = Counts & { key: string; label: string };
type Action = Counts & {
  key: string;
  label: string;
  hint: string;
  breakdown_label: string | null;
  breakdown: Breakdown[];
};
type Group = Counts & { key: string; label: string; description: string; actions: Action[] };
type DailyRow = { day: string; total: number; groups: Record<string, number> };

type Resp = {
  scope: Scope;
  days: number;
  generated_at: string;
  tenants_in_scope: number;
  groups: Group[];
  daily: DailyRow[];
};

const SCOPES: ReadonlyArray<{ key: Scope; label: string; title: string }> = [
  { key: "real", label: "Real tenants", title: "Excludes test tenants, the launch-video shell and the Zavi dogfood tenants" },
  { key: "all", label: "All", title: "Every tenant, including test and dogfood" },
  { key: "test", label: "Test + internal", title: "Only test tenants, the launch-video shell and the Zavi dogfood tenants" },
];

const BAR_COLOR = "#2a78d6";
const AXIS_TICK = { fill: "#8c8c8c", fontSize: 11 };
const fmt = new Intl.NumberFormat("en-US");

export default function ActionTrackerPage() {
  const [scope, setScope] = useState<Scope>("real");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/action-tracker?scope=${scope}&days=30`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setData(r as Resp);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <PageHeader
        title="Action tracker"
        subtitle="Every action Zavi takes or produces, counted across all tenants. Counts come straight from the tables that hold each thing, so they include all history and grow as tenants use the product."
        actions={
          <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
            {SCOPES.map((s) => (
              <button
                key={s.key}
                type="button"
                title={s.title}
                onClick={() => setScope(s.key)}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  scope === s.key ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        }
      />

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {!data && !error ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data ? (
        <Tracker data={data} />
      ) : null}
    </div>
  );
}

function Tracker({ data }: { data: Resp }) {
  const [chartGroup, setChartGroup] = useState<string>("");

  return (
    <>
      <div className="mb-3 text-sm text-slate-500">
        {fmt.format(data.tenants_in_scope)} tenant{data.tenants_in_scope === 1 ? "" : "s"} in scope ·
        updated {new Date(data.generated_at).toLocaleTimeString()}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6 rise">
        {data.groups.map((g) => (
          <a
            key={g.key}
            href={`#group-${g.key}`}
            className="glass-card p-4 block transition-all hover:shadow-lift hover:-translate-y-0.5"
          >
            <div className="text-sm uppercase tracking-[0.14em] text-slate-500 truncate">{g.label}</div>
            <div className="mt-1 font-display font-semibold text-3xl tabular-nums text-slate-900">
              {fmt.format(g.total)}
            </div>
            <div className="mt-0.5 text-sm text-slate-500 tabular-nums">
              +{fmt.format(g.d7)} this week · {fmt.format(g.tenants)} tenant{g.tenants === 1 ? "" : "s"}
            </div>
          </a>
        ))}
      </div>

      <DailyChart
        daily={data.daily}
        groups={data.groups}
        days={data.days}
        selected={chartGroup}
        onSelect={setChartGroup}
      />

      <div className="space-y-5 mt-6">
        {data.groups.map((g) => (
          <GroupTable key={g.key} group={g} />
        ))}
      </div>
    </>
  );
}

function DailyChart({
  daily,
  groups,
  days,
  selected,
  onSelect,
}: {
  daily: DailyRow[];
  groups: Group[];
  days: number;
  selected: string;
  onSelect: (key: string) => void;
}) {
  const label = selected ? (groups.find((g) => g.key === selected)?.label ?? selected) : "All actions";
  const rows = useMemo(
    () =>
      daily.map((d) => ({
        label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
        count: selected ? (d.groups[selected] ?? 0) : d.total,
      })),
    [daily, selected],
  );
  const hasAny = rows.some((r) => r.count > 0);
  const config: ChartConfig = { count: { label, color: BAR_COLOR } };

  return (
    <div className="glass-card p-5 rise rise-d2">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="text-sm uppercase tracking-[0.14em] text-slate-500">
          {label} per day · last {days} days (UTC)
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[{ key: "", label: "All" }, ...groups.map((g) => ({ key: g.key, label: g.label }))].map((c) => (
            <button
              key={c.key || "all"}
              type="button"
              onClick={() => onSelect(c.key)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                selected === c.key
                  ? "bg-slate-900 text-white border-slate-900"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {hasAny ? (
        <ChartContainer config={config} className="h-[220px] w-full">
          <BarChart data={rows} margin={{ top: 12, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="#f0f0f0" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              tick={AXIS_TICK}
              interval={Math.max(0, Math.ceil(rows.length / 8) - 1)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tick={AXIS_TICK}
              width={44}
              allowDecimals={false}
            />
            <ChartTooltip cursor={{ fill: "#f1f5f9" }} content={<ChartTooltipContent />} />
            <Bar dataKey="count" fill={BAR_COLOR} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
          </BarChart>
        </ChartContainer>
      ) : (
        <div className="h-[220px] flex items-center justify-center rounded-lg border border-dashed border-slate-200 text-sm text-slate-500">
          Nothing in the last {days} days for this scope.
        </div>
      )}
    </div>
  );
}

function GroupTable({ group }: { group: Group }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  return (
    <section id={`group-${group.key}`} className="rounded-xl border border-slate-200 bg-white overflow-hidden scroll-mt-6">
      <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-display font-semibold text-base text-slate-900">{group.label}</h2>
          <p className="text-sm text-slate-500">{group.description}</p>
        </div>
        <div className="text-sm text-slate-500 tabular-nums">
          {fmt.format(group.total)} all-time · {fmt.format(group.tenants)} tenant{group.tenants === 1 ? "" : "s"}
        </div>
      </div>
      <div className="overflow-x-auto">
        {}
        <table className="w-full min-w-[640px] table-fixed text-sm">
          <colgroup>
            <col />
            <col className="w-28" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-24" />
          </colgroup>
          <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.08em]">
            <tr>
              <th className="text-left px-4 py-2.5">Action</th>
              <th className="text-right px-3 py-2.5">All-time</th>
              <th className="text-right px-3 py-2.5">30d</th>
              <th className="text-right px-3 py-2.5">7d</th>
              <th className="text-right px-3 py-2.5">24h</th>
              <th className="text-right px-4 py-2.5">Tenants</th>
            </tr>
          </thead>
          <tbody>
            {group.actions.map((a) => {
              const expandable = a.breakdown.length > 0;
              const isOpen = !!open[a.key];
              return (
                <Fragment key={a.key}>
                  <tr className="border-t border-slate-100">
                    <td className="px-4 py-2">
                      {expandable ? (
                        <button
                          type="button"
                          onClick={() => setOpen((o) => ({ ...o, [a.key]: !o[a.key] }))}
                          className="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap text-left text-slate-900 hover:text-sky-700"
                          aria-expanded={isOpen}
                          title={a.hint}
                        >
                          <ChevronRight
                            className={`h-3.5 w-3.5 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                          />
                          <span className="truncate">{a.label}</span>
                          {a.breakdown_label && (
                            <span className="text-xs text-slate-400">
                              {a.breakdown.length} {a.breakdown_label}
                            </span>
                          )}
                        </button>
                      ) : (
                        <span className="block truncate pl-5 text-slate-900" title={a.hint}>
                          {a.label}
                        </span>
                      )}
                    </td>
                    <CountCells c={a} />
                  </tr>
                  {isOpen &&
                    a.breakdown.map((b) => (
                      <tr key={`${a.key}:${b.key}`} className="border-t border-slate-50 bg-slate-50/50">
                        <td className="pl-12 pr-4 py-1.5 text-slate-600 truncate" title={b.label}>
                          {b.label}
                        </td>
                        <CountCells c={b} muted />
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CountCells({ c, muted }: { c: Counts; muted?: boolean }) {
  const cls = `text-right px-3 py-2 tabular-nums ${muted ? "text-slate-500" : "text-slate-700"}`;
  return (
    <>
      <td className={`${cls} ${muted ? "" : "font-semibold text-slate-900"}`}>{fmt.format(c.total)}</td>
      <td className={cls}>{fmt.format(c.d30)}</td>
      <td className={cls}>{fmt.format(c.d7)}</td>
      <td className={cls}>{fmt.format(c.d1)}</td>
      <td className={`${cls} pr-4`}>{fmt.format(c.tenants)}</td>
    </>
  );
}
