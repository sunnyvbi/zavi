import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import type { JobDetail, JobSummary } from "./ugc";
import { ugcKey } from "./ugcHooks";
import {
  FULFIL_POLL_MS,
  LIVE_REFETCH_MS,
  POLL_IDLE,
  actionBody,
  actionPath,
  checkoutPath,
  fulfilPath,
  paymentState,
  pollAfterTry,
  pollStarted,
  publicationsPath,
  reviewBody,
  reviewPath,
  verifyPath,
  type FulfilAnswer,
  type FulfilPoll,
  type Publication,
  type PublicationsResponse,
  type ReviewScores,
} from "./ugcJob";

const NO_REPLAY = { method: "POST", retryOnNetworkError: false } as const;

export function useFulfilPoll(orderId: string, pending: boolean, enabled: boolean) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  const [poll, setPoll] = useState<FulfilPoll>(POLL_IDLE);
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = useRef(false);

  const stop = useCallback(() => {
    run.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const start = useCallback(() => {
    stop();
    if (!active.current) return;
    const mine = run.current;
    let state = pollStarted();
    setPoll(state);
    const step = async () => {
      timer.current = null;
      let answer: FulfilAnswer | null = null;
      try {
        answer = await apiJson<FulfilAnswer>(fulfilPath(orderId), { ...NO_REPLAY, body: JSON.stringify({}) });
      } catch {
        answer = null;
      }
      if (run.current !== mine) return;
      const next = pollAfterTry(state, answer);
      state = next.poll;
      setPoll(state);
      if (next.next === "refetch") void queryClient.invalidateQueries({ queryKey: ["ugc", tenant] });
      else if (next.next === "wait") timer.current = setTimeout(() => void step(), FULFIL_POLL_MS);
    };
    void step();
  }, [orderId, tenant, queryClient, stop]);

  useEffect(() => {
    if (!enabled || !pending || tenant === "none" || !orderId) {
      active.current = false;
      stop();
      return;
    }
    active.current = true;
    start();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") start();
    });
    return () => {
      active.current = false;
      sub.remove();
      stop();
    };
  }, [enabled, pending, tenant, orderId, start, stop]);

  return { state: paymentState(poll), polling: poll.running, restart: start };
}

export function useLiveRefetch(refetch: () => unknown, live: boolean) {
  const latest = useRef(refetch);
  latest.current = refetch;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      if (AppState.currentState === "active") void latest.current();
    }, LIVE_REFETCH_MS);
    return () => clearInterval(t);
  }, [live]);
}

export function useResumeCheckout() {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (job: Pick<JobSummary, "id" | "source" | "offer_id">) =>
      apiJson<{ order_id?: string; checkout_url: string | null }>(checkoutPath(job), { ...NO_REPLAY, body: JSON.stringify({}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}

type ActionResult = { ok: true; from?: string; to?: string; detail: JobDetail | null };

export function useJobAction(orderId: string) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { action: string; note?: string }) =>
      apiJson<ActionResult>(actionPath(orderId), { ...NO_REPLAY, body: JSON.stringify(actionBody(v.action, v.note)) }),
    onSuccess: (r) => {
      if (r?.detail) queryClient.setQueryData(ugcKey(tenant, "job", orderId), r.detail);
      void queryClient.invalidateQueries({ queryKey: ["ugc", tenant] });
    },
  });
}

export function useJobReview(orderId: string, enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ugcKey(tenant, "review", orderId),
    enabled: enabled && tenant !== "none" && !!orderId,
    queryFn: async () => (await apiJson<{ review: Record<string, unknown> | null }>(reviewPath(orderId))).review ?? null,
  });
}

export function usePostReview(orderId: string) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { scores: ReviewScores; note: string }) =>
      apiJson<{ ok: true; review_id: string }>(reviewPath(orderId), { ...NO_REPLAY, body: JSON.stringify(reviewBody(v.scores, v.note)) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ugc", tenant] }),
  });
}

export function usePublications(orderId: string, enabled: boolean) {
  const tenant = useActiveTenant();
  return useQuery({
    queryKey: ugcKey(tenant, "publications", orderId),
    enabled: enabled && tenant !== "none" && !!orderId,
    queryFn: () => apiJson<PublicationsResponse>(publicationsPath(orderId)),
  });
}

export function useAddPublication(orderId: string) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiJson<{ publication: Publication }>(publicationsPath(orderId), { ...NO_REPLAY, body: JSON.stringify(body) }),
    onSuccess: (r) => {
      queryClient.setQueryData<PublicationsResponse>(ugcKey(tenant, "publications", orderId), (old) =>
        old && r?.publication ? { ...old, publications: [...old.publications, r.publication] } : old,
      );
      void queryClient.invalidateQueries({ queryKey: ["ugc", tenant] });
    },
  });
}

export function useVerifyPublication(orderId: string) {
  const tenant = useActiveTenant();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (publicationId: string) =>
      apiJson<{ publication: Publication | null }>(verifyPath(publicationId), { ...NO_REPLAY, body: JSON.stringify({}) }),
    onSuccess: (r) => {
      const fresh = r?.publication;
      if (fresh) {
        queryClient.setQueryData<PublicationsResponse>(ugcKey(tenant, "publications", orderId), (old) =>
          old ? { ...old, publications: old.publications.map((p) => (p.id === fresh.id ? fresh : p)) } : old,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["ugc", tenant] });
    },
  });
}
