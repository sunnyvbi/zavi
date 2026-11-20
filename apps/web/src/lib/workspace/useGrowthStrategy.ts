"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

export type ChannelBet = {
  channel_slug: string;
  rationale: string;
  expected_effect: string;
};

export type GrowthStrategy = {
  north_star: { metric: string; why: string; provenance: string };
  constraint: {
    statement: string;
    lever_family: string;
    evidence: string;
    confidence: "high" | "medium" | "low";
  };
  channel_bets: ChannelBet[];
  goal: {
    objective: string;
    target_metric: string;
    target_value: number;
    due_date: string;
  } | null;
  gaps: string[];
  unmeasured: Array<{ lever: string; the_one_read_that_would_size_it: string }>;
};

export type GrowthStrategyState = {
  strategy: GrowthStrategy | null;
  accepted: boolean;
  intakeStarted: boolean;
  loading: boolean;
  reload: () => Promise<void>;
};

export function useGrowthStrategy(): GrowthStrategyState {
  const [strategy, setStrategy] = useState<GrowthStrategy | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [intakeStarted, setIntakeStarted] = useState(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/growth-strategy");
      if (!res.ok) return;
      const body = (await res.json()) as {
        strategy: GrowthStrategy | null;
        accepted: boolean;
        intake_started?: boolean;
      };
      if (!mounted.current) return;
      setStrategy(body.strategy ?? null);
      setAccepted(Boolean(body.accepted));
      setIntakeStarted(Boolean(body.intake_started));
    } catch {
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  return { strategy, accepted, intakeStarted, loading, reload };
}
