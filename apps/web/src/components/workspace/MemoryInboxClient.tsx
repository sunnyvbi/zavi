"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

type Card = {
  id: string;
  source_kind: string;
  source_url: string | null;
  title: string;
  body: string;
  source_excerpt: string;
  confidence: string;
  status: string;
  created_at: string;
  decided_at: string | null;
};

const SOURCE_LABEL: Record<string, string> = {
  slack: "Slack",
  meeting: "Meeting",
  email: "Email",
  doc: "Doc",
};

export function MemoryInboxClient() {
  const [pending, setPending] = useState<Card[]>([]);
  const [decided, setDecided] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/workspace/memory-cards");
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (isMounted.current) setError(b?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { pending: Card[]; decided: Card[] };
      if (isMounted.current) {
        setPending(data.pending ?? []);
        setDecided(data.decided ?? []);
      }
    } catch (e) {
      if (isMounted.current) setError((e as Error).message ?? "Unknown error");
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (id: string, action: "approve" | "ignore") => {
      setBusyId(id);
      try {
        const res = await apiFetch(`/api/workspace/memory-cards/${id}/${action}`, { method: "POST", body: "{}" });
        if (!res.ok) {
          const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          if (isMounted.current) setError(b?.error?.message ?? `HTTP ${res.status}`);
          return;
        }
        void load();
      } catch (e) {
        if (isMounted.current) setError((e as Error).message ?? "Unknown error");
      } finally {
        if (isMounted.current) setBusyId(null);
      }
    },
    [load],
  );

  if (loading) {
    return <p className="text-[16px] text-inkMuted">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="space-y-6">
      {error ? <p className="text-[13px] text-red-700">{error}</p> : null}

      <section>
        <h2 className="mb-3 text-[14px] font-semibold tracking-tight text-ink">
          Pending review{pending.length > 0 ? ` (${pending.length})` : ""}
        </h2>
        {pending.length === 0 ? (
          <p className="rounded-xl border border-[#e6dfd2] bg-white p-4 text-[16px] text-inkMuted">
            Nothing waiting. Capture context anywhere by saying{" "}
            <span className="font-medium text-ink">&ldquo;@Zavi remember this&rdquo;</span> in Slack, or sending Zavi to
            a meeting. Durable facts land here for your approval.
          </p>
        ) : (
          <ul className="grid gap-3">
            {pending.map((c) => (
              <li key={c.id} className="rounded-xl border border-[#e6dfd2] bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2 text-[12px] text-inkMuted">
                      <span className="rounded bg-bone px-1.5 py-0.5">{SOURCE_LABEL[c.source_kind] ?? c.source_kind}</span>
                      <span>{c.confidence} confidence</span>
                      {c.source_url ? (
                        <a href={c.source_url} target="_blank" rel="noreferrer" className="underline hover:text-ink">
                          source
                        </a>
                      ) : null}
                    </div>
                    <p className="text-[16px] font-medium text-ink">{c.title}</p>
                    {c.body ? <p className="mt-1 text-[13px] leading-[1.5] text-inkMuted">{c.body}</p> : null}
                    {c.source_excerpt ? (
                      <p className="mt-1.5 border-l-2 border-[#e6dfd2] pl-2 text-[12px] italic text-inkMuted">
                        {c.source_excerpt}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => void decide(c.id, "approve")}
                      disabled={busyId === c.id}
                      className="rounded-cta bg-ink px-3 py-1.5 text-[13px] font-medium text-white transition-opacity disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void decide(c.id, "ignore")}
                      disabled={busyId === c.id}
                      className="rounded-cta bg-bone px-3 py-1.5 text-[13px] text-inkMuted transition-colors hover:text-ink disabled:opacity-50"
                    >
                      Ignore
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {decided.length > 0 ? (
        <section>
          <h2 className="mb-3 text-[14px] font-semibold tracking-tight text-ink">Recently decided</h2>
          <ul className="grid gap-2">
            {decided.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-[13px]">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    c.status === "approved" ? "bg-green-600" : "bg-[#d8d0c2]"
                  }`}
                />
                <span className="truncate text-ink">{c.title}</span>
                <span className="shrink-0 text-inkMuted">· {c.status === "approved" ? "saved" : "ignored"}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
