
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

type Decision = "advanced" | "rejected" | "hired" | "declined";

const LABELS: Record<Decision, string> = {
  advanced: "Advanced to screen",
  rejected: "Rejected",
  hired: "Hired",
  declined: "Declined",
};

const TERMINAL: Decision[] = ["hired", "declined"];

function nextActions(current: Decision | null): {
  decision: Decision;
  label: string;
  tone: "primary" | "positive" | "neutral" | "danger";
}[] {
  if (current === null) {
    return [
      { decision: "advanced", label: "Advance to screen", tone: "primary" },
      { decision: "rejected", label: "Reject", tone: "neutral" },
    ];
  }
  if (current === "advanced") {
    return [
      { decision: "hired", label: "Mark hired", tone: "positive" },
      { decision: "declined", label: "Decline", tone: "danger" },
      { decision: "rejected", label: "Reject instead", tone: "neutral" },
    ];
  }
  if (current === "rejected") {
    return [
      { decision: "advanced", label: "Reconsider and advance", tone: "primary" },
    ];
  }
  return [];
}

const TONE_CLASS: Record<string, string> = {
  primary: "bg-green-600 text-white hover:bg-green-700",
  positive: "bg-emerald-600 text-white hover:bg-emerald-700",
  neutral: "bg-slate-200 text-slate-800 hover:bg-slate-300",
  danger: "bg-rose-600 text-white hover:bg-rose-700",
};

function BadgeTone(decision: Decision): string {
  switch (decision) {
    case "hired":
      return "bg-emerald-50 text-emerald-800 border border-emerald-200";
    case "advanced":
      return "bg-green-50 text-green-800 border border-green-200";
    case "rejected":
      return "bg-slate-100 text-slate-700 border border-slate-200";
    case "declined":
      return "bg-rose-50 text-rose-800 border border-rose-200";
  }
}

export function DecideButtons({
  applicationId,
  initial,
  finalized = true,
}: {
  applicationId: string;
  initial: string | null;
  finalized?: boolean;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<Decision | null>(
    (initial as Decision | null) ?? null,
  );
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(d: Decision) {
    setBusy(d);
    setError(null);
    try {
      const res = await apiFetch(`/api/applications/${applicationId}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision: d }),
      });
      if (res.ok) {
        setDecision(d);
        router.refresh();
      } else {
        const out = await res.json().catch(() => ({}));
        setError(friendlyError(out?.error?.code, out?.error?.message));
        router.refresh();
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!finalized) {
    return (
      <p className="text-base bg-amber-50 text-amber-800 border border-amber-200 p-3 rounded-md">
        This candidate is still in conversation. You can decide once the
        screening is complete.
      </p>
    );
  }

  const actions = nextActions(decision);
  const isTerminal = decision != null && TERMINAL.includes(decision);

  return (
    <div className="space-y-3">
      {decision && (
        <div className="flex items-center gap-2 text-base">
          <span className="text-slate-500">Decision:</span>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${BadgeTone(decision)}`}
          >
            {LABELS[decision]}
          </span>
          {isTerminal && (
            <span className="text-xs text-slate-400">· final</span>
          )}
        </div>
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <button
              key={a.decision}
              disabled={busy !== null}
              className={`px-4 py-2 rounded-cta text-base font-medium transition-colors disabled:opacity-50 ${TONE_CLASS[a.tone]}`}
              onClick={() => decide(a.decision)}
            >
              {busy === a.decision ? "Saving…" : a.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="text-base bg-rose-50 text-rose-800 border border-rose-200 p-3 rounded-md">
          {error}
        </p>
      )}
    </div>
  );
}

function friendlyError(code?: string, message?: string): string {
  const raw = message ?? code ?? "";
  if (raw.includes("decision_already_finalized")) {
    return "This candidate already has a final decision (hired or declined) and can't be changed.";
  }
  if (raw.includes("application_not_finalized")) {
    return "This candidate is still in conversation. Decide once screening is complete.";
  }
  if (raw.includes("not_a_member")) {
    return "You don't have access to this candidate.";
  }
  return "Couldn't save that decision. It may have changed in another tab. Refresh and try again.";
}
