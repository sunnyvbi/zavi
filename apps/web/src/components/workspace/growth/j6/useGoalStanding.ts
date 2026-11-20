"use client";

import { useCallback, useEffect, useState } from "react";
import type { GrowthGoal, GrowthPlanPayload } from "@/lib/workspace/useGrowthPlan";
import { goalFix, liveKey, rankGoals, readsLive, useLiveGoalValues, withLiveValue, type LiveReadState } from "../GrowthGoals";
import { LOADING, type MeasurementNeed } from "../growthHeadline";
import { goalPill, useGoalHistories, type GoalPill } from "../StoryGoals";
import { readConnectedSlugs } from "./api";

export type GoalStanding = {
  goals: GrowthGoal[];
  pills: ReadonlyMap<string, GoalPill | null>;
  fixes: ReadonlyMap<string, MeasurementNeed | null>;
  settled: boolean;
  liveState: ReadonlyMap<string, LiveReadState | "manual">;
  removed: ReadonlySet<string>;
  onRemovedChange: (id: string, gone: boolean) => void;
};

export function useGoalStanding(data: GrowthPlanPayload): GoalStanding {
  const unreadable = data.unreadable.includes("goals");
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const onRemovedChange = useCallback((id: string, gone: boolean) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      if (gone) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const [connected, setConnected] = useState<string[] | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void readConnectedSlugs().then((slugs) => {
      if (current) setConnected(slugs);
    });
    return () => {
      current = false;
    };
  }, []);

  const active = unreadable ? [] : rankGoals(data.goals.items.filter((g) => g.status === "active" && !removed.has(g.id)));
  const live = useLiveGoalValues(active, data);
  const goals = active.map((g) => withLiveValue(g, live.values));
  const fixOf = new Map(active.map((g) => [g.id, goalFix(g, live, connected)] as const));
  const measured = goals.filter((g) => {
    const fix = fixOf.get(g.id);
    return fix !== undefined && fix !== LOADING && fix !== null && fix.kind === "none";
  });
  const histories = useGoalHistories(measured, undefined);
  const pillOf = goals.map((g) => {
    const fix = fixOf.get(g.id) ?? null;
    const settledWithout = fix !== LOADING && (fix === null || fix.kind !== "none");
    return [g.id, goalPill(g, fix, settledWithout ? "failed" : histories.get(g.id))] as const;
  });

  return {
    goals,
    pills: new Map(pillOf.map(([id, p]) => [id, p === LOADING ? null : p])),
    fixes: new Map(Array.from(fixOf.entries()).map(([id, f]) => [id, f === LOADING ? null : f])),
    settled: pillOf.every(([, p]) => p !== LOADING),
    liveState: new Map(active.map((g) => [g.id, readsLive(g) ? live.states.get(liveKey(g)) ?? "loading" : "manual"] as const)),
    removed,
    onRemovedChange,
  };
}
