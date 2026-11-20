import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { useWorkspace } from "../workspaces/WorkspaceProvider";
import { useActiveTenant } from "../workspaces/useActiveTenant";
import { useAiConsent } from "../consent/useAiConsent";
import { readRetry, readRetryDelay } from "../../lib/apiRetry";
import { fetchImports, fetchSetup, kickRead, postDraft, postProgress } from "./api";
import { DRAFT_ATTEMPTS, runDraftStarter } from "./draftStarter";
import { fileFromServer, filesToKick, nextPollMs, type ImportFile } from "./imports";
import { setupGateOf, shouldAutoStartDraft, type SetupGate } from "./state";
import type { SetupMark, SetupResponse, SetupState } from "./types";

export const setupKey = (tenant: string) => ["workspace-setup", tenant] as const;
const MOVED = "Your workspace is changing. Try again in a moment.";

export type ImportReads = {
  files: ImportFile[] | null;
  failures: number;
  refresh: () => Promise<void>;
};

export type SetupContextValue = {
  state: SetupResponse | undefined;
  loadError: boolean;
  gate: SetupGate;
  canManage: boolean;
  refresh: () => Promise<void>;
  mark: (m: SetupMark) => Promise<SetupState | null>;
  startDraft: () => void;
  imports: ImportReads;
  sequence: <T>(fn: (same: () => boolean) => Promise<T>) => Promise<T>;
  busy: boolean;
};

const Ctx = createContext<SetupContextValue | null>(null);

export function useSetup(): SetupContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSetup must be used inside <SetupProvider>");
  return v;
}

function useImportReads(enabled: boolean, scope: string, mayKick: boolean): ImportReads {
  const [files, setFiles] = useState<ImportFile[] | null>(null);
  const [failures, setFailures] = useState(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const kicked = useRef(new Set<string>());
  const inFlight = useRef(false);

  useEffect(() => {
    setFiles(null);
    setFailures(0);
    kicked.current = new Set();
  }, [scope]);

  const refresh = useCallback(async () => {
    if (scopeRef.current === "none") return;
    const askedFor = scopeRef.current;
    inFlight.current = true;
    try {
      const rows = await fetchImports();
      if (scopeRef.current !== askedFor) return;
      if (!rows) {
        setFailures((n) => n + 1);
        return;
      }
      const now = Date.now();
      setFiles(rows.map((r) => fileFromServer(r, now)));
      setFailures(0);
    } finally {
      inFlight.current = false;
    }
  }, []);

  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || scope === "none" || asked.current === scope) return;
    asked.current = scope;
    void refresh();
  }, [enabled, scope, refresh]);

  const delay = nextPollMs({ enabled, files, failures });
  useEffect(() => {
    if (delay === null || scope === "none") return;
    const id = setTimeout(() => {
      if (!inFlight.current) void refresh();
    }, delay);
    return () => clearTimeout(id);
  }, [delay, files, failures, scope, refresh]);

  useEffect(() => {
    if (!mayKick) return;
    for (const id of filesToKick(files ?? [], kicked.current, Date.now())) {
      kicked.current.add(id);
      kickRead(id);
    }
  }, [files, mayKick]);

  return useMemo(() => ({ files, failures, refresh }), [files, failures, refresh]);
}

export function SetupProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const tenant = useActiveTenant();
  const { session } = useAuth();
  const scope = tenant === "none" ? "none" : `${session?.user?.id ?? "?"}:${tenant}`;
  const { tenants, activeTenantId, loading: workspacesLoading, moveMark } = useWorkspace();
  const consent = useAiConsent();
  const role: string | null | undefined = workspacesLoading
    ? undefined
    : activeTenantId
      ? (tenants.find((t) => t.tenant_id === activeTenantId)?.role ?? null)
      : null;
  const canManage = role === "owner" || role === "admin";

  const query = useQuery<SetupResponse>({
    queryKey: setupKey(tenant),
    enabled: tenant !== "none" && canManage,
    queryFn: fetchSetup,
    retry: readRetry,
    retryDelay: readRetryDelay,
  });
  const state = query.data;
  const gate = setupGateOf({ role, data: state, pending: query.isPending && query.fetchStatus === "fetching" });

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: setupKey(tenant) });
  }, [qc, tenant]);

  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const mark = useCallback(
    async (m: SetupMark) => {
      const askedFor = tenant;
      const startMark = moveMark();
      if (scopeRef.current !== scope || startMark === null) throw new Error(MOVED);
      const next = await postProgress(m);
      qc.setQueryData(setupKey(askedFor), next);
      if (scopeRef.current !== scope || moveMark() !== startMark) throw new Error(MOVED);
      return next.enabled ? next : null;
    },
    [qc, tenant, scope, moveMark],
  );

  const [running, setRunning] = useState(0);
  const sequence = useCallback(async <T,>(fn: (same: () => boolean) => Promise<T>): Promise<T> => {
    const startedIn = scopeRef.current;
    const startMark = moveMark();
    if (startMark === null) throw new Error(MOVED);
    setRunning((n) => n + 1);
    try {
      return await fn(() => scopeRef.current === startedIn && moveMark() === startMark);
    } finally {
      setRunning((n) => n - 1);
    }
  }, [moveMark]);

  const tenantRef = useRef(tenant);
  tenantRef.current = tenant;
  const agreedRef = useRef(consent.agreed);
  agreedRef.current = consent.agreed;
  const starting = useRef<string | null>(null);
  const startDraft = useCallback(() => {
    const startedFor = scopeRef.current;
    const tenantFor = tenantRef.current;
    if (startedFor === "none" || !agreedRef.current || starting.current === startedFor) return;
    starting.current = startedFor;
    const cancelled = () => scopeRef.current !== startedFor || moveMark() === null;
    void runDraftStarter(() => postDraft(false), {
      attempts: DRAFT_ATTEMPTS,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      cancelled,
    }).finally(() => {
      if (starting.current === startedFor) starting.current = null;
      if (!cancelled()) void qc.invalidateQueries({ queryKey: setupKey(tenantFor) });
    });
  }, [qc, moveMark]);

  const resumed = useRef(new Set<string>());
  useEffect(() => {
    if (!canManage || !consent.agreed || !state || !state.enabled || !shouldAutoStartDraft(state)) return;
    if (resumed.current.has(scope)) return;
    resumed.current.add(scope);
    startDraft();
  }, [state, canManage, consent.agreed, scope, startDraft]);

  const imports = useImportReads(canManage && consent.agreed && gate === "active", scope, consent.agreed);

  const value = useMemo<SetupContextValue>(
    () => ({
      state,
      loadError: query.isError && !state,
      gate,
      canManage,
      refresh,
      mark,
      startDraft,
      imports,
      sequence,
      busy: running > 0,
    }),
    [state, query.isError, gate, canManage, refresh, mark, startDraft, imports, sequence, running],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
