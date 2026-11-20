import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiJson } from "../../lib/api";
import { readRetry, readRetryDelay } from "../../lib/apiRetry";
import { fetchChannelApprovals, fetchChannels } from "../channels/api";
import type { ApprovalsResponse, ChannelsResponse } from "../channels/types";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import type { Personalization, PersonalizationPatch } from "../personalization/usePersonalization";
import {
  COLOURS_RESET_ERROR,
  COLOURS_SAVE_ERROR,
  VOICE_SAVE_ERROR,
  brandKitOf,
  kitBody,
  voiceDraftBodyOf,
  type ColourDraft,
} from "./knowledge";
import { historyBodyOf, type GoalHistoryBody } from "./goalHistory";
import { serverMessage, warningsOf, type GoalPayload, type LiveRead } from "./goalForm";
import { isShipRedRefusal, moveRequest, type MoveAction } from "./moves";
import type { Claim, ClaimReply } from "./note";
import { answeredOf, questionsOf, type Answer, type Answered } from "./needs";
import {
  liveReadOf,
  normalizePlan,
  planKey,
  readsLive,
  type GrowthGoal,
  type GrowthPlan,
  type LiveGoalValues,
  type LiveReadState,
} from "./plan";
import { historyKey, historyPointsOf, youAskedOf, type HistoryRead } from "./story";

export const LIVE_REFRESH_MS = 30_000;
export const POLL_MS = 10_000;
export const POLL_CAP_MS = 10 * 60_000;

const reads = { retry: readRetry, retryDelay: readRetryDelay } as const;

export const growthKeys = {
  plan: (tenant: string) => ["growth-plan", tenant] as const,
  questions: (tenant: string) => ["growth-questions", tenant] as const,
  youAsked: (tenant: string) => ["growth-you-asked", tenant] as const,
  setup: (tenant: string) => ["workspace-setup", tenant] as const,
  history: (tenant: string, key: string) => ["growth-goal-history", tenant, key] as const,
  liveValue: (tenant: string, metric: string) => ["growth-goal-value", tenant, metric] as const,
};

export function useGrowthPlan(fast?: { current: boolean }) {
  const tenant = useActiveTenant();
  const focused = useIsFocused();
  return useQuery<GrowthPlan>({
    queryKey: growthKeys.plan(tenant),
    enabled: tenant !== "none",
    queryFn: async () => normalizePlan(await apiJson<unknown>("/api/workspace/growth/plan")),
    refetchInterval: () => (focused ? (fast?.current ? POLL_MS : LIVE_REFRESH_MS) : false),
    ...reads,
  });
}

export function usePlanWatch(plan: GrowthPlan | null) {
  const [drafting, setDrafting] = useState(false);
  const [draftSlow, setDraftSlow] = useState(false);
  const baseline = useRef<string | null>(null);
  const startedAt = useRef(0);
  const current = plan ? planKey(plan.unreadable.includes("plan") ? null : plan.plan) : null;
  const currentRef = useRef(current);
  currentRef.current = current;

  const watch = useCallback(() => {
    baseline.current = currentRef.current;
    startedAt.current = Date.now();
    setDraftSlow(false);
    setDrafting(true);
  }, []);
  const stop = useCallback(() => setDrafting(false), []);

  useEffect(() => {
    if (!drafting || !plan) return;
    const row = plan.unreadable.includes("plan") ? null : plan.plan;
    if (current !== null && current !== baseline.current && !row?.pending_acceptance) setDrafting(false);
  }, [plan, current, drafting]);

  useEffect(() => {
    if (!drafting) return;
    const left = POLL_CAP_MS - (Date.now() - startedAt.current);
    const id = setTimeout(() => {
      setDrafting(false);
      setDraftSlow(true);
    }, Math.max(0, left));
    return () => clearTimeout(id);
  }, [drafting]);

  return { drafting, draftSlow, watch, stop };
}

