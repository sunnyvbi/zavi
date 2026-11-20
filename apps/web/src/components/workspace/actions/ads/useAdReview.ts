import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AdReviewResponse } from "@zavi/shared";
import { campaignFetch } from "../managed-campaigns/api";

interface ReviewState { id: string; value: AdReviewResponse | null; error: string | null; loading: boolean; }

export function useNearScreen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setNear(true);
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

export function useAdReview(id: string | null, revision?: string, execState = "") {
  const [state, setState] = useState<ReviewState | null>(null);
  const [refresh, setRefresh] = useState(0);
  const retry = useCallback(() => setRefresh((value) => value + 1), []);
  const scope = `${id ?? ""}:${revision ?? ""}:${execState}`;
  useEffect(() => {
    if (!id) return;
    let active = true;
    setState((previous) => ({ id: scope, value: previous?.id === scope ? previous.value : null, error: null, loading: true }));
    void campaignFetch<AdReviewResponse>(`/api/channel-actions/${encodeURIComponent(id)}/ad-review${refresh ? "?refresh=1" : ""}`)
      .then((value) => { if (active) setState({ id: scope, value, loading: false, error: null }); })
      .catch((error: unknown) => { if (active) setState((previous) => ({ id: scope, value: previous?.id === scope ? previous.value : null, loading: false, error: error instanceof Error ? error.message : "Could not load the saved preview." })); });
    return () => { active = false; };
  }, [id, refresh, scope]);
  const current = state?.id === scope ? state : null;
  return { value: current?.value ?? null, error: current?.error ?? null, loading: !!id && (!current || current.loading), retry };
}
