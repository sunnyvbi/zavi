"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

type Draft = {
  engine: "mongodb" | "postgres" | "mysql";
  booking_source: string;
  date_field: string;
  status_field: string | null;
  completed_statuses: string[];
  revenue_field: string | null;
  refund_field: string | null;
  refund_basis: "none" | "booking_created_net" | "refund_event_day";
  currency: string | null;
  reporting_timezone: string;
  amount_unit: "dollars" | "cents";
};

const EMPTY: Draft = {
  engine: "postgres",
  booking_source: "",
  date_field: "",
  status_field: null,
  completed_statuses: [],
  revenue_field: null,
  refund_field: null,
  refund_basis: "none",
  currency: null,
  reporting_timezone: "UTC",
  amount_unit: "dollars",
};

type BookingConfigResponse = {
  config: Draft | null;
  proposed: Draft | null;
  detecting?: boolean;
};

const POLL_MS = 3500;
const MAX_POLLS = 10;

export function BookingConfigConfirm({ onConfirmed }: { onConfirmed?: () => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const touched = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;

    const load = async () => {
      try {
        const url =
          polls === 0
            ? "/api/agents/performance-marketer/booking-config"
            : "/api/agents/performance-marketer/booking-config?poll=1";
        const res = await apiFetch(url);
        const json = (await res.json()) as BookingConfigResponse;
        if (!alive) return;
        const src = json.config ?? json.proposed;
        if (src && !touched.current) setDraft({ ...EMPTY, ...src });
        const stillDetecting = !!json.detecting && !json.config;
        const willPoll = stillDetecting && polls < MAX_POLLS;
        setDetecting(willPoll);
        if (willPoll) {
          polls += 1;
          timer = setTimeout(load, POLL_MS);
        }
      } catch {
        if (alive) setDetecting(false);
      } finally {
        if (alive) setLoading(false);
      }
    };

    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    touched.current = true;
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const submit = async () => {
    touched.current = true;
    setSaving(true);
    setMsg(null);
    try {
      const res = await apiFetch("/api/agents/performance-marketer/booking-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, confirm: true }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      }
      setMsg("Confirmed. Refresh to see your real bookings & MER.");
      onConfirmed?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-[13px] text-[#8a8a8a]">Loading your bookings mapping…</p>;
  }

  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <label className="flex flex-col gap-1 text-[12px] text-[#595959]">
      <span className="text-[14px] font-medium text-[#1f1f1f]">{label}</span>
      {node}
      {hint && <span className="text-[11px] text-[#8a8a8a]">{hint}</span>}
    </label>
  );
  const input = (k: keyof Draft, ph: string) => (
    <input
      type="text"
      value={(draft[k] as string) ?? ""}
      placeholder={ph}
      onChange={(e) => set(k, (e.target.value || null) as Draft[typeof k])}
      className="rounded-md border border-[#e5e7eb] px-2 py-1 text-[13px] text-[#1f1f1f] outline-none focus:border-[#235a97]"
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {detecting && (
        <div className="flex items-center gap-2 rounded-md bg-[#f2f6fb] px-3 py-2 text-[12px] text-[#235a97]">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[#235a97] border-t-transparent" />
          Detecting your bookings source from your connected database… the fields
          below will pre-fill automatically. You can also fill them in yourself.
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {field(
        "Database type",
        <select
          value={draft.engine}
          onChange={(e) => set("engine", e.target.value as Draft["engine"])}
          className="rounded-md border border-[#e5e7eb] px-2 py-1 text-[13px]"
        >
          <option value="postgres">Postgres</option>
          <option value="mongodb">MongoDB</option>
          <option value="mysql">MySQL</option>
        </select>,
      )}
      {field("Bookings table / collection", input("booking_source", "e.g. trips"))}
      {field("Booking date field", input("date_field", "e.g. createdAt"))}
      {field("Status field", input("status_field", "e.g. status"), "leave blank to count every row")}
      {field(
        "Completed statuses",
        <input
          type="text"
          value={draft.completed_statuses.join(", ")}
          placeholder="completed, confirmed, finished"
          onChange={(e) =>
            set(
              "completed_statuses",
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          className="rounded-md border border-[#e5e7eb] px-2 py-1 text-[13px]"
        />,
        "comma-separated values that count as a completed booking",
      )}
      {field("Revenue field", input("revenue_field", "e.g. totalAmount"), "leave blank for count-only (no MER)")}
      {field(
        "Revenue unit",
        <select
          value={draft.amount_unit}
          onChange={(e) => set("amount_unit", e.target.value as Draft["amount_unit"])}
          className="rounded-md border border-[#e5e7eb] px-2 py-1 text-[13px]"
        >
          <option value="dollars">Dollars (e.g. 49.99)</option>
          <option value="cents">Cents / minor units (e.g. 4999)</option>
        </select>,
        "pick cents if the field stores minor units; we divide by 100",
      )}
      {field("Refund field", input("refund_field", "e.g. refundAmount"))}
      {field(
        "Refund handling",
        <select
          value={draft.refund_basis}
          onChange={(e) => set("refund_basis", e.target.value as Draft["refund_basis"])}
          className="rounded-md border border-[#e5e7eb] px-2 py-1 text-[13px]"
        >
          <option value="none">Don&apos;t subtract refunds</option>
          <option value="booking_created_net">Net of refund (on booking day)</option>
          <option value="refund_event_day">Refund on its own day (not yet supported)</option>
        </select>,
      )}
      {field("Currency (ISO)", input("currency", "USD"), "MER needs USD; other currencies show bookings only")}
      {field("Reporting timezone", input("reporting_timezone", "UTC"))}

      <div className="col-span-full flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={saving || !draft.booking_source || !draft.date_field}
          className="cursor-pointer rounded-cta bg-[#1f1f1f] px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-black disabled:opacity-50"
        >
          {saving ? "Confirming…" : "Confirm bookings source"}
        </button>
        {msg && <span className="text-[12px] text-[#595959]">{msg}</span>}
      </div>
      </div>
    </div>
  );
}