export type SetupState =
  | { enabled: false }
  | {
      enabled: true;
      done: boolean;
      one_state?: boolean;
      draft: { status: "none" | "running" | "failed" | "done"; run_id: string | null; attempts: number; can_retry: boolean; free_retry: boolean };
    };

export function useSetupState() {
  const tenant = useActiveTenant();
  const runningSince = useRef<number | null>(null);
  return useQuery<SetupState>({
    queryKey: growthKeys.setup(tenant),
    enabled: tenant !== "none",
    queryFn: () => apiJson<SetupState>("/api/workspace/setup"),
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d || !d.enabled || d.draft.status !== "running") {
        runningSince.current = null;
        return false;
      }
      runningSince.current ??= Date.now();
      return Date.now() - runningSince.current < POLL_CAP_MS ? POLL_MS : false;
    },
    ...reads,
  });
}

export function useGrowthWork(planUpdatedAt: number) {
  const tenant = useActiveTenant();
  const approvals = useQuery<ApprovalsResponse>({
    queryKey: ["approvals", tenant],
    queryFn: () => fetchChannelApprovals(),
    enabled: tenant !== "none",
    ...reads,
  });
  const channels = useQuery<ChannelsResponse>({
    queryKey: ["channels", tenant, "list"],
    queryFn: fetchChannels,
    enabled: tenant !== "none",
    ...reads,
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!planUpdatedAt) return;
    void approvals.refetch();
    void channels.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planUpdatedAt]);
  return { approvals, channels };
}

export function useGrowthQuestions() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: growthKeys.questions(tenant),
    enabled: tenant !== "none",
    queryFn: async () => questionsOf(await apiJson<unknown>("/api/workspace/growth/questions")),
    ...reads,
  });
}

export function useAnswerQuestion() {
  return useMutation({
    networkMode: "always",
    mutationFn: async (input: { id: string; answer: Answer }): Promise<Answered> =>
      answeredOf(
        await apiJson<unknown>(`/api/workspace/growth/questions/${encodeURIComponent(input.id)}/answer`, {
          method: "POST",
          body: JSON.stringify({ answer: input.answer }),
        }),
        input.answer,
      ),
  });
}

export function useYouAsked(planUpdatedAt: number) {
  const tenant = useActiveTenant();
  const q = useQuery({
    queryKey: growthKeys.youAsked(tenant),
    enabled: tenant !== "none",
    queryFn: async () => {
      try {
        return youAskedOf(await apiJson<unknown>("/api/workspace/growth/you-asked"));
      } catch {
        return null;
      }
    },
  });
  useEffect(() => {
    if (planUpdatedAt) void q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planUpdatedAt]);
  return q.data ?? null;
}

export function useLiveGoalValues(goals: GrowthGoal[], planUpdatedAt: number): LiveGoalValues & { refetchAll: () => void } {
  const tenant = useActiveTenant();
  const metrics = useMemo(() => Array.from(new Set(goals.filter(readsLive).map((g) => g.target_metric))).sort(), [goals]);
  const results = useQueries({
    queries: metrics.map((metric) => ({
      queryKey: growthKeys.liveValue(tenant, metric),
      enabled: tenant !== "none",
      staleTime: Infinity,
      retry: false,
      queryFn: async () => {
        try {
          return liveReadOf(
            await apiJson<unknown>(`/api/workspace/autopilot/goals/current-value?metric=${encodeURIComponent(metric)}`),
          );
        } catch {
          return { state: "failed" as LiveReadState, value: null };
        }
      },
    })),
  });
  const values = new Map<string, number>();
  const states = new Map<string, LiveReadState>();
  metrics.forEach((metric, i) => {
    const data = results[i]?.data;
    if (!data) {
      states.set(metric, "loading");
      return;
    }
    states.set(metric, data.state);
    if (data.value !== null) values.set(metric, data.value);
  });
  const resultsRef = useRef(results);
  resultsRef.current = results;
  useEffect(() => {
    if (!planUpdatedAt) return;
    for (const r of resultsRef.current) if (r.data?.state === "failed") void r.refetch();
  }, [planUpdatedAt]);
  return { values, states, refetchAll: () => resultsRef.current.forEach((r) => void r.refetch()) };
}

