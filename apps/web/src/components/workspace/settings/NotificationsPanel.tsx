"use client";

import { useCallback, useEffect, useState } from "react";
import { Mail, X, TriangleAlert } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { Skeleton } from "../Skeleton";
import { PushPrefsCard } from "./PushPrefsCard";

type Recipient = {
  id: string | null;
  email: string;
  label: string | null;
  is_owner: boolean;
};

export function NotificationsPanel() {
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/notifications/agent-email-recipients");
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { recipients: Recipient[] };
      setRecipients(j.recipients ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load recipients");
      setRecipients([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    const email = draft.trim();
    if (!email || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch("/api/notifications/agent-email-recipients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as
          | { error?: { code?: string; message?: string } }
          | null;
        throw new Error(
          j?.error?.code === "cap_reached"
            ? "You've hit the recipient limit. Remove one first."
            : (j?.error?.message ?? `could not add (${r.status})`),
        );
      }
      setDraft("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not add that address");
    } finally {
      setBusy(false);
    }
  }, [draft, busy, load]);

  const remove = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await apiFetch(
          `/api/notifications/agent-email-recipients/${id}`,
          { method: "DELETE" },
        );
        if (!r.ok) throw new Error(`could not remove (${r.status})`);
        const j = (await r.json().catch(() => null)) as { removed?: boolean } | null;
        await load();
        if (j?.removed !== true) {
          throw new Error("That address wasn't removed. The list has been refreshed.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not remove that address");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <div className="flex flex-col gap-4">
    <PushPrefsCard />
    <div className="rounded-block border border-[#f0f0f0] px-4 py-[19px]">
      <div className="flex items-start gap-3">
        <Mail className="mt-0.5 h-5 w-5 shrink-0 text-[#595959]" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-[#0e0f11]">
            Who hears from your agents
          </h3>
          <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
            When an agent&apos;s schedule is set to deliver by email, its results go
            to everyone below. The owner is always included.
          </p>

          {recipients === null ? (
            <div className="mt-4 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : (
            <ul className="mt-4 space-y-2">
              {recipients.map((r) => (
                <li
                  key={r.id ?? "owner"}
                  className="flex items-center justify-between gap-3 rounded-xl bg-[#f9f9f9] px-3 py-2.5"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[#0e0f11]">
                    {r.email}
                    {r.is_owner && (
                      <span className="ml-2 text-[12px] text-[#595959]">
                        Owner · always included
                      </span>
                    )}
                  </span>
                  {r.id && (
                    <button
                      type="button"
                      onClick={() => void remove(r.id as string)}
                      disabled={busy}
                      aria-label={`Remove ${r.email}`}
                      className="shrink-0 rounded-cta p-1 text-[#595959] hover:bg-white hover:text-[#cb2029] disabled:opacity-40"
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex gap-2">
            <label htmlFor="agent-email-recipient" className="sr-only">
              Email address
            </label>
            <input
              id="agent-email-recipient"
              type="email"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
              placeholder="teammate@company.com"
              className="min-w-0 flex-1 rounded-xl border border-[#f0f0f0] px-3 py-2 text-[13px] text-[#0e0f11] outline-none focus:border-[#0e0f11]"
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy || draft.trim().length === 0}
              className="shrink-0 rounded-cta bg-[#0e0f11] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
            >
              Add
            </button>
          </div>

          {}
          <p className="mt-2.5 flex items-start gap-2 text-[12px] leading-[1.6] text-[#595959]">
            <TriangleAlert
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#ffce70]"
              aria-hidden
            />
            <span>
              An address starts receiving agent results right away, even if it
              isn&apos;t a workspace member. Agent results carry your business data,
              so check the spelling.
            </span>
          </p>

          {error && (
            <p role="alert" className="mt-2 text-[12px] text-[#cb2029]">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
