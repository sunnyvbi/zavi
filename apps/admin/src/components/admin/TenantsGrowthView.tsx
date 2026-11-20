"use client";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import {
  connectionTags,
  delta,
  growthView,
  istDate,
  personMatchesCard,
  presetRange,
  relativeTime,
  safeWebsite,
  tenantMatchesCard,
  validDateRange,
  type GrowthCard,
  type GrowthData,
} from "@/lib/tenants-growth";

export function rowClickOpensTenant(
  target: { closest(selector: string): unknown } | null,
  selectedText: string,
): boolean {
  if (selectedText) return false;
  return !target?.closest("a, button, input, select, textarea, label");
}

const control =
  "rounded-md border border-slate-200 bg-white px-3 py-2 text-sm aria-pressed:border-rose-300 aria-pressed:bg-rose-50 aria-pressed:text-rose-700 disabled:opacity-50";
const shortDate = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      }).format(new Date(iso))
    : "—";
function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs">
      {children}
    </span>
  );
}
function Website({ label, url }: { label: string; url: string | null }) {
  const safe = safeWebsite(url);
  return safe ? (
    <a
      className="block max-w-48 truncate text-rose-700 hover:underline"
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      title={safe}
    >
      {label}: {new URL(safe).hostname}
    </a>
  ) : null;
}
export function GrowthChart({
  rows,
  metric,
  type,
}: {
  rows: { day: string; signups: number; active: number }[];
  metric: "signups" | "active";
  type: "bar" | "line";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setWidth(Math.max(240, entry.contentRect.width));
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const max = Math.max(1, ...rows.map((r) => r[metric]));
  const w = width - 40,
    h = 160,
    step = w / Math.max(1, rows.length);
  return (
    <>
      <svg
        className="h-56 w-full"
        ref={svgRef}
        viewBox={`0 0 ${width} 210`}
        role="img"
        aria-label={`Daily ${metric}, ${rows.length} days`}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1="30"
              y1={180 - h * f}
              x2={width - 10}
              y2={180 - h * f}
              stroke="#e2e8f0"
            />
            <text x="2" y={184 - h * f} fontSize="10" fill="#64748b">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {type === "line" && (
          <polyline
            fill="none"
            stroke="#be123c"
            strokeWidth="2"
            points={rows
              .map(
                (r, i) =>
                  `${30 + (i + 0.5) * step},${180 - (r[metric] / max) * h}`,
              )
              .join(" ")}
          />
        )}
        {rows.map((r, i) => (
          <g
            key={r.day}
            tabIndex={0}
            role="img"
            aria-label={`${r.day}: ${r[metric]} ${metric}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
          >
            <rect
              x={30 + i * step}
              y="15"
              width={step}
              height="165"
              fill="transparent"
            />
            {type === "bar" ? (
              <rect
                x={30 + i * step + step * 0.15}
                y={180 - (r[metric] / max) * h}
                width={Math.max(1, step * 0.7)}
                height={(r[metric] / max) * h}
                fill={hover === i ? "#881337" : "#be123c"}
                rx="2"
              />
            ) : (
              <circle
                cx={30 + (i + 0.5) * step}
                cy={180 - (r[metric] / max) * h}
                r={hover === i ? 4 : 2}
                fill="#be123c"
              />
            )}
            <title>{`${r.day}: ${r[metric]} ${metric}`}</title>
            {(i === 0 ||
              i === rows.length - 1 ||
              i %
                Math.max(
                  1,
                  Math.ceil(rows.length / Math.max(2, Math.floor(w / 95))),
                ) ===
                0) && (
              <text
                x={30 + (i + 0.5) * step}
                y="200"
                fontSize="9"
                textAnchor="middle"
                fill="#64748b"
              >
                {r.day.slice(5)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <p className="min-h-5 text-xs text-slate-500" aria-live="polite">
        {hover !== null && rows[hover]
          ? `${shortDate(rows[hover].day)} · ${rows[hover][metric]} ${metric === "active" ? "active users" : "signups"}`
          : "Hover or focus a day to see its count."}
      </p>
    </>
  );
}
export function TenantsGrowthView({
  initialData,
}: {
  initialData?: GrowthData;
}) {
  const [today, setToday] = useState(initialData?.today ?? istDate(new Date()));
  const [range, setRange] = useState(() => presetRange("30", today));
  const [data, setData] = useState<GrowthData | null>(initialData ?? null),
    [loading, setLoading] = useState(!initialData),
    [error, setError] = useState<string | null>(null);
  const [showTest, setShowTest] = useState(false),
    [usage, setUsage] = useState(false),
    [card, setCard] = useState<GrowthCard>(null),
    [metric, setMetric] = useState<"signups" | "active">("signups"),
    [chartType, setChartType] = useState<"bar" | "line">("bar");
  const [search, setSearch] = useState(""),
    [plan, setPlan] = useState(""),
    [sort, setSort] = useState("signup"),
    [review, setReview] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false),
    [reviewDialog, setReviewDialog] = useState<boolean | null>(null),
    [reason, setReason] = useState(""),
    [message, setMessage] = useState("");
  const valid = validDateRange(range.from, range.to, today);
  useEffect(() => {
    if (initialData && revision === 0 && !usage) return;
    if (!valid) return;
    let cancelled = false;
    const abort = new AbortController();
    setLoading(true);
    setData(null);
    setError(null);
    void (async () => {
      try {
        const res = await adminApiFetch(
          `/api/admin/tenants-growth?from=${range.from}&to=${range.to}${usage ? "&include_usage=1" : ""}`,
          { signal: abort.signal },
        );
        const body = await res.json();
        if (!res.ok)
          throw Error(body.error?.message ?? "Could not load growth data.");
        if (!cancelled) {
          setData(body);
          setToday(body.today);
          setSelected(new Set());
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [range.from, range.to, usage, revision, valid, initialData]);
  const view = useMemo(
    () =>
      data && valid ? growthView(data, range.from, range.to, showTest) : null,
    [data, range.from, range.to, showTest, valid],
  );
  const candidates = useMemo(
    () =>
      data
        ? [
            ...data.tenants
              .filter((t) => !t.is_test && t.test_reasons.length)
              .map((t) => ({
                key: `tenant:${t.id}`,
                name: t.display_name,
                email: data.users.find((u) => u.id === t.owner_id)?.email,
                reasons: t.test_reasons,
              })),
          ]
        : [],
    [data],
  );
  const rows = useMemo(() => {
    if (!data || !view) return [];
    const q = search.trim().toLowerCase();
    const list = view.tenants.filter((t) => {
      const u = view.peopleById.get(t.owner_id ?? "");
      return (
        (!plan || t.tier === plan) &&
        tenantMatchesCard(
          t,
          card,
          data,
          range.from,
          range.to,
          view.active,
          view.people,
        ) &&
        (!q ||
          [
            t.display_name,
            t.slug,
            t.source?.source,
            u?.name,
            u?.email,
            t.added_url,
            ...t.built_urls,
          ].some((s) => s?.toLowerCase().includes(q)))
      );
    });
    const ranks: Record<string, number> = {
      free: 0,
      starter: 1,
      growth: 2,
      pro: 3,
    };
    return list.sort((a, b) =>
      sort === "name"
        ? a.display_name.localeCompare(b.display_name)
        : sort === "active"
          ? (b.last_active_at ?? "").localeCompare(a.last_active_at ?? "")
          : sort === "plan"
            ? (ranks[b.tier] ?? 0) - (ranks[a.tier] ?? 0)
            : (
                view.peopleById.get(b.owner_id ?? "")?.signup_at ?? b.created_at
              ).localeCompare(
                view.peopleById.get(a.owner_id ?? "")?.signup_at ??
                  a.created_at,
              ),
    );
  }, [data, view, search, plan, sort, card, range]);
  const unassigned =
    data && view
      ? view.people.filter(
          (u) =>
            !u.tenant_ids.length &&
            personMatchesCard(
              u,
              card,
              data,
              range.from,
              range.to,
              view.active,
            ) &&
            (!search ||
              [u.name, u.email].some((x) =>
                x?.toLowerCase().includes(search.toLowerCase()),
              )) &&
            (!plan || plan === "free"),
        )
      : [];
  const visibleKeys = review
    ? candidates.map((c) => c.key)
    : rows.map((r) => `tenant:${r.id}`);
  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  async function classify() {
    if (reviewDialog === null || reason.trim().length < 3) return;
    setSaving(true);
    setError(null);
    setMessage("");
    let done = 0;
    try {
      for (const subject_type of ["tenant", "user"]) {
        const ids = [...selected]
          .filter((k) => k.startsWith(subject_type + ":"))
          .map((k) => k.split(":")[1]);
        for (let offset = 0; offset < ids.length; offset += 200) {
          const res = await adminApiFetch(
            "/api/admin/tenants-growth/classify",
            {
              method: "POST",
              body: JSON.stringify({
                subject_type,
                ids: ids.slice(offset, offset + 200),
                is_test: reviewDialog,
                reason: reason.trim(),
              }),
            },
          );
          const body = await res.json();
          if (!res.ok)
            throw Error(
              body.error?.message ?? "Could not save classifications.",
            );
          done += body.updated;
        }
      }
      setMessage(`${done} account classifications saved.`);
      setReviewDialog(null);
      setReason("");
      setSelected(new Set());
    } catch (e) {
      setError(`${done ? `${done} saved. ` : ""}${(e as Error).message}`);
    } finally {
      setSaving(false);
      setRevision((n) => n + 1);
    }
  }
  function exportCandidates() {
    const csv = [
      ["Type", "ID", "Workspace / person", "Email", "Reasons"],
      ...candidates.map((c) => [
        c.key.split(":")[0],
        c.key.split(":")[1],
        c.name,
        c.email ?? "",
        c.reasons.join("; "),
      ]),
    ]
      .map((row) =>
        row
          .map(
            (value) =>
              '"' +
              (/^[=+\-@\t\r]/.test(value) ? "'" : "") +
              value.replaceAll('"', '""') +
              '"',
          )
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `test-account-proposal-${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  const disabled = loading || saving;
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-[1250px] gap-5 p-4 md:p-6">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-rose-700">
          Zavi · admin
        </p>
        <h1 className="mt-1 text-3xl font-semibold">Tenants</h1>
        <p className="mt-2 text-sm text-slate-500">
          Who signed up, what they pay for, what they connected, and whether we
          are growing.
        </p>
      </header>
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label="Date filters"
      >
        {[
          ["1", "Today"],
          ["7", "7d"],
          ["30", "30d"],
          ["90", "90d"],
          ["month", "This month"],
        ].map(([value, label]) => {
          const r = presetRange(value, today);
          return (
            <button
              key={value}
              className={control}
              aria-pressed={range.from === r.from && range.to === r.to}
              onClick={() => setRange(r)}
            >
              {label}
            </button>
          );
        })}
        <label className="text-sm">
          From{" "}
          <input
            aria-label="From date"
            className={control}
            type="date"
            max={today}
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </label>
        <label className="text-sm">
          To{" "}
          <input
            aria-label="To date"
            className={control}
            type="date"
            max={today}
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </label>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showTest}
            onChange={(e) => {
              setShowTest(e.target.checked);
              setSelected(new Set());
            }}
          />
          Show test workspaces{view ? ` (${view.hidden} hidden)` : ""}
        </label>
      </div>
      {!valid && (
        <p role="alert" className="text-sm text-red-700">
          Choose valid dates ending no later than today, up to ten years.
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}{" "}
          <button
            className="underline"
            onClick={() => setRevision((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm text-emerald-700">
          {message}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-slate-500">
          Loading growth data…
        </p>
      )}
      {data && view && (
        <div
          aria-busy={loading}
          className={`grid min-w-0 gap-5 ${loading ? "pointer-events-none opacity-50" : ""}`}
        >
          {data.sources_available === false && (
            <p role="status" className="text-sm text-amber-800">
              Signup sources could not be loaded. Other tenant details are
              available.{" "}
              <button
                className="underline"
                onClick={() => setRevision((n) => n + 1)}
              >
                Retry sources
              </button>
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(
              [
                [
                  "active",
                  "Active users today",
                  view.cards.active,
                  `${delta(view.cards.active, view.cards.activePrevious)} vs yesterday`,
                ],
                [
                  "today",
                  "New signups today",
                  view.cards.today,
                  `${delta(view.cards.today, view.cards.todayPrevious)} vs same day last week`,
                ],
                [
                  "range",
                  "Signups in range",
                  view.cards.range,
                  `${delta(view.cards.range, view.cards.rangePrevious)} vs previous period`,
                ],
                [
                  "paid",
                  "On a paid plan",
                  view.cards.paid,
                  `Starter ${view.paid.starter} · Growth ${view.paid.growth} · Pro ${view.paid.pro} · ${view.comps} comped (excluded)`,
                ],
              ] as const
            ).map(([key, label, value, sub]) => (
              <button
                key={key}
                disabled={disabled}
                onClick={() => setCard(card === key ? null : key)}
                aria-pressed={card === key}
                className={`rounded-xl border bg-white p-4 text-left ${card === key ? "border-rose-500 ring-1 ring-rose-200" : "border-slate-200"}`}
              >
                <span className="block text-sm text-slate-600">{label}</span>
                <span className="my-2 block text-3xl font-semibold tabular-nums">
                  {value}
                </span>
                <span className="text-xs text-slate-500">{sub}</span>
              </button>
            ))}
          </div>
          <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">
                {metric === "signups" ? "New signups" : "Active users"} per day
              </h2>
              <div className="flex flex-wrap gap-2">
                {(["signups", "active"] as const).map((m) => (
                  <button
                    className={control}
                    key={m}
                    aria-pressed={metric === m}
                    onClick={() => setMetric(m)}
                  >
                    {m === "active" ? "Active users" : "Signups"}
                  </button>
                ))}
                {(["bar", "line"] as const).map((t) => (
                  <button
                    key={t}
                    className={`${control} capitalize`}
                    aria-pressed={chartType === t}
                    onClick={() => setChartType(t)}
                  >
                    {t === "bar" ? "Bar" : "Line"}
                  </button>
                ))}
              </div>
            </div>
            <GrowthChart rows={view.chart} metric={metric} type={chartType} />
            {metric === "active" &&
              range.from < istDate(data.tracking_started_at) && (
                <p className="mt-2 text-xs text-amber-800">
                  Daily sign-in tracking began{" "}
                  {shortDate(data.tracking_started_at)}. Earlier days include
                  saved messages and the last known sign-in; earlier sign-ins
                  may be missing.
                </p>
              )}
          </section>
          {candidates.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
              <span>
                {candidates.length} suggested test classifications await review.
                Existing accounts remain visible until confirmed.
              </span>
              <button
                className="font-medium underline"
                onClick={() => {
                  setReview(!review);
                  setSelected(new Set());
                }}
              >
                {review ? "Back to workspaces" : "Review suggested accounts"}
              </button>
              <button className="underline" onClick={exportCandidates}>
                Export proposal for Ravi
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${control} min-w-[180px] flex-1`}
              type="search"
              aria-label="Search tenants"
              placeholder="Search name, email, workspace, site, source"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className={control}
              aria-label="Plan filter"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
            >
              <option value="">All plans</option>
              {["free", "starter", "growth", "pro"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              className={control}
              aria-label="Sort workspaces"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="signup">Newest signup</option>
              <option value="active">Recently active</option>
              <option value="plan">Plan (Pro first)</option>
              <option value="name">Name A–Z</option>
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={usage}
                onChange={(e) => setUsage(e.target.checked)}
              />
              Usage columns
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              {review
                ? `${candidates.length} proposed classifications`
                : `${rows.length} workspaces`}
            </span>
            {card && (
              <button
                className="text-rose-700 underline"
                onClick={() => setCard(null)}
              >
                Clear card filter
              </button>
            )}
            <span className="ml-auto">{selected.size} selected</span>
            <button
              className={control}
              disabled={!selected.size || disabled}
              onClick={() => setReviewDialog(true)}
            >
              Mark as test
            </button>
            <button
              className={control}
              disabled={!selected.size || disabled}
              onClick={() => setReviewDialog(false)}
            >
              Mark as real
            </button>
          </div>
          <div
            className="max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white"
            tabIndex={0}
            role="region"
            aria-label={
              review ? "Suggested test workspaces" : "Workspace table"
            }
          >
            <table className="w-full whitespace-nowrap text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="p-3">
                    <input
                      type="checkbox"
                      aria-label="Select all visible accounts"
                      checked={
                        visibleKeys.length > 0 &&
                        visibleKeys.every((k) => selected.has(k))
                      }
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? new Set(visibleKeys) : new Set(),
                        )
                      }
                    />
                  </th>
                  {(review
                    ? ["Workspace / person", "Email", "Suggested reason"]
                    : [
                        "Person",
                        "Signup source",
                        "Plan",
                        "Plan start",
                        "Plan end",
                        "Last active",
                        "Integrations",
                        "Socials",
                        "Website",
                        "Country",
                        "City",
                        ...(usage
                          ? ["Runs", "Messages", "Success rate", "Cost"]
                          : []),
                      ]
                  ).map((title) => (
                    <th className="p-3 font-medium" key={title}>
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {review
                  ? candidates.map((c) => (
                      <tr key={c.key} className="border-t border-slate-100">
                        <td className="p-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${c.name}`}
                            checked={selected.has(c.key)}
                            onChange={() => toggle(c.key)}
                          />
                        </td>
                        <td className="p-3">
                          {c.name}
                          <span className="ml-2 text-xs text-slate-400">
                            {c.key.startsWith("user:") ? "person" : "workspace"}
                          </span>
                        </td>
                        <td className="p-3">{c.email ?? "—"}</td>
                        <td className="p-3">{c.reasons.join(", ")}</td>
                      </tr>
                    ))
                  : rows.map((t) => {
                      const u = view.peopleById.get(t.owner_id ?? "");
                      const tags = connectionTags(t);
                      const usageRow = data.usage?.find(
                        (x) => x.tenant_id === t.id,
                      );
                      const stale =
                        t.last_active_at &&
                        Date.now() - Date.parse(t.last_active_at) >
                          7 * 86400000;
                      return (
                        <tr
                          key={t.id}
                          className="cursor-pointer border-t border-slate-100 align-top hover:bg-slate-50"
                          onClick={(e) => {
                            if (
                              !rowClickOpensTenant(
                                e.target as Element,
                                window.getSelection()?.toString() ?? "",
                              )
                            )
                              return;
                            const href = `/tenants/${t.id}`;
                            if (e.metaKey || e.ctrlKey)
                              window.open(href, "_blank");
                            else window.location.assign(href);
                          }}
                        >
                          <td className="p-3">
                            <input
                              type="checkbox"
                              aria-label={`Select ${t.display_name}`}
                              checked={selected.has(`tenant:${t.id}`)}
                              onChange={() => toggle(`tenant:${t.id}`)}
                            />
                          </td>
                          <td className="p-3">
                            <a
                              href={`/tenants/${t.id}`}
                              className="font-medium underline decoration-slate-300 underline-offset-2 hover:text-rose-700"
                            >
                              {u?.name ?? u?.email ?? "Unknown owner"}
                            </a>
                            {t.is_test && (
                              <span className="ml-2">
                                <Tag>TEST</Tag>
                              </span>
                            )}
                            <p className="text-xs text-slate-500">
                              {u?.email ?? "—"}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              <a
                                href={`/tenants/${t.id}`}
                                className="hover:text-rose-700 hover:underline"
                              >
                                {t.display_name}
                              </a>
                              {t.owner_count > 1
                                ? ` · ${t.owner_count} owners`
                                : ""}
                            </p>
                          </td>
                          <td className="p-3">
                            {t.source?.kind === "affiliate" &&
                            t.source.creator_id ? (
                              <a
                                className="text-sky-700 hover:underline"
                                href={`/creator-network/creators/${encodeURIComponent(t.source.creator_id)}`}
                              >
                                {t.source.source}{" "}
                                <span className="text-xs text-slate-500">
                                  (affiliate)
                                </span>
                              </a>
                            ) : (
                              <span>
                                {t.source?.source ?? "Source unavailable"}
                              </span>
                            )}
                            {t.source?.kind === "from" && (
                              <p className="text-xs text-slate-500">
                                Channel code
                              </p>
                            )}
                            {t.source_detail && (
                              <p className="max-w-56 whitespace-normal text-xs text-slate-500">
                                {t.source_detail}
                              </p>
                            )}
                          </td>
                          <td className="p-3">
                            <span className="capitalize">{t.tier}</span>
                            {t.is_comp && t.tier !== "free" && (
                              <span className="ml-1">
                                <Tag>comp</Tag>
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-xs">
                            {t.tier === "free" ? "—" : shortDate(t.plan_start)}
                          </td>
                          <td
                            className={`p-3 text-xs ${t.cancels || t.is_comp ? "text-amber-700" : ""}`}
                          >
                            {t.tier === "free" || !t.plan_end
                              ? "—"
                              : `${t.cancels || t.is_comp ? "ends" : "renews"} ${shortDate(t.plan_end)}`}
                          </td>
                          <td
                            className={`p-3 ${stale ? "text-red-700" : "text-slate-600"}`}
                            title={t.last_active_at ?? undefined}
                          >
                            {relativeTime(t.last_active_at)}
                          </td>
                          <td className="p-3">
                            <div className="flex max-w-56 flex-wrap gap-1">
                              {tags.integrations.length
                                ? tags.integrations.map((k) => (
                                    <Tag key={k}>{k}</Tag>
                                  ))
                                : "—"}
                            </div>
                          </td>
                          <td className="p-3">
                            <div className="flex max-w-48 flex-wrap gap-1">
                              {tags.socials.length
                                ? tags.socials.map((k) => (
                                    <Tag key={k}>{k}</Tag>
                                  ))
                                : "—"}
                            </div>
                          </td>
                          <td className="p-3 text-xs">
                            <Website label="Added" url={t.added_url} />
                            {t.built_urls.map((url) => (
                              <Website key={url} label="Built" url={url} />
                            ))}
                            {!safeWebsite(t.added_url) &&
                              !t.built_urls.some(safeWebsite) &&
                              "—"}
                          </td>
                          <td className="p-3">{u?.country ?? "—"}</td>
                          <td className="p-3">{u?.city ?? "—"}</td>
                          {usage && (
                            <>
                              <td className="p-3">{usageRow?.runs ?? "—"}</td>
                              <td className="p-3">
                                {usageRow?.user_messages ?? "—"}
                              </td>
                              <td className="p-3">
                                {usageRow?.ok_rate != null
                                  ? `${Math.round(usageRow.ok_rate * 100)}%`
                                  : "—"}
                              </td>
                              <td className="p-3">
                                {usageRow
                                  ? `$${Number(usageRow.cost_usd).toFixed(2)}`
                                  : "—"}
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                {!visibleKeys.length && (
                  <tr>
                    <td
                      className="p-8 text-center text-slate-500"
                      colSpan={review ? 4 : usage ? 16 : 12}
                    >
                      No accounts match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!review && unassigned.length > 0 && (
            <details className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <summary className="cursor-pointer">
                {unassigned.length}{" "}
                {unassigned.length === 1 ? "signup" : "signups"} without a
                workspace (included in signup and active-user totals)
              </summary>
              <ul className="mt-3 grid gap-2">
                {unassigned.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {u.name ?? u.email ?? "Unknown person"} · {u.email} ·{" "}
                      {shortDate(u.signup_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <footer className="flex flex-wrap justify-between gap-2 text-xs text-slate-500">
            <span>
              One row per workspace. Signup/activity totals count people once;
              paid-plan totals count workspaces and exclude comps.
            </span>
            <span>All times in IST</span>
          </footer>
        </div>
      )}
      {reviewDialog !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !saving) setReviewDialog(null);
          }}
        >
          <DialogContent>
            <DialogTitle>
              Mark {selected.size} workspaces as{" "}
              {reviewDialog ? "test" : "real"}
            </DialogTitle>
            <DialogDescription>
              This changes growth reporting only. Accounts are not deleted. For
              the existing-account cleanup, confirm Ravi has reviewed the
              proposal before saving. Only workspaces marked test are hidden.
            </DialogDescription>
            <label className="mt-4 block text-sm">
              Review reason
              <input
                autoFocus
                className={`${control} mt-1 w-full`}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Who reviewed this and why?"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className={control}
                disabled={saving}
                onClick={() => setReviewDialog(null)}
              >
                Cancel
              </button>
              <button
                className="rounded-md bg-rose-700 px-3 py-2 text-sm text-white disabled:opacity-50"
                disabled={saving || reason.trim().length < 3}
                onClick={() => void classify()}
              >
                {saving ? "Saving…" : "Confirm classification"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
