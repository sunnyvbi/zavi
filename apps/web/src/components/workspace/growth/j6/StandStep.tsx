"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";
import { formatGoalValue } from "../../AutopilotGoalsPanel";
import { humanize } from "../growthPresentation";
import { patchGoal, saveBudget, setAutopilot, undoAdChange, type AdBudgetRead, type LedgerChange } from "./api";
import { day, dollars, monthName, runsOutNow, runsOutText } from "./format";
import { B, Fold, Input, L, Src, Switch, box, type Overlay } from "./ui";

export const fmtGoal = (g: GrowthGoal, v: number) => formatGoalValue({ target_metric: g.target_metric }, v);
const metricWords = (g: GrowthGoal) => humanize(g.target_metric).toLowerCase();

const measured = (g: GrowthGoal) => g.measurement_mode === "auto";

export function paceLine(g: GrowthGoal): string | null {
  const t = g.trajectory;
  if (!t || !t.pace_usable || t.projected === null || g.target_value === null) return null;
  const due = g.due_date ? day(g.due_date.slice(0, 10)) : "the due date";
  return t.projected < g.target_value ? `About ${fmtGoal(g, g.target_value - t.projected)} short by ${due}` : `On track for ${due}`;
}

export const askBasis = (g: GrowthGoal) => g.current_value !== null && !measured(g) && g.trajectory?.kind === "ambiguous";

export function headline(goal: GrowthGoal | null): string {
  if (!goal) return "No goal yet.";
  if (goal.current_value === null) {
    const target = goal.target_value !== null ? `${fmtGoal(goal, goal.target_value)} ` : "";
    return `${target}${metricWords(goal)}${goal.due_date ? ` by ${day(goal.due_date.slice(0, 10))}` : ""}.`;
  }
  const target = goal.target_value !== null ? ` of ${fmtGoal(goal, goal.target_value)}` : "";
  return `${fmtGoal(goal, goal.current_value)}${target} ${metricWords(goal)}.`;
}

type Say = (text: string, undo?: () => void) => void;

