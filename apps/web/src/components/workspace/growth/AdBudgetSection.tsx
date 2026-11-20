"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { BusinessControls } from "./BusinessControls";
import { announceAdBudgetChange } from "./adBudgetEvents";

type Platform = "meta" | "google" | "chatgpt" | "reddit" | "x" | "tiktok" | "linkedin";
type HeldObject = { platform: Platform; object_id: string; label?: string };
export type AdBudget = {
  id: string;
  status: "active" | "stopped";
  monthly_usd: number;
  daily_limit_usd: number | null;
  started_on: string;
  month_cap_usd: number;
  spent_usd: number;
  held_usd: number;
  left_usd: number;
  month_start: string;
  next_month_start: string;
  days_left: number;
  days_in_month: number;
  stopped_at: string | null;
  still_running: HeldObject[];
};
type Snapshot = { budget: AdBudget | null; can_manage: boolean; pro: boolean };
export type LedgerRow = {
  at: string;
  kind: "event" | "hold" | "hand" | "change" | "outside";
  date: string | null;
  action: string;
  amount_usd: number | null;
  amount_label: string | null;
  result: string;
  source: "cgo" | "person" | "automation" | "channel" | "outside";
  by?: string;
  undo?: { change_id: string; change: string } | null;
};
type StopReply = {
  status?: string;
  paused?: Array<{ platform: Platform; object_id: string }>;
  failed?: Array<HeldObject & { reason?: string }>;
  error?: { message?: string };
};

const PRO_LINE = "Ad budgets are on the Pro plan.";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

export function dateLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : ymd;
}
export function dayMonth(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : ymd;
}
export function dateTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
export const ledgerWhen = (r: Pick<LedgerRow, "at" | "kind" | "date">) =>
  r.kind === "hand" ? dateLabel(r.date ?? r.at) : dateTimeLabel(r.at);

const MAX_MONTHLY_USD = 10_000_000;
export const BUDGET_MESSAGES = {
  monthlyMissing: "Enter a monthly amount in dollars.",
  monthlyMin: "The monthly budget must be at least $1.",
  monthlyMax: "The monthly budget must be less than $10,000,000.",
  dailyMin: "The daily limit must be at least $1, or left empty.",
  dailyOverMonthly: "The daily limit can't be more than the monthly amount.",
} as const;
const toCents = (n: number) => Math.round(n * 100) / 100;

export function parseAmount(raw: string): number {
  const t = raw.trim().replace(/^\$\s*/, "");
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d*)?$/.test(t) || !/\d/.test(t)) return Number.NaN;
  return Number(t.replace(/,/g, ""));
}

export function monthlyError(raw: string): string | null {
  if (raw.trim() === "") return null;
  const n = parseAmount(raw);
  if (!Number.isFinite(n)) return BUDGET_MESSAGES.monthlyMissing;
  if (toCents(n) < 1) return BUDGET_MESSAGES.monthlyMin;
  if (toCents(n) >= MAX_MONTHLY_USD) return BUDGET_MESSAGES.monthlyMax;
  return null;
}

export function budgetFormError(monthlyRaw: string, dailyRaw: string): string | null {
  if (monthlyRaw.trim() === "") return BUDGET_MESSAGES.monthlyMissing;
  const m = monthlyError(monthlyRaw);
  if (m) return m;
  if (dailyRaw.trim() === "") return null;
  const d = parseAmount(dailyRaw);
  if (!Number.isFinite(d) || toCents(d) < 1) return BUDGET_MESSAGES.dailyMin;
  if (toCents(d) > toCents(parseAmount(monthlyRaw))) return BUDGET_MESSAGES.dailyOverMonthly;
  return null;
}

const utcToday = () => new Date().toISOString().slice(0, 10);

