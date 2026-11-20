import { useEffect, useRef, useState } from "react";
import { HOME_AGENT_SLUG } from "@/lib/workspace/tabUrl";
import { useWorkspace } from "../WorkspaceShell";
import { useOpenStatic } from "../layout/shared";
import { clearSetupExpected, readSetupExpected, type SetupResponse } from "./setupState";

const SETUP_READ_WAIT_MS = 12_000;

export function useSetupHandoff(state: SetupResponse | null, canManageSetup: boolean) {
  const [expected, setExpected] = useState(false);
  const wasRunning = useRef(false);
  const { tabs, activeTabId, openAgentTab } = useWorkspace();
  const openStatic = useOpenStatic();
  const activeKind = tabs.find((tab) => tab.id === activeTabId)?.kind;

  useEffect(() => {
    setExpected(readSetupExpected());
  }, []);

  useEffect(() => {
    if (!expected || state) return;
    const id = window.setTimeout(() => setExpected(false), SETUP_READ_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [expected, state]);

  useEffect(() => {
    if (!state) return;
    if (state.enabled !== true) {
      if (expected && canManageSetup) openStatic("autopilot");
      clearSetupExpected();
      setExpected(false);
      wasRunning.current = false;
      return;
    }
    if (state.done) {
      clearSetupExpected();
      setExpected(false);
      if (wasRunning.current && canManageSetup && activeKind === "autopilot") {
        void openAgentTab(HOME_AGENT_SLUG, { newThread: true, push: true });
      }
    }
    wasRunning.current = !state.done && canManageSetup;
  }, [state, expected, canManageSetup, activeKind, openAgentTab, openStatic]);

  return expected;
}
