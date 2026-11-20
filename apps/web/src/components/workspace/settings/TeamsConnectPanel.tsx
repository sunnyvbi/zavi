"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { Skeleton } from "../Skeleton";

type Status = { configured: boolean; connected: boolean };

const TEAMS_INSTALL_URL =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_TEAMS_INSTALL_URL) || "";

const BIND_ERRORS: Record<string, string> = {
  m365_already_bound:
    "That Teams org is already connected to a different Zavi workspace. Disconnect it there first.",
  invalid_or_expired:
    "That code is invalid or expired. Re-add the Zavi app in Teams to get a fresh code.",
  not_admin: "Only a workspace owner or admin can connect Microsoft Teams.",
  missing_bind_code: "Enter the code Zavi sent in Teams.",
  teams_disabled: "Microsoft Teams isn't enabled yet.",
  bind_failed: "Couldn't connect right now. Try again in a moment.",
};

export function TeamsConnectPanel({ readOnly = false }: { readOnly?: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/connectors/teams/status");
      if (res.ok) setStatus((await res.json()) as Status);
      else setStatus({ configured: false, connected: false });
    } catch {
      setStatus({ configured: false, connected: false });
    }
  }, []);

  const connect = useCallback(
    async (codeArg?: string) => {
      const bindCode = (codeArg ?? code).trim();
      if (!bindCode) {
        setError(BIND_ERRORS.missing_bind_code);
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const res = await apiFetch("/api/connectors/teams/bind", {
          method: "POST",
          body: JSON.stringify({ bind_code: bindCode }),
        });
        if (res.ok) {
          setCode("");
          await load();
        } else {
          const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
          setError(BIND_ERRORS[body?.error?.code ?? ""] ?? BIND_ERRORS.bind_failed);
        }
      } catch {
        setError(BIND_ERRORS.bind_failed);
      } finally {
        setSubmitting(false);
      }
    },
    [code, load],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("teams_bind");
    if (!linked) return;
    params.delete("teams_bind");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
    void connect(linked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!status) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-live="polite"
        className="flex flex-col gap-3 rounded-[12px] border border-[#f0f0f0] bg-white p-4"
      >
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-5 shrink-0 rounded" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-3 w-3/4" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-[160px] rounded-[8px]" />
          <Skeleton className="h-9 w-24 rounded-[8px]" />
        </div>
        <span className="sr-only">Loading Microsoft Teams…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-[#f0f0f0] bg-white p-4">
      <div className="flex items-center gap-2.5">
        <img src="/logos/teams.svg" alt="" aria-hidden className="size-5" />
        <h3 className="text-[14px] font-semibold text-[#0e0f11]">Microsoft Teams</h3>
        {status.connected && (
          <span className="ml-auto text-[13px] font-medium text-[#0E9F6E]">Connected ✓</span>
        )}
      </div>

      {!status.configured ? (
        <p className="text-[13px] text-[#6b6b66]">
          Microsoft Teams support is coming soon. It isn’t enabled on your workspace yet.
        </p>
      ) : status.connected ? (
        <p className="text-[13px] text-[#6b6b66]">
          Zavi is connected to your Microsoft Teams. @mention Zavi in a channel or DM it directly.
        </p>
      ) : (
        <>
          <p className="text-[13px] text-[#6b6b66]">
            {TEAMS_INSTALL_URL ? (
              <>
                <a
                  href={TEAMS_INSTALL_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-[#027bff] hover:underline"
                >
                  Add Zavi to Microsoft Teams
                </a>
                , then paste the one-time code Zavi sends you in Teams.
              </>
            ) : (
              <>Add the Zavi app in Microsoft Teams, then paste the one-time code Zavi sends you in Teams.</>
            )}
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              data-replay-mask=""
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              disabled={readOnly || submitting}
              aria-label="Microsoft Teams connection code"
              className="h-9 w-[160px] rounded-[8px] border border-[#e5e5e5] px-3 text-[16px] tracking-[1px] outline-none focus:border-[#027bff] disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => connect()}
              disabled={readOnly || submitting || !code.trim()}
              className="h-10 rounded-cta bg-[#0e0f11] px-4 text-[16px] font-medium text-white transition-colors hover:bg-[#26282b] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Connecting…" : "Connect"}
            </button>
          </div>
        </>
      )}

      {error && (
        <p role="alert" aria-live="polite" className="text-[13px] text-[#b91c1c]">
          {error}
        </p>
      )}
    </div>
  );
}
