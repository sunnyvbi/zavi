"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import type { ClientContext } from "./types";

export const CONTEXT_SECTIONS = ["company", "goals", "channels", "analytics", "competitors"] as const;
export type ContextSectionKey = (typeof CONTEXT_SECTIONS)[number];

export type SectionState<K extends ContextSectionKey = ContextSectionKey> = {
  data: ClientContext[K] | null;
  loading: boolean;
  error: string | null;
};

export type SectionStates = { [K in ContextSectionKey]: SectionState<K> };

const IDLE: SectionState = { data: null, loading: false, error: null };

function emptyStates(): SectionStates {
  return Object.fromEntries(CONTEXT_SECTIONS.map((key) => [key, IDLE])) as SectionStates;
}

type Store = { tenantId: string; states: SectionStates };

export function useClientContext(tenantId: string) {
  const [store, setStore] = useState<Store>(() => ({ tenantId, states: emptyStates() }));
  const storeRef = useRef(store);
  storeRef.current = store;

  const patch = useCallback((forTenant: string, updater: (states: SectionStates) => SectionStates) => {
    setStore((current) => {
      const base = current.tenantId === forTenant ? current.states : emptyStates();
      const states = updater(base);
      storeRef.current = { tenantId: forTenant, states };
      return storeRef.current;
    });
  }, []);

  const load = useCallback(
    async (keys: ContextSectionKey[], fresh = false) => {
      const forTenant = tenantId;
      if (!forTenant || keys.length === 0) return;
      patch(forTenant, (states) => {
        const next = { ...states };
        for (const key of keys) next[key] = { ...next[key], loading: true, error: null } as never;
        return next;
      });
      const params = new URLSearchParams({ tenant_id: forTenant, sections: keys.join(",") });
      if (fresh) params.set("fresh", "1");
      try {
        const res = await adminApiFetch(`/api/admin/suggestions/context?${params}`);
        const payload = await res.json();
        if (!res.ok) throw new Error(payload?.error?.message ?? `HTTP ${res.status}`);
        patch(forTenant, (states) => {
          const next = { ...states };
          for (const key of keys) {
            const data = payload[key] ?? null;
            next[key] = data
              ? ({ data, loading: false, error: null } as never)
              : ({ data: null, loading: false, error: `The ${key} section was missing from the response.` } as never);
          }
          return next;
        });
      } catch (caught) {
        const message = (caught as Error).message;
        patch(forTenant, (states) => {
          const next = { ...states };
          for (const key of keys) next[key] = { ...next[key], loading: false, error: message } as never;
          return next;
        });
      }
    },
    [tenantId, patch],
  );

  const ensure = useCallback(
    (keys: ContextSectionKey[]) => {
      const current = storeRef.current;
      const states = current.tenantId === tenantId ? current.states : emptyStates();
      const pending = keys.filter((key) => {
        const state = states[key];
        return !state.data && !state.loading;
      });
      return load(pending);
    },
    [load, tenantId],
  );

  const reload = useCallback((keys: ContextSectionKey[]) => load(keys, true), [load]);

  const sections = useMemo(
    () => (store.tenantId === tenantId ? store.states : emptyStates()),
    [store, tenantId],
  );

  return { sections, ensure, reload };
}
