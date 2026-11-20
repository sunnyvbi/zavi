"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StartCard } from "@zavi/shared";
import { createStartCard, getStartCard, rememberMyCard, StartCardApiError } from "@/lib/start-card/api";
import { useStartCardCaptcha } from "@/components/start-card/useTurnstileConfig";

export const POLL_MS = 2_000;
export const POLL_GIVE_UP_MS = 8 * 60_000;

export type StartCardState =
  | { phase: "idle" }
  | { phase: "captcha"; domain: string }
  | { phase: "creating"; domain: string }
  | { phase: "card"; domain: string; publicId: string; card: StartCard | null; stalled: boolean }
  | { phase: "queued"; domain: string }
  | { phase: "error"; domain: string; message: string };

export function useStartCard(ref: string | null) {
  const captcha = useStartCardCaptcha();
  const [state, setState] = useState<StartCardState>({ phase: "idle" });
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = token;
  const genRef = useRef(0);

  const create = useCallback(
    async (domain: string, gen: number) => {
      setState({ phase: "creating", domain });
      const turnstile = tokenRef.current;
      setToken(null);
      try {
        const res = await createStartCard({ url: domain, turnstile_token: turnstile, ref });
        if (gen !== genRef.current) return;
        if (res.state === "queued") setState({ phase: "queued", domain });
        else {
          rememberMyCard(res.public_id);
          setState({ phase: "card", domain, publicId: res.public_id, card: null, stalled: false });
        }
      } catch (e) {
        if (gen !== genRef.current) return;
        setState({
          phase: "error",
          domain,
          message: e instanceof StartCardApiError ? e.message : "We couldn't start your growth check. Please try again.",
        });
      }
    },
    [ref],
  );

  const start = useCallback(
    (domain: string) => {
      if (state.phase !== "idle" && state.phase !== "error" && state.domain === domain) return;
      ++genRef.current;
      setState({ phase: "captcha", domain });
    },
    [state],
  );

  useEffect(() => {
    if (state.phase !== "captcha" || captcha === undefined) return;
    if (captcha?.required && !token) return;
    void create(state.domain, genRef.current);
  }, [state, captcha, token, create]);

  const publicId = state.phase === "card" ? state.publicId : null;
  useEffect(() => {
    if (!publicId) return;
    const gen = genRef.current;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      let card: StartCard | null = null;
      try {
        card = await getStartCard(publicId, { cache: "no-store" });
      } catch {
      }
      if (stopped || gen !== genRef.current) return;
      const giveUp = Date.now() - started > POLL_GIVE_UP_MS;
      if (card) {
        setState((s) => (s.phase === "card" && s.publicId === publicId ? { ...s, card, stalled: giveUp } : s));
      } else if (giveUp) {
        setState((s) => (s.phase === "card" && s.publicId === publicId ? { ...s, stalled: true } : s));
      }
      if (card && card.status !== "running" && card.status !== "queued") return;
      if (giveUp) return;
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [publicId]);

  return { state, start, captcha, setToken };
}
