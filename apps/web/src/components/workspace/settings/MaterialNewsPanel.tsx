"use client";

import { useCallback, useEffect, useState } from "react";
import { Newspaper } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { Skeleton } from "../Skeleton";

export function MaterialNewsPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch("/api/workspace/material-news-pref");
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { enabled: boolean };
      setEnabled(Boolean(j.enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load this setting");
      setEnabled(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(async () => {
    if (busy || enabled === null) return;
    const next = !enabled;
    setBusy(true);
    setError(null);
    setEnabled(next);
    try {
      const r = await apiFetch("/api/workspace/material-news-pref", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) throw new Error(`could not save (${r.status})`);
    } catch (e) {
      setEnabled(!next);
      setError(e instanceof Error ? e.message : "could not save that change");
    } finally {
      setBusy(false);
    }
  }, [busy, enabled]);

  return (
    <div className="rounded-block border border-[#f0f0f0] px-4 py-[19px]">
      <div className="flex items-start gap-3">
        <Newspaper className="mt-0.5 h-5 w-5 shrink-0 text-[#595959]" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[14px] font-semibold text-[#0e0f11]">
                Market news alerts
              </h3>
              <p className="mt-1 text-[13px] leading-[1.6] text-[#595959]">
                When something in your market looks worth knowing, we&apos;ll email
                you. We keep it rare, never more than once a week.
              </p>
            </div>
            {enabled === null ? (
              <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
            ) : (
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="Market news alerts"
                onClick={() => void toggle()}
                disabled={busy}
                className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                  enabled ? "bg-[#0e0f11]" : "bg-[#e5e5e5]"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                    enabled ? "translate-x-[22px]" : "translate-x-0.5"
                  }`}
                />
              </button>
            )}
          </div>

          {error && (
            <p role="alert" className="mt-2 text-[12px] text-[#cb2029]">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
