import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { apiJson } from "../../lib/api";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { readTenantCommands, type TenantCommandsState } from "./tenantCommands";

const EMPTY: TenantCommandsState = { commands: [], loaded: false, failed: false };

export function useTenantCommands(): TenantCommandsState & { refresh: () => void } {
  const tenant = useActiveTenant();
  const [state, setState] = useState<TenantCommandsState>(EMPTY);
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    apiJson<unknown>("/api/commands")
      .then((body) => {
        if (id === seq.current) setState({ commands: readTenantCommands(body), loaded: true, failed: false });
      })
      .catch(() => {
        if (id === seq.current) setState({ commands: [], loaded: true, failed: true });
      });
  }, []);

  useEffect(() => {
    if (tenant === "none") return;
    setState((s) => (s === EMPTY ? s : EMPTY));
    load();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") load();
    });
    return () => {
      seq.current += 1;
      sub.remove();
    };
  }, [tenant, load]);

  return useMemo(() => ({ ...state, refresh: load }), [state, load]);
}
