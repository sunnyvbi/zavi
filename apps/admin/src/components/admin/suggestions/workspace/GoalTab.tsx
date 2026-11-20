"use client";

import { CalendarDays } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { GoalRow, GoalsSection, Section } from "./types";
import { Empty, Notice, Stat, TabHeader, ToneBadge, type Tone } from "../ui";
import { fmtCount, fmtDate, fmtPct } from "./format";

function pace(goal: GoalRow): { label: string; tone: Tone } | null {
  if (goal.status === "met") return { label: "Met", tone: "good" };
  if (goal.status === "missed") return { label: "Missed", tone: "bad" };
  if (goal.progress === null) return { label: "No baseline", tone: "flat" };
  if (!goal.due_date) return null;
  const due = new Date(goal.due_date).getTime();
  if (Number.isNaN(due)) return null;
  if (due < Date.now()) return { label: "Past due", tone: "bad" };
  return goal.progress >= 0.5 ? { label: "Needs push", tone: "warn" } : { label: "At risk", tone: "bad" };
}

function count(value: number | null): string {
  return value === null ? "—" : fmtCount(value);
}

export function GoalTab({ section }: { section: Section<GoalsSection> }) {
  const { goals, summary } = section.data;

  if (goals.length === 0) {
    return (
      <div>
        <TabHeader title="Growth goals" />
        <Empty title="No goals set for this client" detail={section.detail} />
      </div>
    );
  }

  return (
    <div>
      <TabHeader title="Growth goals" />
      <Notice status={section.status} detail={section.detail} />

      <Card className="mb-6 grid grid-cols-2 gap-px overflow-hidden bg-border lg:grid-cols-4">
        <Stat label="Active goals" value={summary.active} hint="this planning cycle" />
        <Stat label="On track" value={summary.on_track} hint="at or above pace" />
        <Stat label="Needs attention" value={summary.needs_attention} hint="behind pace" />
        <Stat
          label="Average progress"
          value={fmtPct(summary.average_progress, 0)}
          hint={summary.average_progress === null ? "no measurable goals" : "across measurable goals"}
        />
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {goals.map((goal) => {
          const state = pace(goal);
          return (
            <Card key={goal.id}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold text-foreground">{goal.objective}</p>
                  {state && (
                    <ToneBadge tone={state.tone} dot>
                      {state.label}
                    </ToneBadge>
                  )}
                </div>

                <p className="mt-3 text-2xl font-semibold text-foreground">
                  {count(goal.current_value)}
                  <span className="px-2 text-muted-foreground">→</span>
                  <span className="text-muted-foreground">{count(goal.target_value)}</span>
                </p>

                <div className="mt-4 flex items-center gap-3">
                  <Progress value={Math.max(0, Math.min(1, goal.progress ?? 0)) * 100} />
                  <span className="shrink-0 text-sm font-medium text-foreground">
                    {fmtPct(goal.progress, 0)}
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {goal.baseline_value === null
                      ? "no baseline recorded"
                      : `from ${fmtCount(goal.baseline_value)}`}
                  </span>
                  {goal.due_date && (
                    <span className="flex items-center gap-1">
                      <CalendarDays className="size-3.5" />
                      {fmtDate(goal.due_date)}
                    </span>
                  )}
                  <span>{goal.target_metric}</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
