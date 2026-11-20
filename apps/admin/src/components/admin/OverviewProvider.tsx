"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import type { Overview } from "@/lib/overview";

type Ctx = {
  data: Overview | null;
  error: string | null;
  loading: boolean;
  refresh: (opts?: { ifOlderThanMs?: number }) => void;
};

const OverviewCtx = createContext<Ctx>({ data: null, error: null, loading: false, refresh: () => {} });

export function useOverview(): Ctx {
  return useContext(OverviewCtx);
}

export function OverviewProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetchedAt = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const res = await adminApiFetch("/api/admin/overview");
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setData(r as Overview);
      setError(null);
      fetchedAt.current = Date.now();
    } catch (e) {
      setError((e as Error).message || "Could not load the overview");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(
    (opts?: { ifOlderThanMs?: number }) => {
      const age = Date.now() - fetchedAt.current;
      if (opts?.ifOlderThanMs != null && fetchedAt.current > 0 && age < opts.ifOlderThanMs) return;
      void load();
    },
    [load],
  );

  return <OverviewCtx.Provider value={{ data, error, loading, refresh }}>{children}</OverviewCtx.Provider>;
}
