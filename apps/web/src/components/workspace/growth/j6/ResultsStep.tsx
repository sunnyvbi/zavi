"use client";

import { useEffect, useState } from "react";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";
import { readGoalHistory, type AdBudgetRead, type DoneItem, type HistoryPoint, type TestsRead } from "./api";
import { day, dollars } from "./format";
import { channelLabel } from "./PlanStep";
import { fmtGoal } from "./StandStep";
import { Fold, Mark, Src, box, type SrcKind } from "./ui";

const VERDICT: Record<string, [string, SrcKind]> = {
  worked: ["won", "measured"],
  did_not_work: ["lost", "blocked"],
  not_measured: ["not measured", "unmeasured"],
};
const LAUNCH: Record<string, string> = { never_ran: "never launched", blocked: "stuck", in_progress: "running", launched: "launched" };

const WEEK = 7 * 86_400_000;

export function ResultsStep({
  goal,
  tests,
  done,
  ad,
}: {
  goal: GrowthGoal | null;
  tests: TestsRead | null;
  done: DoneItem[] | null;
  ad: AdBudgetRead | null;
}) {
  const [points, setPoints] = useState<HistoryPoint[] | null>(null);
  const goalKey = goal ? `${goal.id}:${goal.current_value ?? ""}` : "";
  useEffect(() => {
    if (!goal) return setPoints(null);
    let live = true;
    void readGoalHistory(goal.id).then((p) => {
      if (live) setPoints(p);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalKey]);

  const lastTwo = (points ?? []).slice(-2);
  const measured = goal?.measurement_mode === "auto";
  const finished = (tests?.items ?? []).filter((t) => t.verdict !== null || t.launch === "never_ran" || t.launch === "blocked");
  const running = (tests?.items ?? []).filter((t) => t.verdict === null && (t.launch === "launched" || t.launch === "in_progress"));
  const recent = (done ?? []).filter((d) => Date.now() - Date.parse(d.done_at) <= WEEK);
  const b = ad?.budget ?? null;

  return (
    <div className={box}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-rule px-4 py-3 text-[15px] leading-6 text-inkSoft">
        {goal && lastTwo.length === 2 ? (
          <>
            <span className="font-semibold text-ink">Your number: {lastTwo.map((p) => fmtGoal(goal, p.value)).join(" → ")}</span>
            <span className="text-inkMuted">{lastTwo.map((p) => day(p.at)).join(" → ")}</span>
            <Src kind={measured ? "measured" : "typed"}>{measured ? "measured" : "you typed both"}</Src>
          </>
        ) : (
          <span>
            Your number:{" "}
            <span className="font-semibold text-ink">{goal ? (goal.current_value !== null ? "one reading so far" : "not counted yet") : "no goal yet"}</span>
          </span>
        )}
      </div>

      <Fold
        empty={finished.length === 0}
        title={
          tests ? (
            <span>
              Tests, last 30 days: <b>{tests.won} won</b> · <b className="text-danger dark:text-coral">{tests.lost} lost</b> ·{" "}
              <b className="text-warn dark:text-marigold">{tests.never_launched} never launched</b>
            </span>
          ) : (
            "Tests, last 30 days: not read yet"
          )
        }
      >
        {finished.map((t) => (
          <div key={t.decision_id} className="flex items-start gap-2.5 px-4 py-2 pl-10 text-[14px] text-ink">
            {t.verdict ? (
              <Src kind={VERDICT[t.verdict]?.[1] ?? "unmeasured"}>{VERDICT[t.verdict]?.[0] ?? t.verdict}</Src>
            ) : (
              <Src kind="blocked">{LAUNCH[t.launch] ?? t.launch}</Src>
            )}
            <span className="min-w-0 flex-1">
              <b>{t.title}</b>
              {t.channel_slug && <span className="text-inkMuted"> · {channelLabel(t.channel_slug)}</span>}
            </span>
          </div>
        ))}
      </Fold>
      <Fold
        empty={running.length === 0}
        title={tests ? `${tests.running} ${tests.running === 1 ? "test" : "tests"} still running` : "Tests still running: not read yet"}
        aside={tests?.next_read_on ? `first reads ${day(tests.next_read_on)}` : undefined}
      >
        {running.map((t) => (
          <div key={t.decision_id} className="flex items-center gap-2.5 px-4 py-2 pl-10 text-[14px] text-ink">
            <Mark slug={t.channel_slug} size={16} />
            <span className="flex-1">{t.title}</span>
            <span className="text-[13px] text-inkMuted">{t.read_on ? `reads ${day(t.read_on)}` : "read date not set"}</span>
          </div>
        ))}
      </Fold>
      <Fold
        empty={recent.length === 0}
        title={done ? `${recent.length} done this week` : "Done this week: not read yet"}
        aside={recent.length ? "results not measured yet" : undefined}
      >
        {recent.map((d) => (
          <div key={`${d.source}:${d.id}`} className="flex items-center gap-2.5 px-4 py-2 pl-10 text-[14px] text-ink">
            <Mark slug={d.channel_slug} size={16} />
            <span className="min-w-0 flex-1 truncate">{d.title}</span>
            <Src kind={d.by === "zavi" ? "measured" : "typed"}>{d.by === "zavi" ? "Zavi applied" : "you marked"}</Src>
            <span className="text-[13px] text-inkMuted">{day(d.done_at)}</span>
          </div>
        ))}
      </Fold>
      <p className="border-t border-rule px-4 py-3 text-[15px] leading-6 text-inkMuted">
        {b ? (
          <>
            Ad money: {dollars(b.spent_usd)} spent · {dollars(b.held_usd)} set aside · {dollars(b.left_usd)} left <Src kind="measured">ad accounts</Src>
          </>
        ) : ad === null ? (
          "Ad money: not read yet"
        ) : (
          "Ad money: no ad budget set"
        )}
      </p>
    </div>
  );
}
