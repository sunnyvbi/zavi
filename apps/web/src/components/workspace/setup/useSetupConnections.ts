"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { ConnectorListRow } from "@/app/connectors/connectStrategies";

type Connections = {
  rows: ConnectorListRow[];
  teams: { configured: boolean; connected: boolean };
  loading: boolean;
  error: string | null;
};
export function useSetupConnections(watching: boolean) {
  const [state, setState] = useState<Connections>({ rows: [], teams: { configured: false, connected: false }, loading: true, error: null });
  const alive = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const request = (async () => {
      const results = await Promise.allSettled([
        apiFetch("/api/connectors").then(async (response) => {
          if (!response.ok) throw new Error("Couldn't load your connected apps. Try again.");
          const body = await response.json() as { connectors?: ConnectorListRow[] } | ConnectorListRow[];
          const rows = Array.isArray(body) ? body : body.connectors;
          if (!Array.isArray(rows)) throw new Error("Couldn't load your connected apps. Try again.");
          return rows;
        }),
        apiFetch("/api/connectors/teams/status").then(async (response) => {
          if (!response.ok) throw new Error("Teams is unavailable");
          return await response.json() as Connections["teams"];
        }),
      ]);
      if (!alive.current) return;
      const [rows, teams] = results;
      setState((previous) => ({
        rows: rows.status === "fulfilled" ? rows.value : previous.rows,
        teams: teams.status === "fulfilled" ? teams.value : previous.teams,
        loading: false,
        error: rows.status === "fulfilled" ? null : "Couldn't load your connected apps. Try again.",
      }));
    })();
    inFlight.current = request;
    void request.finally(() => { inFlight.current = null; });
    return request;
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const onFocus = () => void refresh();
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => window.clearInterval(timer);
  }, [watching, refresh]);
  const rows = state.teams.connected && !state.rows.some((row) => row.slug === "teams") ? [...state.rows, { slug: "teams" }] : state.rows;
  return { ...state, rows, refresh };
}
