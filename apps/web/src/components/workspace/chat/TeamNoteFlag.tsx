"use client";

import { useState } from "react";
import { markTeamNoteOpened, markTeamNoteShown, type OfferedTeamNote } from "@/lib/workspace/teamNote";
import { TeamNotePanel } from "./TeamNotePanel";

type Phase = "idle" | "opening" | "open" | "open_failed" | "sent" | "hidden";

export const TEAM_NOTE_FLAG_TOOLTIP = "This reply may have gone wrong. Tell the Zavi team?";

export function TeamNoteFlag({ note }: { note: OfferedTeamNote | null }) {
  const [s, setS] = useState<{ messageId: string | null; phase: Phase; text: string }>(() => ({
    messageId: note?.messageId ?? null, phase: "idle", text: note?.note ?? "",
  }));
  const stale = note !== null && note.messageId !== s.messageId;
  const cur = stale ? { messageId: note.messageId, phase: "idle" as Phase, text: note.note } : s;
  if (stale) setS(cur);

  const id = cur.messageId;
  const patch = (phase: Phase) => setS((p) => (p.messageId === id ? { ...p, phase } : p));

  if (cur.phase === "sent") {
    return <span role="status" className="px-2 text-[13px] font-medium text-emerald-700">Sent to the Zavi team</span>;
  }
  if (cur.phase === "open" && id) {
    return (
      <>
        {}
        <FlagButton expanded />
        <TeamNotePanel
          key={id}
          messageId={id}
          note={cur.text}
          onClose={() => patch("idle")}
          onSent={() => patch("sent")}
          onDismissed={() => patch("hidden")}
        />
      </>
    );
  }
  if (!note || !id || cur.phase === "hidden") return null;

  async function open() {
    if (!id) return;
    patch("opening");
    try {
      const gate = await markTeamNoteShown(id, "flag");
      if (!gate.show) {
        patch("hidden");
        return;
      }
      patch("open");
      markTeamNoteOpened(id);
    } catch {
      patch("open_failed");
    }
  }

  return (
    <>
      <FlagButton disabled={cur.phase === "opening"} onClick={() => void open()} />
      {cur.phase === "open_failed" && (
        <span role="alert" className="px-1 text-[12px] text-danger">Couldn&apos;t open that, try again</span>
      )}
    </>
  );
}

function FlagButton({ disabled, expanded, onClick }: { disabled?: boolean; expanded?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-expanded={expanded === true}
      aria-label="Tell the Zavi team this reply may have gone wrong"
      title={TEAM_NOTE_FLAG_TOOLTIP}
      data-testid="team-note-flag"
      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[#8a8a8a] transition-colors hover:bg-ink/[0.06] hover:text-ink disabled:opacity-60"
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="h-[15px] w-[15px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 21V4" />
        <path d="M5 4h11l-2 4 2 4H5" />
      </svg>
    </button>
  );
}