export function useGoalHistories(goals: GrowthGoal[]): { reads: ReadonlyMap<string, HistoryRead>; refetchAll: () => void } {
  const tenant = useActiveTenant();
  const results = useQueries({
    queries: goals.map((g) => ({
      queryKey: growthKeys.history(tenant, historyKey(g)),
      enabled: tenant !== "none",
      staleTime: Infinity,
      retry: false,
      queryFn: async (): Promise<HistoryRead> => {
        try {
          return historyPointsOf(await apiJson<unknown>(`/api/workspace/autopilot/goals/${encodeURIComponent(g.id)}/history`));
        } catch {
          return "failed";
        }
      },
    })),
  });
  const reads = new Map<string, HistoryRead>();
  goals.forEach((g, i) => reads.set(g.id, results[i]?.data ?? "loading"));
  const resultsRef = useRef(results);
  resultsRef.current = results;
  return { reads, refetchAll: () => resultsRef.current.forEach((r) => void r.refetch()) };
}

export function useBrandKit() {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["brand-kit", tenant],
    enabled: tenant !== "none",
    queryFn: async () => brandKitOf(await apiJson<unknown>("/api/workspace/brand-kit", { timeoutMs: 20_000 })),
    ...reads,
  });
}

export function useMarkPlanOpened(hasPlan: boolean) {
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !hasPlan) return;
    marked.current = true;
    void apiFetch("/api/workspace/next-tiles/mark", {
      method: "POST",
      body: JSON.stringify({ kind: "plan_opened", key: "plan" }),
    }).catch(() => {});
  }, [hasPlan]);
}

export function useRefreshGrowth() {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  return useCallback(
    () =>
      Promise.allSettled([
        qc.refetchQueries({ queryKey: growthKeys.plan(tenant) }),
        qc.refetchQueries({ queryKey: growthKeys.questions(tenant) }),
        qc.refetchQueries({ queryKey: ["approvals", tenant] }),
        qc.refetchQueries({ queryKey: ["channels", tenant, "list"] }),
      ]),
    [qc, tenant],
  );
}

export function useKeptConstraints() {
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const keep = useCallback(
    async (hypothesisId: string) => {
      setPending(hypothesisId);
      setFailed(null);
      try {
        const res = await apiFetch(`/api/workspace/growth/conflicts/${hypothesisId}/keep`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kept: true }),
        });
        if (!res.ok) {
          setFailed(hypothesisId);
          return;
        }
        setKept((prev) => new Set(prev).add(hypothesisId));
        void qc.refetchQueries({ queryKey: growthKeys.plan(tenant) }).finally(() =>
          setKept((prev) => {
            const next = new Set(prev);
            next.delete(hypothesisId);
            return next;
          }),
        );
      } catch {
        setFailed(hypothesisId);
      } finally {
        setPending(null);
      }
    },
    [qc, tenant],
  );
  return { kept, keep, failed, pending };
}