export function StandStep({
  goal,
  goalsUnreadable,
  goalComing,
  canEdit,
  showPicker,
  rows,
  autopilot,
  ad,
  changes,
  onEditGoal,
  say,
  overlay,
  close,
  onChanged,
  reloadAd,
}: {
  goal: GrowthGoal | null;
  goalsUnreadable: boolean;
  goalComing: boolean;
  canEdit: boolean;
  showPicker: boolean;
  rows: ReactNode;
  autopilot: boolean | null;
  ad: AdBudgetRead | null;
  changes: LedgerChange[] | null;
  onEditGoal: (goal: GrowthGoal | null, objective?: string) => void;
  say: Say;
  overlay: (o: Overlay) => void;
  close: () => void;
  onChanged: () => Promise<void>;
  reloadAd: () => void;
}) {
  const [num, setNum] = useState("");
  const [busy, setBusy] = useState(false);
  const [apOn, setApOn] = useState<boolean | null>(null);
  const autopilotOn = apOn ?? autopilot ?? false;
  const goalId = goal?.id ?? null;
  useEffect(() => {
    setNum("");
  }, [goalId]);

  const saveNum = async () => {
    if (!goal) return;
    const v = Number(num.replace(/[^0-9.]/g, ""));
    if (!num.trim()) return;
    if (!/[0-9]/.test(num) || !Number.isFinite(v) || v < 0) return say("Type a number, like 12.");
    setBusy(true);
    const r = await patchGoal(goal.id, { current_value: v });
    setBusy(false);
    if (!r.ok) return say(r.message ?? "Could not save that number.");
    setNum("");
    say(`Saved: ${fmtGoal(goal, v)} on ${day(new Date().toISOString())}.`);
    window.dispatchEvent(new Event("autopilot:goals-changed"));
    await onChanged();
  };

  const setBasis = async (kind: "period_total" | "gauge" | null) => {
    if (!goal) return;
    const now = new Date();
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const r = await patchGoal(goal.id, { value_kind: kind, value_period_start: kind === "period_total" ? start : null });
    if (!r.ok) return say(r.message ?? "Could not save that.");
    say(kind === "period_total" ? `Counting ${monthName()}'s total.` : kind === "gauge" ? "Counting a running total." : "Reopened.");
    await onChanged();
  };

  const flipAutopilot = async (want: boolean) => {
    setApOn(want);
    const r = await setAutopilot(want);
    if (!r.ok) {
      setApOn(!want);
      return say(r.message ?? "Could not save that. Try again.");
    }
    say(want ? "Autopilot is back on." : "Autopilot paused.");
    await onChanged();
    setApOn(null);
  };

  const askPause = () => {
    if (!autopilotOn) return void flipAutopilot(true);
    const paid = !!ad?.budget && ad.budget.status === "active";
    overlay({
      kind: "modal",
      title: "Pause Autopilot?",
      body: (
        <div>
          <ul className="list-disc space-y-1 pl-5">
            {paid ? (
              <>
                <li>Zavi stops changing budgets and launching ads.</li>
                <li>Ads already running keep running and spending.</li>
              </>
            ) : (
              <li>Zavi stops writing new drafts. What&apos;s here stays.</li>
            )}
          </ul>
          <div className="mt-4 flex gap-2">
            <B
              dark
              onClick={() => {
                close();
                void flipAutopilot(false);
              }}
            >
              Pause
            </B>
            <B onClick={close}>Keep it on</B>
          </div>
        </div>
      ),
    });
  };

  const editBudget = () => {
    const b = ad?.budget;
    if (!b) return;
    const floor = b.spent_usd + b.held_usd;
    const Body = () => {
      const [v, setV] = useState(String(b.monthly_usd));
      const [saving, setSaving] = useState(false);
      const [err, setErr] = useState<string | null>(null);
      const n = Number(v);
      const bad = !(n > 0) ? "Type an amount." : n < floor ? `Can't go under ${dollars(floor)}: already spent or set aside.` : "";
      return (
        <div>
          <div className="flex items-center gap-2">
            $<Input value={v} onChange={(x) => setV(x.replace(/[^0-9]/g, ""))} w="w-32" autoFocus label="Monthly ad budget" />
            <span className="text-[14px] text-inkMuted">a month, all ad channels</span>
          </div>
          <p className="mt-2 text-[14px] text-inkMuted">
            This month: {dollars(b.spent_usd)} spent · {dollars(b.held_usd)} set aside · {dollars(b.left_usd)} left <Src kind="measured">ad accounts</Src>
          </p>
          {(bad || err) && <p className="mt-2 text-[14px] text-danger dark:text-coral">{err ?? bad}</p>}
          <div className="mt-4 flex gap-2">
            <B
              dark
              disabled={!!bad || n === b.monthly_usd || saving}
              onClick={async () => {
                setSaving(true);
                const r = await saveBudget(b.id, n, b.daily_limit_usd);
                setSaving(false);
                if (!r.ok) return setErr(r.message ?? "Could not save that. Try again.");
                close();
                say(`Budget set to ${dollars(n)} a month.`);
                reloadAd();
              }}
            >
              Save
            </B>
            <B onClick={close}>Cancel</B>
          </div>
        </div>
      );
    };
    overlay({ kind: "modal", title: "Edit ad budget", body: <Body /> });
  };

  const confirmUndo = (c: LedgerChange) => {
    const u = c.undo;
    if (!u) return;
    const Body = () => {
      const [saving, setSaving] = useState(false);
      const [err, setErr] = useState<string | null>(null);
      return (
        <div>
          <p>{u.change}</p>
          {err && <p className="mt-2 text-[14px] text-danger dark:text-coral">{err}</p>}
          <div className="mt-4 flex gap-2">
            <B
              dark
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                const r = await undoAdChange(u.change_id);
                setSaving(false);
                if (!r.ok) return setErr(r.message ?? "Could not set up the undo. Try again.");
                close();
                say("Undo sent. It applies in the ad account shortly.");
                reloadAd();
              }}
            >
              Undo it
            </B>
            <B onClick={close}>Cancel</B>
          </div>
        </div>
      );
    };
    overlay({ kind: "modal", title: "Undo this change?", body: <Body /> });
  };

  let top: ReactNode = null;
  if (goalsUnreadable) {
    top = <p className="text-[15px] leading-6 text-inkMuted">Couldn&apos;t load your goal. Try again in a moment.</p>;
  } else if (goalComing) {
    top = <p className="text-[15px] leading-6 text-inkMuted">You can change it once the plan lands.</p>;
  } else if (!goal) {
    top = showPicker && canEdit ? (
      <div className="flex flex-wrap gap-2">
        {["New paying customers", "Signups", "Monthly revenue"].map((m) => (
          <B key={m} onClick={() => onEditGoal(null, m)}>
            {m}
          </B>
        ))}
        <B onClick={() => onEditGoal(null, "")}>Something else…</B>
      </div>
    ) : null;
  } else if (canEdit && goal.current_value === null && !measured(goal)) {
    top = (
      <div className="flex flex-wrap items-center gap-3 text-[15px] leading-6 text-inkMuted">
        <span className="font-semibold text-ink">How many {metricWords(goal)} so far?</span>
        <Input value={num} onChange={setNum} placeholder="How many so far?" w="w-44 tabular-nums" onEnter={() => void saveNum()} />
        <B dark disabled={!num.trim() || busy} onClick={() => void saveNum()}>
          See if I&apos;m on track
        </B>
      </div>
    );
  } else if (canEdit && goal.current_value !== null && askBasis(goal)) {
    top = (
      <div className="flex flex-wrap items-center gap-2 text-[15px] leading-6">
        <span className="font-semibold text-warn dark:text-marigold">
          Is {fmtGoal(goal, goal.current_value)} {metricWords(goal)} {monthName()}&apos;s total or a running total?
        </span>
        <B dark onClick={() => void setBasis("period_total")}>
          {monthName()}&apos;s total
        </B>
        <B onClick={() => void setBasis("gauge")}>Running total</B>
      </div>
    );
  } else if (canEdit && !measured(goal) && (goal.value_kind === "gauge" || goal.value_kind === "period_total")) {
    top = (
      <p className="text-[15px] leading-6 text-inkMuted">
        {humanize(goal.target_metric)} counts{" "}
        <b className="text-ink">{goal.value_kind === "period_total" ? "this period's total so far" : "a running total"}</b>{" "}
        <L onClick={() => void setBasis(null)}>Change</L>
      </p>
    );
  }

  const b = ad?.budget && ad.budget.status === "active" ? ad.budget : null;
  const runs = runsOutText(runsOutNow(ad?.forecast ?? null, b?.left_usd ?? null));
  const changeRows = changes ?? [];

  return (
    <>
      {rows && <div>{rows}</div>}
      <div className={box}>
        {top && <div className="border-b border-rule px-4 py-3">{top}</div>}
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-[14px] leading-5 text-inkMuted">
          {autopilot !== null && <Switch on={autopilotOn} onClick={askPause} label="Autopilot" />}
          <span className="min-w-0 flex-1">
            {autopilot === null ? (
              "Autopilot: couldn't read it"
            ) : autopilotOn ? (
              "Autopilot on"
            ) : (
              <b className="text-warn dark:text-marigold">Autopilot paused</b>
            )}
            {" · "}
            {b ? (
              <>
                ad money <b className="text-ink">{dollars(b.left_usd)} left</b>
                {runs ? `, ${runs}` : ""}
              </>
            ) : ad === null ? (
              "ad money not read yet"
            ) : (
              "no ad budget set"
            )}
          </span>
          {b && runs && <Src kind="estimate">estimate</Src>}
          {b && ad?.can_manage && (
            <span className="ml-auto">
              <B onClick={editBudget}>Edit budget</B>
            </span>
          )}
        </div>
        {changes !== null && changeRows.length === 0 ? null : (
        <Fold
          empty={changeRows.length === 0}
          title={changes === null ? "Changes in your ad accounts: not read yet" : `${changeRows.length} ${changeRows.length === 1 ? "change" : "changes"} in your ad accounts`}
        >
          {changeRows.map((c, k) => (
            <div key={`${c.at}-${k}`} className="flex items-center gap-2.5 px-4 py-2 pl-10 text-[14px] text-ink">
              <span className="min-w-0 flex-1">
                {c.action}
                {c.result ? <span className="text-inkMuted"> · {c.result}</span> : null}
              </span>
              <span className="text-[13px] text-inkMuted">{day(c.at)}</span>
              {c.undo && <L onClick={() => confirmUndo(c)}>Undo</L>}
            </div>
          ))}
        </Fold>
        )}
      </div>
    </>
  );
}
