"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

export type HumanLoadState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  sessionExpired: boolean;
  notBuilt: boolean;
  reload: () => void;
};

export function useHumanResource<T>(path: string): HumanLoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [notBuilt, setNotBuilt] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++latest.current;
    const stale = () => !mounted.current || mine !== latest.current;
    try {
      const res = await apiFetch(path);
      if (stale()) return;
      if (res.status === 401) {
        setSessionExpired(true);
        setError(null);
        return;
      }
      if (res.status === 404 || res.status === 501) {
        setNotBuilt(true);
        setError(null);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const payload = (await res.json()) as T;
      if (stale()) return;
      setData(payload);
      setError(null);
      setSessionExpired(false);
      setNotBuilt(false);
    } catch (e) {
      if (stale()) return;
      setError((e as Error).message ?? "Network error");
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const reload = useCallback(() => {
    setError(null);
    setNotBuilt(false);
    setLoading(true);
    void load();
  }, [load]);

  return { data, loading, error, sessionExpired, notBuilt, reload };
}