export function useSetAutopilot() {
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  return useMutation({
    networkMode: "always",
    mutationFn: (enabled: boolean) =>
      apiJson<{ autopilot: boolean }>("/api/workspace/growth/autopilot", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => qc.refetchQueries({ queryKey: growthKeys.plan(tenant) }),
  });
}

export function useSetChannelAutorun() {
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  return useMutation({
    networkMode: "always",
    mutationFn: ({ slug, autorun }: { slug: string; autorun: boolean }) =>
      apiJson<unknown>(`/api/workspace/growth/channels/${encodeURIComponent(slug)}/autorun`, {
        method: "POST",
        body: JSON.stringify({ autorun, ...(slug === "chatgpt_ads" && autorun ? { paid_consent: "chatgpt-growth-v1" } : {}) }),
      }),
    onSuccess: () => qc.refetchQueries({ queryKey: growthKeys.plan(tenant) }),
  });
}

export function useFlagMistake() {
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  return useMutation({
    networkMode: "always",
    mutationFn: (claim: Claim) =>
      apiJson<ClaimReply>("/api/workspace/growth/autopilot-mistake", { method: "POST", body: JSON.stringify(claim) }),
    onSuccess: () => qc.refetchQueries({ queryKey: growthKeys.plan(tenant) }),
  });
}

export function useDecideMove() {
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  return useMutation({
    networkMode: "always",
    mutationFn: async (input: { id: string; action: MoveAction; shipAnyway?: boolean }) => {
      const req = moveRequest(input.id, input.action, input.shipAnyway === true);
      try {
        await apiJson<unknown>(req.path, { method: "POST", ...(req.body ? { body: req.body } : {}) });
        return "done" as const;
      } catch (e) {
        if (input.action === "approve" && !input.shipAnyway && isShipRedRefusal(e as { status?: number; code?: string })) {
          return "needs_confirm" as const;
        }
        throw e;
      }
    },
    onSuccess: (result) => (result === "done" ? qc.refetchQueries({ queryKey: growthKeys.plan(tenant) }) : undefined),
  });
}

function useRefetchPlan() {
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  return () => qc.refetchQueries({ queryKey: growthKeys.plan(tenant) });
}

const GOALS = "/api/workspace/autopilot/goals";

export function useSaveGoal() {
  const refetch = useRefetchPlan();
  return useMutation({
    networkMode: "always",
    mutationFn: async (input: { id: string | null; payload: GoalPayload }) => {
      const body = await apiJson<unknown>(input.id ? `${GOALS}/${encodeURIComponent(input.id)}` : GOALS, {
        method: input.id ? "PATCH" : "POST",
        body: JSON.stringify(input.payload),
      });
      return warningsOf(body);
    },
    onSuccess: () => refetch(),
  });
}

export function usePauseGoal() {
  const refetch = useRefetchPlan();
  return useMutation({
    networkMode: "always",
    mutationFn: (id: string) =>
      apiJson<unknown>(`${GOALS}/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) }),
    onSuccess: () => refetch(),
  });
}

export function useDeleteGoal() {
  const refetch = useRefetchPlan();
  return useMutation({
    networkMode: "always",
    mutationFn: async (id: string) => {
      try {
        await apiJson<unknown>(`${GOALS}/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
      }
    },
    onSuccess: () => refetch(),
  });
}

export function useReorderGoals() {
  const refetch = useRefetchPlan();
  return useMutation({
    networkMode: "always",
    mutationFn: async (writes: Array<{ id: string; priority: number }>) => {
      const results = await Promise.allSettled(
        writes.map((w) =>
          apiJson<unknown>(`${GOALS}/${encodeURIComponent(w.id)}`, { method: "PATCH", body: JSON.stringify({ priority: w.priority }) }),
        ),
      );
      if (results.some((r) => r.status === "rejected")) throw new Error("reorder_failed");
    },
    onSettled: () => refetch(),
  });
}

export function useAcceptGoal() {
  const refetch = useRefetchPlan();
  return useMutation({
    networkMode: "always",
    mutationFn: (id: string) => apiJson<unknown>(`/api/workspace/growth/goals/${encodeURIComponent(id)}/accept`, { method: "POST" }),
    onSuccess: () => refetch(),
  });
}

export function useGoalHistory(goal: GrowthGoal | null) {
  const tenant = useActiveTenant();
  return useQuery<GoalHistoryBody>({
    queryKey: ["growth-goal-history-body", tenant, goal ? `${historyKey(goal)}:${goal.current_value_at ?? ""}:${goal.measurement_mode ?? ""}` : "none"],
    enabled: tenant !== "none" && goal !== null,
    staleTime: 0,
    retry: false,
    queryFn: async () => historyBodyOf(await apiJson<unknown>(`${GOALS}/${encodeURIComponent(goal!.id)}/history`)),
  });
}

