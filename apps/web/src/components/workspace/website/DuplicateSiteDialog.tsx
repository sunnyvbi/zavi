"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

export type DuplicatedSite = { site_id: string; conductor_run_id: string; name: string };

const COPIED = [
  "Every page, its code and its images",
  "The look: colours, fonts and any logo",
  "Scheduled jobs, paused until you turn them on",
];
const NOT_COPIED = [
  "Data saved on the site, and its users",
  "Secrets and keys (add them again in the copy's settings)",
  "Custom domains",
  "Its live address: the copy is unpublished until you publish it",
];

export function DuplicateSiteDialog({
  siteId,
  siteName,
  onClose,
  onDuplicated,
}: {
  siteId: string;
  siteName: string;
  onClose: () => void;
  onDuplicated: (copy: DuplicatedSite) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const requestKey = useRef(globalThis.crypto?.randomUUID?.() ?? `dup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  useEffect(() => confirmRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function duplicate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/sites/${encodeURIComponent(siteId)}/duplicate`, {
        method: "POST",
        idempotent: true,
        headers: { "Idempotency-Key": requestKey.current },
      });
      const body = (await res.json().catch(() => null)) as (DuplicatedSite & { error?: { message?: string } }) | null;
      if (!res.ok || !body?.conductor_run_id) {
        setError(body?.error?.message ?? "The site could not be duplicated. Try again.");
        setBusy(false);
        return;
      }
      onDuplicated({ site_id: body.site_id, conductor_run_id: body.conductor_run_id, name: body.name });
    } catch {
      setError("Could not reach Zavi. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-site-title"
        className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="duplicate-site-title" className="text-[20px] font-semibold text-[#0e0f11]">
              Duplicate site
            </h2>
            <p className="mt-1 text-[13px] leading-5 text-[#595959]">
              Make a new site in this workspace from <span className="font-medium text-[#0e0f11]">{siteName}</span>. Changes to
              one never touch the other.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-cta text-[#595959] hover:bg-[#f4f4f4] disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 grid gap-3 text-[13px] leading-5 sm:grid-cols-2">
          <div>
            <p className="font-semibold text-[#0e0f11]">Copied</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-[#595959]">
              {COPIED.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-semibold text-[#0e0f11]">Not copied</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-[#595959]">
              {NOT_COPIED.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-10 rounded-cta border border-[#f0f0f0] bg-white px-4 text-[13px] font-medium text-[#0e0f11] hover:bg-[#f9f9f9] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => void duplicate()}
            disabled={busy}
            aria-busy={busy}
            className="inline-flex h-10 items-center gap-2 rounded-cta bg-[#0e0f11] px-4 text-[13px] font-semibold text-white hover:bg-[#262626] disabled:cursor-wait disabled:opacity-70"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
            {busy ? "Duplicating…" : "Duplicate"}
          </button>
        </div>
        {busy && (
          <p className="mt-2 text-right text-[12px] text-[#8c8c8c]" aria-live="polite">
            Copying the code. This takes up to a minute.
          </p>
        )}
      </div>
    </div>
  );
}
