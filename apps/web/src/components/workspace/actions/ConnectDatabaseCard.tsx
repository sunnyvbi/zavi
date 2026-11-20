"use client";

import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "../WorkspaceShell";
import { pushWorkspaceLocation } from "../navigation/workspaceRoutes";
import { requestAccess } from "../settings/database/databaseApi";
import { CONNECT_DATABASE_HREF } from "./dbChatCards";

function openDatabaseTile() {
  pushWorkspaceLocation(CONNECT_DATABASE_HREF);
  try {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } catch {
  }
}

export function ConnectDatabaseCard() {
  const { role } = useWorkspace();
  const canManage = role === "owner" || role === "admin";
  const [connected, setConnected] = useState(false);
  const [requested, setRequested] = useState<"idle" | "busy" | "sent" | "failed">("idle");

  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const res = await apiFetch("/api/connectors");
        if (!res.ok) return;
        const body = (await res.json()) as { connectors?: { slug?: string }[] };
        if (live && (body.connectors ?? []).some((c) => c.slug === "operator_db")) setConnected(true);
      } catch {
      }
    };
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (connected) {
    return <div className="mt-2 text-[13px] text-inkMuted">Your database is connected. Ask again to use it.</div>;
  }

  const onRequest = async () => {
    setRequested("busy");
    try {
      await requestAccess();
      setRequested("sent");
    } catch {
      setRequested("failed");
    }
  };

  return (
    <div data-testid="connect-database-card" className="mt-2 rounded-xl border border-ink/10 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <Database className="mt-0.5 h-4 w-4 shrink-0 text-inkMuted" aria-hidden />
        <div className="min-w-0 flex-1">
          {canManage ? (
            <>
              <div className="text-[15px] font-semibold text-ink">Connect your database to answer this</div>
              <p className="mt-1 text-[13px] leading-[1.55] text-inkMuted">
                Zavi only reads. It takes about 5 minutes. This opens Connectors.
              </p>
              <div className="mt-3">
                <button
                  type="button"
                  onClick={openDatabaseTile}
                  className="rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white"
                >
                  Connect your database
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="text-[15px] font-semibold text-ink">Ask an owner or admin to connect your database</div>
              <p className="mt-1 text-[13px] leading-[1.55] text-inkMuted">
                Zavi needs your database to answer this. Only an owner or admin can connect it.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onRequest()}
                  disabled={requested === "busy" || requested === "sent"}
                  className="rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                >
                  {requested === "sent" ? "Request sent" : "Request access"}
                </button>
                {requested === "failed" && (
                  <span role="alert" className="text-[13px] text-coral">
                    Could not send the request. Try again.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