export function useEditorLiveRead(metric: string, automatic: boolean, sourceLabel: string): LiveRead | null {
  const tenant = useActiveTenant();
  const [settled, setSettled] = useState("");
  useEffect(() => {
    if (!metric || !automatic) {
      setSettled("");
      return;
    }
    const id = setTimeout(() => setSettled(metric), 350);
    return () => clearTimeout(id);
  }, [metric, automatic]);
  const q = useQuery<LiveRead>({
    queryKey: ["growth-editor-read", tenant, settled],
    enabled: tenant !== "none" && settled !== "" && automatic,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      try {
        const b = await apiJson<{ measured?: boolean; value?: number; source_label?: string }>(
          `${GOALS}/current-value?metric=${encodeURIComponent(settled)}`,
        );
        return {
          loading: false,
          measured: b?.measured === true && typeof b.value === "number",
          value: typeof b?.value === "number" ? b.value : undefined,
          sourceLabel: b?.source_label ?? sourceLabel,
        };
      } catch {
        return { loading: false, measured: false, sourceLabel, failed: true };
      }
    },
  });
  if (!metric || !automatic) return null;
  if (settled !== metric || q.isPending || q.isFetching) return { loading: true, measured: false, sourceLabel };
  return q.data ?? { loading: true, measured: false, sourceLabel };
}

export function useSaveBrandVoice() {
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  return useMutation({
    networkMode: "always",
    mutationFn: async (input: { patch: PersonalizationPatch; colours?: ColourDraft }): Promise<Personalization> => {
      let saved: Personalization;
      try {
        saved = (await apiJson<{ personalization: Personalization }>("/api/personalization", { method: "PUT", body: JSON.stringify(input.patch) }))
          .personalization;
      } catch (e) {
        throw new Error(serverMessage(e as { code?: string; message?: string }, VOICE_SAVE_ERROR));
      }
      await qc.cancelQueries({ queryKey: ["personalization", tenant] });
      qc.setQueryData(["personalization", tenant], saved);
      void qc.invalidateQueries({ queryKey: ["personalization-summary", tenant] });
      if (input.colours) {
        try {
          await apiJson<unknown>("/api/workspace/brand-kit", { method: "PUT", body: JSON.stringify(kitBody(input.colours)) });
        } catch {
          throw new Error(COLOURS_SAVE_ERROR);
        }
        await qc.refetchQueries({ queryKey: ["brand-kit", tenant] });
      }
      return saved;
    },
  });
}

export function useResetBrandKit() {
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  return useMutation({
    networkMode: "always",
    mutationFn: async () => {
      try {
        const body = await apiJson<unknown>("/api/workspace/brand-kit", { method: "DELETE" });
        return brandKitOf(body);
      } catch {
        throw new Error(COLOURS_RESET_ERROR);
      }
    },
    onSuccess: (kit) => qc.setQueryData(["brand-kit", tenant], kit),
  });
}

export function useBrandVoiceDraft(enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ["brand-voice-draft", tenant],
    enabled: enabled && tenant !== "none",
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      try {
        return voiceDraftBodyOf(await apiJson<unknown>("/api/workspace/brand-voice-draft", { method: "POST" }));
      } catch {
        return null;
      }
    },
  });
}

export function useDismissVoiceDraft() {
  const tenant = useActiveTenant();
  const qc = useQueryClient();
  return useMutation({
    networkMode: "always",
    mutationFn: () => apiJson<unknown>("/api/workspace/brand-voice-draft/dismiss", { method: "POST" }),
    onSuccess: () => qc.setQueryData(["brand-voice-draft", tenant], null),
  });
}
