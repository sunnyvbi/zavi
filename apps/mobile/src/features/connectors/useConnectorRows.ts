import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetchConnectorRows } from "./api";
import type { ConnectorListRow } from "./connectPlan";

export function useConnectorRows(enabled = true): {
  rows: ConnectorListRow[] | null;
  failed: boolean;
  refresh: () => void;
} {
  const [rows, setRows] = useState<ConnectorListRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const id = ++seq.current;
    fetchConnectorRows()
      .then((r) => {
        if (!alive.current || id !== seq.current) return;
        setRows(r);
        setFailed(false);
      })
      .catch(() => {
        if (!alive.current || id !== seq.current) return;
        setFailed(true);
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => void (alive.current = false);
    refresh();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });
    return () => {
      alive.current = false;
      sub.remove();
    };
  }, [enabled, refresh]);

  return { rows, failed, refresh };
}
