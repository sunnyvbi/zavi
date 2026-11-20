"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mail, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { ConnectorTile, TileButton } from "./ConnectorTile";
import { EmailAllowlistPanel } from "./EmailAllowlistPanel";
import { useDialogFocus } from "../email/dialogFocus";

export function EmailTile({ readOnly = false }: { readOnly?: boolean }) {
  const [address, setAddress] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, settingsOpen);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await apiFetch("/api/workspace/inbox-addresses");
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { address?: string | null };
        if (alive) setAddress(j.address ?? null);
      } catch {
        if (alive) setAddress(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const copy = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
    }
  }, [address]);

  return (
    <>
      <ConnectorTile
        id="connector-email"
        name="Email"
        logo={
          <div className="flex h-6 min-w-0 items-center gap-2">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-[#f0f0f0] text-[#595959]">
              <Mail className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span className="truncate text-[14px] font-bold tracking-tight text-[#0e0f11]">
              Email
            </span>
          </div>
        }
        description="Email or CC your agents from any inbox."
        status={
          address === undefined
            ? { tone: "idle", text: "Loading…" }
            : address === null
              ? { tone: "idle", text: "Not set up yet" }
              : { tone: "connected", text: address }
        }
        action={
          <>
            {address ? (
              <TileButton onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </TileButton>
            ) : null}
            <TileButton onClick={() => setSettingsOpen(true)}>
              Settings
            </TileButton>
          </>
        }
      />
      {settingsOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 md:p-10">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setSettingsOpen(false)}
            aria-hidden
          />
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Email settings"
            className="relative flex max-h-full w-full max-w-[720px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_32px_90px_rgba(10,10,14,0.45)] ring-1 ring-black/10"
          >
            <div className="flex items-start justify-between gap-4 border-b border-[#f0f0f0] px-6 py-4">
              <div>
                <h2 className="text-[16px] font-semibold tracking-tight text-ink">
                  Email
                </h2>
                <p className="mt-1 text-[16px] leading-[1.55] text-inkMuted">
                  Your agent&apos;s own address, and who is allowed to write to
                  it.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close email settings"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#8a8a8a] transition-colors hover:bg-[#f0f0f0] hover:text-[#0e0f11]"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-4">
              <EmailAllowlistPanel canEdit={!readOnly} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
