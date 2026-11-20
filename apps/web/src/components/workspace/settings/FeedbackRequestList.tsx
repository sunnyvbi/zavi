"use client";

import { useEffect, useRef, useState } from "react";
import { useMyFeedback, type FeedbackStatus } from "@/lib/workspace/useMyFeedback";

const STATUS: Record<FeedbackStatus, { label: string; className: string }> = {
  received: { label: "Received", className: "bg-creamDeep text-inkMuted" },
  working: { label: "Working on it", className: "bg-warnBg text-warn" },
  done: { label: "Done", className: "bg-successBg text-success" },
  wont_do: { label: "Not planned", className: "bg-creamDeep text-inkMuted" },
};

function sentOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function FeedbackRequestList() {
  const { requests, updates, failed, markSeen } = useMyFeedback();
  const [shownUpdated, setShownUpdated] = useState<Set<string>>(() => new Set());
  const marking = useRef(false);

  useEffect(() => {
    if (!requests || updates === 0 || marking.current) return;
    const fresh = requests.filter((r) => r.updated).map((r) => r.id);
    setShownUpdated((prev) => new Set([...prev, ...fresh]));
    marking.current = true;
    void markSeen().finally(() => {
      marking.current = false;
    });
  }, [requests, updates, markSeen]);

  return (
    <div className="mt-6">
      <p className="text-[14px] font-semibold text-ink">Your requests</p>
      <p className="text-[13px] text-inkMuted">We email you when it&apos;s done or closed.</p>

      {}
      {failed ? (
        <p className="mt-2 text-[13px] text-danger">Couldn&apos;t load your requests.</p>
      ) : requests === null ? null : (
        <ul className="mt-2 divide-y divide-rule rounded-xl border border-rule">
          {requests.length === 0 && (
            <li className="px-3.5 py-3 text-[14px] text-inkMuted">
              Nothing sent yet. What you send shows here with its status.
            </li>
          )}
          {requests.map((r) => {
            const s = STATUS[r.status] ?? STATUS.received;
            return (
              <li key={r.id} className="px-3.5 py-3">
                <div className="flex items-start gap-3">
                  <p className="min-w-0 flex-1 whitespace-pre-line break-words text-[14px] leading-snug text-ink line-clamp-4">
                    {r.body}
                  </p>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold ${s.className}`}>
                    {s.label}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-inkMuted">
                  Sent {sentOn(r.created_at)}
                  {shownUpdated.has(r.id) && (
                    <span className="ml-2 font-semibold text-[#0F766E] [html.dark_&]:text-[#5EEAD4]">● Updated</span>
                  )}
                </p>
                {r.staff_note && (
                  <p className="mt-1.5 whitespace-pre-line rounded-lg bg-creamDeep px-2.5 py-1.5 text-[13px] text-ink">
                    <span className="font-semibold">Zavi team:</span> {r.staff_note}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
