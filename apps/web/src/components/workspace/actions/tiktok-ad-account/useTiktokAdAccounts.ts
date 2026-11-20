import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdAccountError,
  addAdAccount,
  loadAdAccounts,
  refreshAdAccounts,
  selectAdAccount,
  type AdAccountsState,
} from "./api";

type Busy = "loading" | "refreshing" | "selecting" | "adding" | null;

export function useTiktokAdAccounts(onChanged?: () => void) {
  const [state, setState] = useState<AdAccountsState | null>(null);
  const [busy, setBusy] = useState<Busy>("loading");
  const [error, setError] = useState<AdAccountError | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const run = useCallback(
    async (kind: Exclude<Busy, null>, work: () => Promise<AdAccountsState>, notify = true) => {
      setBusy(kind);
      setError(null);
      try {
        const next = await work();
        setState(next);
        if (notify) changed.current?.();
        return true;
      } catch (e) {
        setError(e instanceof AdAccountError ? e : new AdAccountError("failed", "Something went wrong. Try again."));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  useEffect(() => {
    void run("loading", loadAdAccounts, false);
  }, [run]);

  return {
    state,
    busy,
    error,
    refresh: () => run("refreshing", refreshAdAccounts),
    select: (id: string) => run("selecting", () => selectAdAccount(id)),
    add: (input: string) => run("adding", () => addAdAccount(input)),
    clearError: () => setError(null),
  };
}
