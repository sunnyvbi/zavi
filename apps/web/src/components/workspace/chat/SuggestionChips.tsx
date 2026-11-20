
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { staffModelBodyField } from "@/lib/workspace/staffModelParam";

export function SuggestionChips({
  agentSlug,
  threadId,
  suggestions,
}: {
  agentSlug: string;
  threadId?: string | null;
  suggestions: string[];
}) {
  const [sentLabel, setSentLabel] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const clean = suggestions
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .slice(0, 5);
  if (clean.length === 0) return null;

  async function tap(label: string) {
    if (sending || sentLabel) return;
    setSending(true);
    try {
      const res = await apiFetch(`/api/agents/${encodeURIComponent(agentSlug)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: label, thread_id: threadId ?? null, ...staffModelBodyField() }),
        idempotent: true,
      });
      if (res.ok) {
        setSentLabel(label);
      } else {
        setSending(false);
      }
    } catch {
      setSending(false);
    }
  }

  return (
    <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="Quick replies">
      {clean.map((label) => {
        const isSent = sentLabel === label;
        const disabled = sending || sentLabel !== null;
        return (
          <button
            key={label}
            type="button"
            disabled={disabled}
            onClick={() => void tap(label)}
            className={[
              "rounded-full border px-3 py-1 text-base transition",
              isSent
                ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400 hover:bg-neutral-50",
              disabled && !isSent ? "cursor-not-allowed opacity-50" : "",
            ].join(" ")}
          >
            {isSent ? `${label} ✓` : label}
          </button>
        );
      })}
    </div>
  );
}
