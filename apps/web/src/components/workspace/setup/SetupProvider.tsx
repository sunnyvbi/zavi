"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { SETUP_BUSINESS_STEP, SETUP_CONNECT_STEP, SETUP_STEP_PARAM } from "@/lib/onboardingRoutes";
import { useWorkspace } from "../WorkspaceShell";
import {
  isBuildOpen, isSetupLocked,
  type SetupResponse, type SetupState,
} from "./setupState";
import { runDraftStarter, shouldAutoStartDraft } from "./draftStarter";
import { useImportReads, type ImportReads } from "./importReads";
import { loadAfterRead, saveAfterRead, type AfterRead } from "./importReadState";
import { useSetupHandoff } from "./useSetupHandoff";
import { useSetupState, type Mark } from "./useSetupState";

export type SetupContextValue = {
  state: SetupResponse | null;
  loadError: boolean;
  locked: boolean;
  pending: boolean;
  buildOpen: boolean;
  canManageSetup: boolean;
  finishNote: string | null;
  setFinishNote: (note: string | null) => void;
  refresh: () => Promise<void>;
  mark: (m: Mark) => Promise<SetupState | null>;
  startDraft: (retry?: boolean, paid?: boolean) => Promise<void>;
  draftBlocked: "insufficient_credits" | null;
  draftStarting: boolean;
  draftStartFailed?: boolean;
  draftStartError: string | null;
  imports: ImportReads;
  afterRead: AfterRead | null;
  setAfterRead: (a: AfterRead | null) => void;
};

export type { AfterRead };

const SetupContext = createContext<SetupContextValue | null>(null);

export function useSetupOptional(): SetupContextValue | null {
  return useContext(SetupContext);
}

export function useSetupOn(): SetupState | null {
  const s = useSetupOptional()?.state;
  return s && s.enabled === true ? s : null;
}

export function useSetupActive(): SetupState | null {
  const ctx = useSetupOptional();
  const s = ctx?.state;
  return ctx?.locked && s && s.enabled === true && !s.from_scratch ? s : null;
}

export function SetupProvider({ children }: { children: ReactNode }) {
  const search = useSearchParams();
  const { state, loadError, refresh, mark } = useSetupState();
  const { tabs, activeTabId, role, buildSessionId } = useWorkspace();
  const canManageSetup = role === "owner" || role === "admin";
  const expected = useSetupHandoff(state, canManageSetup);
  const unknownState = state === null && loadError && canManageSetup;
  const locked = isSetupLocked(state, role) || unknownState;
  const pending = (expected || search.get(SETUP_STEP_PARAM) === SETUP_CONNECT_STEP || search.get(SETUP_STEP_PARAM) === SETUP_BUSINESS_STEP) && state === null && !loadError && canManageSetup;
  const activeKind = tabs.find((t) => t.id === activeTabId)?.kind;

  const buildOpen = isBuildOpen(state) || (unknownState && activeKind === "build" && !!buildSessionId);

  const starting = useRef(false);
  const resumed = useRef(false);
  const [draftBlocked, setDraftBlocked] = useState<"insufficient_credits" | null>(null);
  const [draftStarting, setDraftStarting] = useState(false);
  const [draftStartFailed, setDraftStartFailed] = useState(false);
  const [draftStartError, setDraftStartError] = useState<string | null>(null);
  const startDraft = useCallback(async (retry = false, paid = false) => {
    if (starting.current) return;
    starting.current = true;
    setDraftStarting(true);
    setDraftStartFailed(false);
    setDraftStartError(null);
    try {
      const out = await runDraftStarter(
        () => apiFetch("/api/workspace/setup/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retry, paid }) }),
        { retry, attempts: 120, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      );
      setDraftBlocked("insufficientCredits" in out ? "insufficient_credits" : null);
      setDraftStartFailed(!("status" in out));
      setDraftStartError("gaveUp" in out || "refused" in out
        ? "We couldn't start or save your strategy. Please try again." : null);
    } finally {
      starting.current = false;
      await refresh();
      setDraftStarting(false);
    }
  }, [refresh]);

  useEffect(() => {
    if (resumed.current || !state || !state.enabled || !shouldAutoStartDraft(state)) return;
    if (!(locked || (state.done && canManageSetup))) return;
    resumed.current = true;
    void startDraft(false);
  }, [state, locked, canManageSetup, startDraft]);
  const [finishNote, setFinishNote] = useState<string | null>(null);
  const [afterRead, setAfterReadState] = useState<AfterRead | null>(null);
  useEffect(() => {
    const saved = loadAfterRead();
    if (saved) setAfterReadState(saved);
  }, []);
  const setAfterRead = useCallback((a: AfterRead | null) => {
    setAfterReadState(a);
    saveAfterRead(a);
  }, []);
  const imports = useImportReads(canManageSetup && !!state && state.enabled === true && !state.home_seen);

  const value = useMemo<SetupContextValue>(
    () => ({ state, loadError, locked, pending, buildOpen, canManageSetup, finishNote, setFinishNote, refresh, mark, startDraft, draftBlocked, draftStarting, draftStartFailed, draftStartError, imports, afterRead, setAfterRead }),
    [state, loadError, locked, pending, buildOpen, canManageSetup, finishNote, refresh, mark, startDraft, draftBlocked, draftStarting, draftStartFailed, draftStartError, imports, afterRead, setAfterRead],
  );
  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
}
