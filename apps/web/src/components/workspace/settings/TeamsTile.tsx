"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { ChatConnectCard } from "@/app/connectors/ChatConnectCard";
import { ConnectorLockup, ConnectorTile, TileButton, TileMenu } from "./ConnectorTile";
import { showConnectorError } from "./connectorErrorDialog";
import { connectionState } from "./connectorHealth";

type Status = { configured: boolean; connected: boolean };

const BIND_ERRORS: Record<string, string> = {
  m365_already_bound:
    "That Teams org is already connected to a different Zavi workspace. Disconnect it there first.",
  invalid_or_expired:
    "That code is invalid or expired. Re-add the Zavi app in Teams to get a fresh code.",
  not_admin: "Only a workspace owner or admin can connect Microsoft Teams.",
  missing_bind_code: "Enter the code Zavi sent you in Teams.",
  teams_disabled: "Microsoft Teams isn't enabled yet.",
  bind_failed: "Couldn't connect right now. Try again in a moment.",
};

export function TeamsTile({ readOnly = false }: { readOnly?: boolean }) {
  const [status, setStatus] = useState<Status>({ configured: false, connected: false });
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/connectors/teams/status");
      if (res.ok) setStatus((await res.json()) as Status);
    } catch {}
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = useCallback(async () => {
    if (
      !window.confirm(
        "Disconnect Microsoft Teams? Zavi will stop answering in Teams. To reconnect, re-add the Zavi app in Teams and enter the new code.",
      )
    )
      return;
    try {
      const res = await apiFetch("/api/connectors/teams/disconnect", { method: "POST" });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      showConnectorError({
        title: "Couldn’t disconnect Microsoft Teams",
        message:
          body?.error?.code === "forbidden" || body?.error?.code === "not_admin"
            ? "Only an owner or admin can disconnect Microsoft Teams."
            : "Try again in a moment.",
      });
    } catch (e) {
      showConnectorError({
        title: "Couldn’t disconnect Microsoft Teams",
        message: (e as Error).message,
      });
    }
  }, []);

  if (status.connected) {
    return (
      <ConnectorTile
        id="connector-teams"
        logo={<ConnectorLockup slug="teams" label="Microsoft Teams" />}
        name="Microsoft Teams"
        description="Message your agents from Microsoft Teams."
        status={{ tone: "connected", text: "Connected" }}
        action={
          readOnly ? null : (
            <TileMenu
              label="Manage"
              items={[{ label: "Disconnect", onClick: () => void disconnect(), danger: true }]}
            />
          )
        }
      />
    );
  }

  return (
    <>
      <ConnectorTile
        id="connector-teams"
        logo={<ConnectorLockup slug="teams" label="Microsoft Teams" />}
        name="Microsoft Teams"
        description="Message your agents from Microsoft Teams."
        status={connectionState(false, undefined)}
        action={
          readOnly ? null : (
            <TileButton onClick={() => setOpen((v) => !v)} ariaExpanded={open}>
              <span aria-hidden>Connect</span>
              <span className="sr-only">Connect Microsoft Teams</span>
            </TileButton>
          )
        }
      />
      {open && !readOnly && (
        <TeamsConnectForm configured={status.configured} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export function TeamsConnectForm({ configured, onClose, inline }: { configured: boolean; onClose: () => void; inline?: boolean }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const connect = useCallback(async () => {
    const bindCode = code.trim();
    if (!bindCode) {
      setError(BIND_ERRORS.missing_bind_code);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await apiFetch("/api/connectors/teams/bind", {
        method: "POST",
        body: JSON.stringify({ bind_code: bindCode }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      setError(BIND_ERRORS[body?.error?.code ?? ""] ?? BIND_ERRORS.bind_failed);
    } catch {
      setError(BIND_ERRORS.bind_failed);
    } finally {
      setSubmitting(false);
    }
  }, [code]);

  return (
    <ChatConnectCard
      title="Connect Microsoft Teams"
      blurb="Add the Zavi app in Teams, then enter the one-time code it sends you. Nothing connects until you enter it."
      icon="/logos/teams.svg"
      onClose={onClose}
      error={error}
      inline={inline}
    >
      {!configured ? (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3.5 text-xs text-neutral-500">
          Microsoft Teams support is coming soon. It isn’t enabled on your workspace yet.
        </div>
      ) : (
        <ol className="space-y-3">
          <li className="rounded-xl border border-neutral-200 p-3.5">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-[11px] font-bold text-white">
                1
              </span>
              <span className="text-[13px] font-semibold">Add the Zavi app to Teams</span>
            </div>
            <div className="mt-2 text-xs leading-[17px] text-neutral-500">
              In Teams, go to <span className="font-medium text-neutral-700">Apps → Manage your apps → Upload an app</span> and pick the downloaded package.
            </div>
            <a
              href="/zavi-teams-v1.19.zip"
              download
              className="mt-2.5 inline-flex items-center gap-2 rounded-lg bg-[#5B5FC7] px-3 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              Download app package
            </a>
          </li>
          <li className="rounded-xl border border-neutral-200 p-3.5">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-[11px] font-bold text-white">
                2
              </span>
              <span className="text-[13px] font-semibold">Enter the code Zavi sends you</span>
            </div>
            <div className="mt-2 text-xs leading-[17px] text-neutral-500">
              Right after the app is added, Zavi DMs you a one-time code in Teams.
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <input
                type="text"
                data-replay-mask=""
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD-EFGH"
                disabled={submitting}
                aria-label="Microsoft Teams connection code"
                className="h-10 min-w-0 flex-1 rounded-lg border border-neutral-200 bg-transparent px-3 font-mono text-[13px] tracking-[2px] outline-none placeholder:tracking-[2px] focus:border-neutral-400 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void connect()}
                disabled={submitting || !code.trim()}
                className="h-10 shrink-0 rounded-cta bg-neutral-900 px-4 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "Connecting…" : "Connect"}
              </button>
            </div>
          </li>
        </ol>
      )}
    </ChatConnectCard>
  );
}
