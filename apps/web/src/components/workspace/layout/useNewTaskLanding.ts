"use client";

import { useEffect, useRef } from "react";
import {
  isBareWorkspaceLanding,
  readWorkspaceLocation,
} from "../navigation/workspaceRoutes";

export function useNewTaskLanding(
  openAgentTab: (slug: string) => Promise<string>,
): void {
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    if (!isBareWorkspaceLanding(readWorkspaceLocation())) return;
    let pending = true;
    const timer = window.setTimeout(() => {
      pending = false;
      void openAgentTab("operator");
    }, 0);
    return () => {
      if (pending) {
        window.clearTimeout(timer);
        handled.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