export function monthPlan(monthly: number, startedOn: string, today: string) {
  const [y, m] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const startedThisMonth = startedOn.slice(0, 7) === today.slice(0, 7);
  const daysLeft = startedThisMonth ? daysInMonth - Number(startedOn.slice(8, 10)) + 1 : daysInMonth;
  const cap = startedThisMonth ? Math.floor((Math.round(monthly * 100) * daysLeft) / daysInMonth) / 100 : monthly;
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { cap, daysLeft, daysInMonth, next, prorated: startedThisMonth && daysLeft < daysInMonth };
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function monthLine(b: Pick<AdBudget, "monthly_usd" | "month_cap_usd" | "spent_usd" | "held_usd" | "month_start" | "next_month_start" | "days_left">): string {
  const name = MONTH_NAMES[Number(b.month_start.slice(5, 7)) - 1] ?? "This month";
  const prorated = b.month_cap_usd < b.monthly_usd;
  let out = `${name}: ${money(b.spent_usd)} spent of ${money(b.month_cap_usd)}`;
  out += prorated ? ` (prorated, ${b.days_left} ${b.days_left === 1 ? "day" : "days"} left).` : ".";
  if (b.held_usd > 0) out += ` ${money(b.held_usd)} set aside for budget Zavi added.`;
  if (prorated) out += ` Full ${money(b.monthly_usd)} from ${dayMonth(b.next_month_start)}.`;
  return out;
}

export function planLine(monthly: number, startedOn: string, today: string): string {
  const p = monthPlan(monthly, startedOn, today);
  if (!p.prorated) return `This month: ${money(p.cap)}. From ${dayMonth(p.next)}: ${money(monthly)}/month.`;
  return `This month: ${money(p.cap)} (${p.daysLeft} of ${p.daysInMonth} days left). From ${dayMonth(p.next)}: ${money(monthly)}/month.`;
}
const PLATFORM_OBJECT: Record<Platform, string> = {
  meta: "Meta ad set",
  google: "Google campaign",
  chatgpt: "ChatGPT campaign",
  reddit: "Reddit ad group",
  x: "X Ads campaign",
  tiktok: "TikTok ad group",
  linkedin: "LinkedIn campaign",
};
const objectName = (o: HeldObject) =>
  o.label ?? (o.platform === "linkedin" ? PLATFORM_OBJECT.linkedin : `${PLATFORM_OBJECT[o.platform] ?? "Ad"} ${o.object_id}`);

export function stopFailedNotice(failed: Array<HeldObject & { reason?: string }>): string {
  const lines = failed.map((f) => `${objectName(f)}: ${f.reason ?? "Pause it in the ad platform, or press Stop again."}`);
  return `Stopped. No new ad spend will be held. ${failed.length === 1 ? "This could not be paused yet and still holds money" : "These could not be paused yet and still hold money"}. ${lines.join(" ")}`;
}
const SOURCE: Record<LedgerRow["source"], string> = {
  cgo: "Autopilot",
  person: "A teammate",
  automation: "Automatic",
  channel: "A channel",
  outside: "Outside Zavi",
};
export const ledgerBy = (r: Pick<LedgerRow, "by" | "source">) => r.by ?? SOURCE[r.source];

export function stoppedNotice(paused: number): string {
  if (paused === 0) return "Stopped. No ads were running.";
  return `Stopped. ${paused === 1 ? "1 ad" : `${paused} ads`} paused.`;
}
export const undoConfirm = (change: string) =>
  `Undo: ${change}. It goes through the same checks as any ad change, and one that turns spend back on counts against your ad budget.`;
export const UNDO_SENT = "Undo approved. It shows in the ledger once it has gone through.";

export const STOP_CONFIRM =
  "Stop the ad budget? This pauses every ad it turned on, and Autopilot will ask you before any ad spend again.";

export const AD_BUDGET_ANCHOR = "ad-budget";

const BTN =
  "inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-cta border border-rule bg-cream px-4 text-[13px] font-semibold text-ink transition-colors hover:bg-creamDeep disabled:cursor-not-allowed disabled:opacity-60";
const BTN_PRIMARY =
  "inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-cta bg-ink px-4 text-[13px] font-semibold text-cream transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-80";
const INPUT =
  "h-11 w-full rounded-lg border border-rule bg-creamDeep px-3 text-[14px] text-ink placeholder:text-inkMuted focus:border-inkMuted focus:outline-none focus:ring-2 focus:ring-inkMuted";

type SaveReply = { budget_id?: unknown; month_cap_usd?: unknown };

export function savedBudget(
  prev: AdBudget | null,
  body: { monthly_usd: number; daily_limit_usd: number | null },
  reply: SaveReply,
  today: string,
): AdBudget | null {
  const replyCap = typeof reply.month_cap_usd === "number" && Number.isFinite(reply.month_cap_usd) && reply.month_cap_usd > 0 ? reply.month_cap_usd : null;
  if (prev && prev.status === "active") {
    const cap = replyCap ?? monthPlan(body.monthly_usd, prev.started_on, today).cap;
    return {
      ...prev,
      monthly_usd: body.monthly_usd,
      daily_limit_usd: body.daily_limit_usd,
      month_cap_usd: cap,
      left_usd: Math.max(0, toCents(cap - prev.spent_usd - prev.held_usd)),
    };
  }
  if (typeof reply.budget_id !== "string" || !reply.budget_id) return null;
  const plan = monthPlan(body.monthly_usd, today, today);
  const cap = replyCap ?? plan.cap;
  return {
    id: reply.budget_id,
    status: "active",
    monthly_usd: body.monthly_usd,
    daily_limit_usd: body.daily_limit_usd,
    started_on: today,
    month_cap_usd: cap,
    spent_usd: 0,
    held_usd: 0,
    left_usd: cap,
    month_start: `${today.slice(0, 8)}01`,
    next_month_start: plan.next,
    days_left: plan.daysLeft,
    days_in_month: plan.daysInMonth,
    stopped_at: null,
    still_running: [],
  };
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return j.error?.message ?? fallback;
}

function BudgetForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: AdBudget;
  submitLabel: string;
  onSubmit: (body: { monthly_usd: number; daily_limit_usd: number | null }) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [monthly, setMonthly] = useState(initial ? String(initial.monthly_usd) : "");
  const [daily, setDaily] = useState(initial?.daily_limit_usd != null ? String(initial.daily_limit_usd) : "");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const today = utcToday();
  const amount = parseAmount(monthly);
  const typedError = monthlyError(monthly);
  const preview = monthly.trim() !== "" && !typedError ? planLine(amount, initial?.started_on ?? today, today) : null;
  const error = serverError ?? (tried ? budgetFormError(monthly, daily) : null);

  const submit = async () => {
    if (inFlight.current) return;
    setTried(true);
    setServerError(null);
    if (budgetFormError(monthly, daily)) return;
    const d = daily.trim() === "" ? null : parseAmount(daily);
    inFlight.current = true;
    setBusy(true);
    try {
      const err = await onSubmit({ monthly_usd: amount, daily_limit_usd: d });
      if (err) setServerError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-3 space-y-3 rounded-xl border border-rule bg-cream p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <label className="block text-[13px] font-semibold text-ink">
          $ per month
          <input
            aria-label="$ per month"
            inputMode="decimal"
            value={monthly}
            onChange={(e) => {
              setMonthly(e.target.value);
              setServerError(null);
            }}
            placeholder="3,000"
            className={`mt-1.5 ${INPUT}`}
          />
        </label>
        <p
          data-testid="budget-plan-line"
          className={`mt-1.5 text-[13px] ${typedError ? "text-warn dark:text-marigold" : preview ? "font-semibold text-ink" : "text-inkMuted"}`}
          aria-live="polite"
        >
          {typedError ?? preview ?? "Runs every calendar month until you stop it. Unused money does not carry over."}
        </p>
      </div>
      <label className="block text-[13px] font-semibold text-ink">
        Daily limit (USD, optional)
        <input
          aria-label="Daily limit (USD, optional)"
          inputMode="decimal"
          value={daily}
          onChange={(e) => {
            setDaily(e.target.value);
            setServerError(null);
          }}
          placeholder="No daily limit"
          className={`mt-1.5 ${INPUT}`}
        />
      </label>
      {daily.trim() !== "" && (
        <p className="text-[12px] text-inkMuted">Some ad channels set aside more than a campaign&apos;s daily budget against this limit (ChatGPT Ads sets aside twice it), so leave some room.</p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-warn dark:text-marigold">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <button type="submit" disabled={busy} aria-busy={busy} className={BTN_PRIMARY}>
          {busy ? "Saving…" : submitLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={BTN}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function HumanActionForm({ budgetId, onLogged }: { budgetId: string; onLogged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(utcToday());
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`mt-3 ${BTN}`}>
        Log a human action
      </button>
    );
  }
  const submit = async () => {
    if (inFlight.current) return;
    const a = amount.trim() === "" ? null : parseAmount(amount);
    if (!note.trim()) return setError("Describe what you changed.");
    if (a !== null && (!Number.isFinite(a) || a < 0)) return setError("The amount must be $0 or more, or left empty.");
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/ad-budget/${budgetId}/human-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ occurred_at: date, note: note.trim(), amount_usd: a }),
        idempotent: true,
      });
      if (!res.ok) {
        setError(await errorOf(res, "Could not save that. Try again."));
        return;
      }
      setNote("");
      setAmount("");
      setOpen(false);
      await onLogged();
    } catch {
      setError("Could not save that. Try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    set(e.target.value);
    setError(null);
  };
  return (
    <form
      className="mt-3 space-y-2 rounded-xl border border-rule p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-[13px] text-inkSoft">For a change you made outside Zavi, such as in Meta Ads Manager.</p>
      <input aria-label="Date" type="date" value={date} onChange={edit(setDate)} className={INPUT} />
      <input aria-label="What you changed" maxLength={500} value={note} onChange={edit(setNote)} placeholder="Raised the Spring ad set to $80 a day" className={INPUT} />
      <input aria-label="Amount (USD, optional)" inputMode="decimal" value={amount} onChange={edit(setAmount)} placeholder="Amount (USD, optional)" className={INPUT} />
      {error && (
        <p role="alert" className="text-[13px] text-warn dark:text-marigold">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {busy ? "Saving…" : "Log it"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={BTN}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Ledger({ budgetId, canLog, canUndo }: { budgetId: string | null; canLog: boolean; canUndo: boolean }) {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<{ change_id: string; change: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const undoInFlight = useRef(false);
  const [undoNote, setUndoNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/ad-budget/ledger");
      if (!res.ok) throw new Error("ledger");
      const j = (await res.json()) as { rows?: LedgerRow[] };
      setRows(j.rows ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const approveUndo = async (u: { change_id: string; change: string }) => {
    if (undoInFlight.current) return;
    undoInFlight.current = true;
    setUndoing(true);
    setUndoNote(null);
    try {
      const staged = await apiFetch(`/api/workspace/ad-budget/changes/${u.change_id}/undo`, { method: "POST" });
      const j = (await staged.json().catch(() => ({}))) as { decision_id?: string; error?: { message?: string } };
      if (!staged.ok || !j.decision_id) {
        setUndoNote({ ok: false, text: j.error?.message ?? "Could not set up the undo. Try again." });
        return;
      }
      const approved = await apiFetch(`/api/approvals/${j.decision_id}/approve`, { method: "POST" });
      if (!approved.ok) {
        setUndoNote({ ok: false, text: "The undo is waiting in your approvals: it could not be confirmed from here." });
        return;
      }
      setConfirming(null);
      setUndoNote({ ok: true, text: UNDO_SENT });
      await load();
    } catch {
      setUndoNote({ ok: false, text: "Could not set up the undo. Try again." });
    } finally {
      undoInFlight.current = false;
      setUndoing(false);
    }
  };
  const undoButton = (r: LedgerRow) =>
    canUndo && r.undo ? (
      <button
        type="button"
        onClick={() => {
          setUndoNote(null);
          setConfirming(r.undo ?? null);
        }}
        className="mt-1 rounded-cta border border-rule px-2 py-0.5 text-[12px] font-semibold text-ink hover:bg-creamDeep"
      >
        Undo
      </button>
    ) : null;

  return (
    <div className="mt-3 rounded-xl border border-rule p-3" aria-label="Ad budget ledger">
      <p className="text-[12px] text-inkMuted">Private to your workspace.</p>
      {confirming && (
        <div className="mt-2 rounded-lg border border-rule bg-creamDeep p-2.5" role="group" aria-label="Confirm undo">
          <p className="text-[13px] text-ink">{undoConfirm(confirming.change)}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={undoing} onClick={() => void approveUndo(confirming)} className={BTN_PRIMARY}>
              {undoing ? "Approving…" : "Approve undo"}
            </button>
            <button type="button" disabled={undoing} onClick={() => setConfirming(null)} className={BTN}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {undoNote && (
        <p role={undoNote.ok ? "status" : "alert"} className={`mt-2 text-[13px] ${undoNote.ok ? "text-inkSoft" : "text-warn dark:text-marigold"}`}>
          {undoNote.text}
        </p>
      )}
      {failed ? (
        <p className="mt-2 text-[13px] text-inkMuted">Couldn&apos;t load the ledger.</p>
      ) : rows === null ? (
        <p className="mt-2 text-[13px] text-inkMuted" aria-busy="true">
          Loading the ledger…
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-inkMuted">Nothing yet.</p>
      ) : (
        <>
          {}
          <ul className="mt-2 divide-y divide-rule sm:hidden" aria-label="Ledger rows">
            {rows.map((r, i) => (
              <li key={i} className="py-2 text-[13px] text-inkSoft">
                <p className="break-words text-ink [overflow-wrap:anywhere]">{r.action}</p>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <dt className="text-inkMuted">When</dt>
                  <dd>{ledgerWhen(r)}</dd>
                  {r.amount_label && (
                    <>
                      <dt className="text-inkMuted">Amount</dt>
                      <dd className="break-words [overflow-wrap:anywhere]">{r.amount_label}</dd>
                    </>
                  )}
                  <dt className="text-inkMuted">Result</dt>
                  <dd>{r.result}</dd>
                  <dt className="text-inkMuted">By</dt>
                  <dd>{ledgerBy(r)}</dd>
                </dl>
                {undoButton(r)}
              </li>
            ))}
          </ul>
          <div className="mt-2 hidden overflow-x-auto sm:block">
          <table className="w-full text-left text-[13px] text-inkSoft">
            <thead className="text-[11px] uppercase tracking-[0.06em] text-inkMuted">
              <tr>
                <th className="py-1 pr-3 font-semibold">When</th>
                <th className="py-1 pr-3 font-semibold">Action</th>
                <th className="py-1 pr-3 font-semibold">Amount</th>
                <th className="py-1 pr-3 font-semibold">Result</th>
                <th className="py-1 font-semibold">By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-rule align-top">
                  <td className="whitespace-nowrap py-1.5 pr-3">{ledgerWhen(r)}</td>
                  <td className="py-1.5 pr-3 text-ink">
                    <span className="break-words [overflow-wrap:anywhere]">{r.action}</span>
                    {undoButton(r) && <div>{undoButton(r)}</div>}
                  </td>
                  <td className="py-1.5 pr-3">{r.amount_label ?? ""}</td>
                  <td className="py-1.5 pr-3">{r.result}</td>
                  <td className="py-1.5">{ledgerBy(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
      {canLog && budgetId && <HumanActionForm budgetId={budgetId} onLogged={load} />}
    </div>
  );
}

export type AdHold = { name: string | null; from_usd: number | null; to_usd: number | null; words: string };

const holdUsd = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;

export function holdsLine(holds: readonly AdHold[]): string | null {
  if (holds.length === 0) return null;
  const parts = holds.map((h) => {
    const amounts = h.from_usd !== null && h.to_usd !== null ? ` ${holdUsd(h.from_usd)} → ${holdUsd(h.to_usd)}` : "";
    return `${h.name ?? "an ad"}${amounts} (${h.words})`;
  });
  return `Holding ${holds.length} raise${holds.length === 1 ? "" : "s"}: ${parts.join(" · ")}`;
}

function useAdHolds(enabled: boolean): AdHold[] | null {
  const [holds, setHolds] = useState<AdHold[] | null>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = async () => {
      try {
        const res = await apiFetch("/api/workspace/growth/ad-holds");
        if (!res.ok) throw new Error("read");
        const body = (await res.json()) as { holds?: AdHold[] };
        if (live) setHolds(Array.isArray(body.holds) ? body.holds : []);
      } catch {
        if (live) setHolds(null);
      }
    };
    void read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [enabled]);
  return holds;
}

export function AdBudgetSection({
  initial,
  variant = "card",
  onChanged,
}: {
  initial?: Snapshot;
  onChanged?: () => void;
  variant?: "card" | "story";
} = {}) {
  const [snap, setSnap] = useState<Snapshot | null>(initial ?? null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<"view" | "setup" | "edit" | "confirm-stop">("view");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [businessOpen, setBusinessOpen] = useState(false);
  useEffect(() => { if (window.location.hash === "#business-controls") setBusinessOpen(true); }, []);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const holds = useAdHolds(variant === "story");

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/ad-budget");
      if (!res.ok) throw new Error("read");
      setSnap((await res.json()) as Snapshot);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => {
    if (!initial) void load();
  }, [initial, load]);
  const initialKey = initial ? JSON.stringify(initial) : "";
  const synced = useRef(initialKey);
  useEffect(() => {
    if (!initial || synced.current === initialKey) return;
    synced.current = initialKey;
    setSnap(initial);
  }, [initial, initialKey]);

  const loaded = snap !== null;
  const scrolled = useRef(false);
  useEffect(() => {
    if (!loaded || scrolled.current) return;
    scrolled.current = true;
    if (window.location.hash === `#${AD_BUDGET_ANCHOR}`) {
      document.getElementById(AD_BUDGET_ANCHOR)?.scrollIntoView?.({ block: "start" });
    }
  }, [loaded]);

  const save = (path: string, method: "POST" | "PATCH") => async (body: { monthly_usd: number; daily_limit_usd: number | null }) => {
    try {
      const res = await apiFetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return await errorOf(res, "Could not save that. Try again.");
      const reply = (await res.json().catch(() => ({}))) as SaveReply;
      const saved = snap ? savedBudget(snap.budget, body, reply, utcToday()) : null;
      if (saved) {
        setSnap((s) => (s ? { ...s, budget: saved } : s));
        void load();
      } else {
        await load();
      }
      setMode("view");
      setNotice(null);
      onChanged?.();
      announceAdBudgetChange();
      return null;
    } catch {
      return "Could not save that. Try again.";
    }
  };

  const stopInFlight = useRef(false);
  const stop = async (id: string) => {
    if (stopInFlight.current) return;
    stopInFlight.current = true;
    setStopping(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/ad-budget/${id}/stop`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as StopReply;
      if (!res.ok) {
        setError(j.error?.message ?? "Could not stop the budget. Try again.");
        return;
      }
      const paused = j.paused?.length ?? 0;
      const failed = j.failed ?? [];
      setNotice(
        failed.length > 0
          ? stopFailedNotice(failed)
          : stoppedNotice(paused),
      );
      setMode("view");
      await load();
      onChanged?.();
      announceAdBudgetChange();
    } catch {
      setError("Could not stop the budget. Try again.");
    } finally {
      stopInFlight.current = false;
      setStopping(false);
    }
  };

  if (loadFailed && !snap) {
    return (
      <p id={AD_BUDGET_ANCHOR} className="mt-3 px-1 text-[13px] text-inkMuted">
        Couldn&apos;t load the ad budget.
      </p>
    );
  }
  if (!snap) {
    return (
      <div id={AD_BUDGET_ANCHOR} className="mt-3 px-1" aria-busy="true" aria-label="Loading the ad budget">
        <div className="h-4 w-48 animate-pulse rounded bg-creamDeep" />
      </div>
    );
  }

  const b = snap.budget;
  const active = b?.status === "active" ? b : null;
  const manage = snap.can_manage;
  const canSetUp = manage && snap.pro;
  const unfinishedStop = b?.status === "stopped" && b.still_running.length > 0;

  let line: string;
  if (active) {
    line = `Ad budget: ${money(active.monthly_usd)} a month, running now`;
    if (active.daily_limit_usd != null) line += `, up to ${money(active.daily_limit_usd)} a day`;
  } else if (b?.status === "stopped") {
    line = "Ad budget: stopped";
  } else {
    line = "Ad budget: none";
  }

  const story = variant === "story";
  const heldLine = holds === null ? "Held raises couldn't be loaded right now." : holdsLine(holds);
  const storyLine = active
    ? `Ads: ${money(active.monthly_usd)} a month${active.daily_limit_usd != null ? `, up to ${money(active.daily_limit_usd)} a day` : ""}`
    : b?.status === "stopped"
      ? "Ads: stopped"
      : "Ads: no budget set";
  const spentPct = active && active.month_cap_usd > 0 && active.spent_usd > 0 ? Math.min(100, Math.round((active.spent_usd / active.month_cap_usd) * 100)) : null;

  return (
    <div
      id={AD_BUDGET_ANCHOR}
      className={`scroll-mt-20 ${story ? "rounded-xl bg-creamDeep px-3.5 py-3" : "mt-4 rounded-2xl border border-rule px-4 py-3.5"}`}
      aria-label="Ad budget"
    >
      {active && <><button id="business-controls" type="button" className="mb-2 text-sm underline" aria-expanded={businessOpen} onClick={()=>setBusinessOpen(v=>!v)}>Business results and experiments</button>
        {businessOpen && <BusinessControls/>}</>}
      {story ? (
        <p className="flex flex-wrap items-center gap-2 text-[14px] font-bold text-ink">
          {storyLine}
          {active ? (
            <span className="rounded-full bg-successBg px-2 py-0.5 text-[12px] font-semibold text-success dark:bg-success/20 dark:text-mint">
              Running
            </span>
          ) : b?.status === "stopped" ? (
            <span className="rounded-full bg-dangerBg px-2 py-0.5 text-[12px] font-semibold text-danger dark:bg-danger/20 dark:text-coral">
              Stopped
            </span>
          ) : null}
        </p>
      ) : (
        <p className="text-[14px] font-semibold text-ink">{line}</p>
      )}
      {active && (
        <p className="mt-1 text-[13px] text-inkSoft">
          {monthLine(active)}
        </p>
      )}
      {story && active && heldLine && (
        <p className={holds === null ? "mt-1 text-[12px] text-inkMuted" : "mt-1 text-[13px] text-inkSoft"}>{heldLine}</p>
      )}
      {story && spentPct !== null && (
        <span
          role="progressbar"
          aria-label="Spent this month"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={spentPct}
          className="mt-1.5 block h-[5px] w-56 max-w-full overflow-hidden rounded-full bg-rule"
        >
          <span className="block h-full bg-ink" style={{ width: `${spentPct}%` }} />
        </span>
      )}
      {!snap.pro && !active && <p className="mt-1 text-[13px] text-inkMuted">{PRO_LINE}</p>}
      {!manage && <p className="mt-1 text-[13px] text-inkMuted">Only owners and admins can change the ad budget.</p>}
      {b?.status === "stopped" && b.still_running.length > 0 && (
        <p role="alert" className="mt-1 text-[13px] text-warn dark:text-marigold">
          Still holding money: {b.still_running.map(objectName).join(", ")}. Press Stop again to pause {b.still_running.length === 1 ? "it" : "them"}, and Zavi says what it could not pause and why.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-1 text-[13px] text-inkSoft">
          {notice}
        </p>
      )}

      {mode === "setup" && (
        <BudgetForm submitLabel="Set up budget" onSubmit={save("/api/workspace/ad-budget", "POST")} onCancel={() => setMode("view")} />
      )}
      {mode === "edit" && active && (
        <BudgetForm initial={active} submitLabel="Save changes" onSubmit={save(`/api/workspace/ad-budget/${active.id}`, "PATCH")} onCancel={() => setMode("view")} />
      )}
      {mode === "confirm-stop" && b && (
        <div className="mt-2 rounded-xl border border-rule p-3">
          <p className="text-[13px] text-ink">{STOP_CONFIRM}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={stopping} onClick={() => void stop(b.id)} className={BTN_PRIMARY}>
              {stopping ? "Stopping…" : "Yes, stop"}
            </button>
            <button type="button" disabled={stopping} onClick={() => setMode("view")} className={BTN}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "view" && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!active && canSetUp && !unfinishedStop && (
            <button type="button" onClick={() => setMode("setup")} className={BTN_PRIMARY}>
              {b ? "Set up a new budget" : "Set up"}
            </button>
          )}
          {active && manage && snap.pro && (
            <button type="button" onClick={() => setMode("edit")} className={BTN}>
              Edit
            </button>
          )}
          {manage && (active || (b?.status === "stopped" && b.still_running.length > 0)) && (
            <button type="button" onClick={() => setMode("confirm-stop")} className={BTN}>
              Stop
            </button>
          )}
          {}
          <button type="button" aria-expanded={ledgerOpen} onClick={() => setLedgerOpen((v) => !v)} className={BTN}>
            {ledgerOpen ? "Hide ledger" : story ? "Ledger" : "See ledger"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-warn dark:text-marigold">
          {error}
        </p>
      )}
      {ledgerOpen && (
        <Ledger
          key={b ? `${b.id}:${b.status}:${b.monthly_usd}:${b.daily_limit_usd ?? ""}` : "none"}
          budgetId={b?.id ?? null}
          canLog={canSetUp}
          canUndo={manage}
        />
      )}
    </div>
  );
}
