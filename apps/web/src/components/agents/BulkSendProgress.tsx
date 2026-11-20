"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

type Progress = { line: string; in_progress: boolean };

export function BulkSendProgress({ decisionId }: { decisionId: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/workspace/email-sends/${decisionId}`);
      if (!res.ok) return;
      const j = (await res.json()) as { send?: Progress | null };
      setProgress(j.send ?? null);
    } catch {
    }
  }, [decisionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const inProgress = progress?.in_progress === true;
  useEffect(() => {
    if (!inProgress) return;
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [inProgress, load]);

  if (!progress) return null;
  return (
    <p aria-live="polite" className="mt-2 text-[12px] font-medium text-ink">
      {progress.line}
    </p>
  );
}
