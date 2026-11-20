"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase";
import { readMyRole, ROLE_REFUSED_EVENT, type TenantRole } from "@/lib/members";
import { useWorkspaceOptional } from "../../WorkspaceShell";

type Read = { role: TenantRole | null } | "unread";

export type LiveRole = {
  role: TenantRole | null;
  unknown: boolean;
  checking: boolean;
  recheck: () => void;
};

export function useLiveRole(): LiveRole {
  const workspace = useWorkspaceOptional();
  const tenantId = workspace?.tenantId ?? null;
  const initial = workspace?.role ?? null;
  const [read, setRead] = useState<Read | null>(null);
  const [checking, setChecking] = useState(false);
  const seq = useRef(0);
  const recheck = useCallback(() => {
    if (!tenantId) return;
    const mine = (seq.current += 1);
    setChecking(true);
    void readMyRole(createBrowserSupabase(), tenantId)
      .catch((): "unread" => "unread")
      .then((r) => {
        if (mine !== seq.current) return;
        setChecking(false);
        setRead((prev) => (r === "unread" ? (prev && prev !== "unread" ? prev : "unread") : { role: r }));
      });
  }, [tenantId]);
  useEffect(() => {
    setRead(null);
    if (tenantId && initial === null) recheck();
  }, [tenantId, initial, recheck]);
  useEffect(() => {
    if (!tenantId) return;
    const onFocus = () => recheck();
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(ROLE_REFUSED_EVENT, onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(ROLE_REFUSED_EVENT, onFocus);
    };
  }, [tenantId, recheck]);
  const fallback = initial !== null || !tenantId ? { role: initial } : null;
  const known = read && read !== "unread" ? read : fallback;
  return { role: known?.role ?? null, unknown: known === null, checking, recheck };
}
