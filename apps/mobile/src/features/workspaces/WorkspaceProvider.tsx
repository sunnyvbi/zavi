import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import { friendlyError } from "../../components/ErrorCard";
import { useAuth } from "../../auth/AuthProvider";
import {
  currentTenantClaim,
  refreshSessionUntilClaim,
} from "../../lib/tenant-claim";
import { track } from "../../lib/analytics";
import { registerForPush } from "../../lib/push";
import { fetchMyTenants, switchTenant, type TenantMembership } from "./api";

const ACTIVE_KEY = "zavi.activeTenantId";
const CLAIM_ERROR = "Couldn't switch workspace. Try again.";

type WorkspaceState = {
  tenants: TenantMembership[];
  activeTenantId: string | null;
  loading: boolean;
  switching: boolean;
  error: string | null;
  switchTo: (tenantId: string) => Promise<void>;
  refresh: (prefer?: string) => Promise<boolean>;
  moveMark: () => number | null;
};

const Ctx = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { session } = useAuth();
  const [tenants, setTenants] = useState<TenantMembership[]>([]);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moves = useRef({ started: 0, running: 0 });
  const moveMark = useCallback(() => (moves.current.running > 0 ? null : moves.current.started), []);

  const load = useCallback(async (prefer?: string): Promise<boolean> => {
    moves.current.started += 1;
    moves.current.running += 1;
    setLoading(true);
    setError(null);
    try {
      const { tenants: list } = await fetchMyTenants();
      setTenants(list);
      if (list.length === 0) {
        setActiveTenantId(null);
        return false;
      }
      const persisted = prefer ?? (await AsyncStorage.getItem(ACTIVE_KEY));
      const chosen =
        list.find((t) => t.tenant_id === persisted)?.tenant_id ?? list[0].tenant_id;
      await switchTenant(chosen);
      if ((await currentTenantClaim()) !== chosen) {
        const converged = await refreshSessionUntilClaim(chosen);
        if (!converged) {
          setActiveTenantId(null);
          setError(CLAIM_ERROR);
          return false;
        }
      }
      await AsyncStorage.setItem(ACTIVE_KEY, chosen);
      setActiveTenantId(chosen);
      return true;
    } catch (e) {
      setError(friendlyError(e, "Could not load your workspaces."));
      return false;
    } finally {
      moves.current.running -= 1;
      setLoading(false);
    }
  }, []);

  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (!userId) {
      setTenants([]);
      setActiveTenantId(null);
      setLoading(false);
      setError(null);
      return;
    }
    void load();
  }, [userId, load]);

  const switchTo = useCallback(
    async (tenantId: string) => {
      if (tenantId === activeTenantId) return;
      setError(null);
      setSwitching(true);
      moves.current.started += 1;
      moves.current.running += 1;
      try {
        await switchTenant(tenantId);
        const converged = await refreshSessionUntilClaim(tenantId);
        if (!converged) {
          setError(CLAIM_ERROR);
          throw new Error(CLAIM_ERROR);
        }
        await AsyncStorage.setItem(ACTIVE_KEY, tenantId);
        qc.clear();
        setActiveTenantId(tenantId);
        track("workspace_switched");
        void registerForPush().catch(() => {});
      } finally {
        moves.current.running -= 1;
        setSwitching(false);
      }
    },
    [activeTenantId, qc],
  );

  const value = useMemo<WorkspaceState>(
    () => ({ tenants, activeTenantId, loading, switching, error, switchTo, refresh: load, moveMark }),
    [tenants, activeTenantId, loading, switching, error, switchTo, load, moveMark],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return v;
}
