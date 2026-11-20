"use client";

import { useEffect, useRef, useState } from "react";
import {
  dismissTeamNote, markTeamNoteOpened, markTeamNoteShown, sendTeamNote, type OfferedTeamNote,
} from "@/lib/workspace/teamNote";
import { NOTICE_DOT, NOTICE_GHOST_BUTTON, NOTICE_LABEL, NOTICE_PRIMARY_BUTTON, NOTICE_SURFACE } from "./composerNotice";
import { TeamNotePanel } from "./TeamNotePanel";

type Phase = "idle" | "sending" | "failed" | "dismiss_failed";
type Local = {
  threadId: string | null;
  messageId: string | null;
  gate: { show: boolean; offerStop: boolean } | null;
  hidden: boolean;
  sentTurn: { key: string | null } | null;
  phase: Phase;
  panelOpen: boolean;
};

const fresh = (threadId: string | null, messageId: string | null): Local => ({
  threadId, messageId, gate: null, hidden: false, sentTurn: null, phase: "idle", panelOpen: false,
});

function useDocumentVisible(): boolean {
  const [v, setV] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const on = () => setV(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return v;
}

function useLaidOut(el: HTMLElement | null): boolean {
  const [v, setV] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setV(e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return v;
}

export function TeamNoteStrip({
  threadId,
  teamNote: incoming,
  replying,
  turnKey = null,
  visible: hostVisible = true,
}: {
  threadId: string | null;
  teamNote: OfferedTeamNote | null;
  replying: boolean;
  turnKey?: string | null;
  visible?: boolean;
}) {
  const docVisible = useDocumentVisible();
  const [probeEl, setProbeEl] = useState<HTMLSpanElement | null>(null);
  const laidOut = useLaidOut(probeEl);
  const onScreen = hostVisible && docVisible && laidOut;
  const probe = <span ref={setProbeEl} aria-hidden="true" data-testid="team-note-probe" className="block h-0 w-full" />;
  const teamNote = incoming && incoming.surface === "strip" ? incoming : null;
  const [s, setS] = useState<Local>(() => fresh(threadId, teamNote?.messageId ?? null));
  const asked = useRef<string | null>(null);
  const incomingId = teamNote?.messageId ?? null;

  const stale = s.threadId !== threadId || (incomingId !== null && incomingId !== s.messageId);
  const cur: Local = stale ? fresh(threadId, incomingId) : s;
  useEffect(() => {
    if (stale) {
      asked.current = null;
      setS(fresh(threadId, incomingId));
    }
  }, [stale, threadId, incomingId]);

  useEffect(() => {
    if (stale || !onScreen || !teamNote || replying || teamNote.state !== "drafted" || asked.current === teamNote.messageId) return;
    const id = teamNote.messageId;
    const forThread = threadId;
    asked.current = id;
    markTeamNoteShown(id, "strip")
      .then((gate) => setS((p) => (p.messageId === id && p.threadId === forThread ? { ...p, gate } : p)))
      .catch(() => setS((p) => (p.messageId === id && p.threadId === forThread
        ? { ...p, gate: { show: false, offerStop: false } } : p)));
  }, [stale, onScreen, teamNote, replying, threadId]);

  if (cur.sentTurn && cur.sentTurn.key === turnKey && cur.messageId !== null
      && (incomingId === null || incomingId === cur.messageId)) {
    return (
      <>
      {probe}
      <p role="status" className="border-b border-rule/60 bg-white px-4 py-2 text-[13px] font-medium text-emerald-700">
        Sent to the Zavi team. Thanks for telling us.
      </p>
      </>
    );
  }
  if (stale || !teamNote || replying || cur.hidden) return probe;
  const shown = teamNote.state === "shown" || cur.gate?.show === true;
  if (!shown) return probe;

  const id = teamNote.messageId;
  const offerStop = teamNote.offerStop || cur.gate?.offerStop === true;
  const patch = (u: Partial<Local>) =>
    setS((p) => (p.messageId === id && p.threadId === threadId ? { ...p, ...u } : p));
  const markSent = () => patch({ sentTurn: { key: turnKey }, panelOpen: false, phase: "idle" });

  async function send() {
    patch({ phase: "sending" });
    try {
      await sendTeamNote(id, { note: teamNote!.note });
      markSent();
    } catch {
      patch({ phase: "failed" });
    }
  }

  async function dismiss(stop: boolean) {
    patch({ phase: "sending" });
    try {
      await dismissTeamNote(id, stop);
      patch({ hidden: true, panelOpen: false, phase: "idle" });
    } catch {
      patch({ phase: "dismiss_failed" });
    }
  }

  function openPanel() {
    patch({ panelOpen: true, phase: "idle" });
    markTeamNoteOpened(id);
  }

  return (
    <div className="px-4 pb-2 pt-1 font-sans text-[13px]" data-testid="team-note-strip">
      {probe}
      <div className="mx-auto w-full max-w-[42rem]">
        <div className={`${NOTICE_SURFACE} flex-wrap gap-y-1`}>
          <p className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
            <span className={NOTICE_DOT} aria-hidden="true" />
            <span className={NOTICE_LABEL}>That went badly. I wrote a note for the Zavi team.</span>
          </p>
          <div className="-mr-1.5 flex shrink-0 items-center gap-1">
            <button type="button" disabled={cur.phase === "sending"} onClick={() => void dismiss(false)}
              className={NOTICE_GHOST_BUTTON}>Dismiss</button>
            <button type="button" onClick={openPanel}
              className={`${NOTICE_GHOST_BUTTON} !text-ink`}>See note</button>
            <button type="button" disabled={cur.phase === "sending"} onClick={() => void send()}
              className={NOTICE_PRIMARY_BUTTON}>Send to Zavi team</button>
          </div>
        </div>
        {offerStop && (
          <button type="button" disabled={cur.phase === "sending"} onClick={() => void dismiss(true)}
            className="mt-1.5 pl-3.5 text-[12px] text-inkMuted underline underline-offset-2 hover:text-ink disabled:opacity-60">
            Stop suggesting these
          </button>
        )}
        {cur.phase === "failed" && !cur.panelOpen && <p role="alert" className="mt-1.5 pl-3.5 text-[12px] text-danger">Not sent, try again</p>}
        {cur.phase === "dismiss_failed" && !cur.panelOpen && <p role="alert" className="mt-1.5 pl-3.5 text-[12px] text-danger">Couldn&apos;t save that, try again</p>}
      </div>
      {cur.panelOpen && (
        <TeamNotePanel
          key={id}
          messageId={id}
          note={teamNote.note}
          onClose={() => patch({ panelOpen: false })}
          onSent={markSent}
          onDismissed={() => patch({ hidden: true, panelOpen: false, phase: "idle" })}
        />
      )}
    </div>
  );
}
