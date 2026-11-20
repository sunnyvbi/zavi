"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

export function ForkButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fork() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/agents/${slug}/fork`, { method: "POST", body: "{}" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      window.location.href = `/agents/${slug}/edit`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        onClick={fork}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-cta bg-skyMuted text-white px-3 py-1.5 text-[12px] font-medium hover:bg-brickDark transition-colors shadow-sm disabled:opacity-50"
      >
        {busy ? "Forking…" : "Fork"}
      </button>
      {error && <p className="mt-2 text-[12px] text-rose-700">{error}</p>}
    </div>
  );
}
