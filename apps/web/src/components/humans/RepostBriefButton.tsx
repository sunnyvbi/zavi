"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

export function RepostBriefButton({
  briefId,
  className,
}: {
  briefId: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const repost = async () => {
    if (
      !window.confirm(
        "This closes the brief and sends every pending applicant your note, then opens an editable copy to post again. Continue?",
      )
    ) {
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await apiFetch(`/api/humans/briefs/${encodeURIComponent(briefId)}/repost`, {
        method: "POST",
        body: JSON.stringify({}),
        idempotent: true,
      });
      const body = (await res.json().catch(() => null)) as {
        brief?: { id?: string };
        error?: { message?: string };
      } | null;
      const nextId = body?.brief?.id;
      if (!res.ok || !nextId) {
        setProblem(body?.error?.message ?? `Could not repost the brief (HTTP ${res.status}).`);
        return;
      }
      window.location.href = `/humans/briefs/${encodeURIComponent(nextId)}/post`;
    } catch (e) {
      setProblem((e as Error).message ?? "Network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void repost()}
        disabled={busy}
        className={
          className ??
          "inline-flex items-center rounded-full border border-ink/15 px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink/[0.04] disabled:opacity-50"
        }
      >
        {busy ? "Reposting" : "Close and repost"}
      </button>
      {problem ? <span className="text-[12px] text-red-700">{problem}</span> : null}
    </span>
  );
}
