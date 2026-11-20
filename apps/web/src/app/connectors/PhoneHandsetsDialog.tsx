"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { handsetLabel, type PhoneHandset } from "@/components/workspace/settings/usePhoneHandsets";
import { ChatConnectCard } from "./ChatConnectCard";
import { PHONE_SURFACES, type PhoneSurfaceSlug } from "./phoneSurfaces";

const REMOVE_ERRORS: Record<string, string> = {
  not_admin: "Only an owner or admin can remove a number.",
  forbidden: "Only an owner or admin can remove a number.",
  thread_not_found: "That number is no longer connected.",
};

export function removeHandsetPrompt(h: PhoneHandset, appName: string): string {
  const who = h.name ? `${h.name} (${h.number})` : h.number;
  return `Remove ${who} from ${appName}? Zavi will stop answering that phone. It can be connected again anytime with the two-step link.`;
}

export function PhoneHandsetsDialog({
  surface,
  handsets,
  onClose,
  onChanged,
  onAddNumber,
}: {
  surface: PhoneSurfaceSlug;
  handsets: PhoneHandset[];
  onClose: () => void;
  onChanged: () => void;
  onAddNumber: () => void;
}) {
  const s = PHONE_SURFACES[surface];
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function remove(h: PhoneHandset) {
    if (!window.confirm(removeHandsetPrompt(h, s.appName))) return;
    setError("");
    setBusyId(h.id);
    try {
      const res = await apiFetch(`/api/connectors/${surface}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: h.id }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; connected?: boolean; error?: { code?: string; message?: string } }
        | null;
      if (!res.ok || !json?.ok) {
        const code = String(json?.error?.code);
        setError(
          REMOVE_ERRORS[code] ??
            json?.error?.message ??
            `Couldn't remove that number (HTTP ${res.status}).`,
        );
        if (code === "thread_not_found") onChanged();
        return;
      }
      if (json.connected === false) {
        window.location.reload();
        return;
      }
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ChatConnectCard title={`${s.appName} numbers`} blurb={s.rosterBlurb} onClose={onClose} error={error}>
      {handsets.length === 0 ? (
        <div className="text-xs text-neutral-500">No numbers are connected.</div>
      ) : (
        <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
          {handsets.map((h) => (
            <li key={h.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-neutral-900">
                  {handsetLabel(h)}
                </div>
                {h.name ? (
                  <div className="truncate text-xs text-neutral-500">{h.number}</div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void remove(h)}
                disabled={busyId !== null}
                aria-label={`Remove ${handsetLabel(h)}`}
                className="shrink-0 rounded-cta border border-neutral-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {busyId === h.id ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <button
          type="button"
          onClick={onAddNumber}
          className="rounded-cta bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white"
        >
          Add another number
        </button>
      </div>
    </ChatConnectCard>
  );
}
