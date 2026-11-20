"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionHandlers, ActionItem } from "./types";

const SETTLE_MS = 15_000;

export function useApproving(a: ActionItem, handlers: ActionHandlers): { approving: boolean; handlers: ActionHandlers } {
  const [approving, setApproving] = useState(false);
  const timer = useRef<number | null>(null);
  const key = `${a.exec_status ?? ""}:${a.status}`;
  useEffect(() => {
    setApproving(false);
  }, [key]);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const onApprove = handlers.onApprove;
  const wrapped = useMemo<ActionHandlers>(() => {
    if (!onApprove) return handlers;
    return {
      ...handlers,
      onApprove: async (item: ActionItem) => {
        setApproving(true);
        try {
          const ok = await onApprove(item);
          if (ok === false) {
            setApproving(false);
            return ok;
          }
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setApproving(false), SETTLE_MS);
          return ok;
        } catch (e) {
          setApproving(false);
          throw e;
        }
      },
    };
  }, [handlers, onApprove]);
  return { approving, handlers: wrapped };
}
