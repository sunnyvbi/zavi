"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useWorkspaceOptional } from "./WorkspaceShell";
import { NOTICE_DOT, NOTICE_FOCUS, NOTICE_LABEL, NOTICE_SURFACE } from "./chat/composerNotice";
import { NextChevron } from "@/components/ui/NextChevron";
import { CGO_LABEL } from "./layout/shared";

export const QUESTIONS_ANCHOR_ID = "growth-questions";
export const QUESTIONS_JUMP_EVENT = "zavi:jump-to-questions";
const JUMP_TTL_MS = 30_000;
let jumpRequestedAt: number | null = null;

export function requestQuestionsJump() {
  jumpRequestedAt = Date.now();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(QUESTIONS_JUMP_EVENT));
}

export function takeQuestionsJump(): boolean {
  const at = jumpRequestedAt;
  jumpRequestedAt = null;
  return at != null && Date.now() - at < JUMP_TTL_MS;
}

export type WaitingQuestion = {
  id: string;
  ordinal: number | null;
  ask: string;
  recommended: "yes" | "no" | null;
  why: string | null;
  yes_no: boolean;
  fact_check?: boolean;
};

export type Answered = { label: string; note: string | null };

export type ReadState = "loading" | "ready" | "failed";

function viaLabel(via: string | null | undefined): string {
  return via === "slack" ? "Slack" : via === "email" ? "email" : "the web";
}

export function useWaitingQuestions() {
  const [questions, setQuestions] = useState<WaitingQuestion[]>([]);
  const [canAnswer, setCanAnswer] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [state, setState] = useState<ReadState>("loading");

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/growth/questions");
      if (!res.ok) {
        setState("failed");
        return;
      }
      const j = (await res.json()) as { can_answer?: boolean; questions?: WaitingQuestion[]; queued_count?: number };
      setQuestions(Array.isArray(j.questions) ? j.questions : []);
      setCanAnswer(j.can_answer === true);
      setQueuedCount(typeof j.queued_count === "number" && j.queued_count > 0 ? j.queued_count : 0);
      setState("ready");
    } catch {
      setState("failed");
    }
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const pullOpened = useCallback(async () => {
    try {
      const res = await apiFetch("/api/workspace/growth/questions");
      if (!res.ok) return;
      const j = (await res.json()) as { questions?: WaitingQuestion[]; queued_count?: number };
      const fresh = Array.isArray(j.questions) ? j.questions : [];
      setQuestions((cur) => [...cur, ...fresh.filter((q) => !cur.some((c) => c.id === q.id))]);
      setQueuedCount(typeof j.queued_count === "number" && j.queued_count > 0 ? j.queued_count : 0);
    } catch {
    }
  }, []);

  return { questions, canAnswer, queuedCount, state, reload: load, pullOpened };
}

const NUDGE_HIDDEN_KEY = "zavi:questions-nudge-hidden";

function readHiddenIds(): string[] {
  try {
    const raw = window.localStorage.getItem(NUDGE_HIDDEN_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function WaitingForYouLink({ embedded = false }: { embedded?: boolean }) {
  const workspace = useWorkspaceOptional();
  const { questions } = useWaitingQuestions();
  const [hiddenIds, setHiddenIds] = useState<string[] | null>(null);
  useEffect(() => setHiddenIds(readHiddenIds()), []);
  if (questions.length === 0 || !workspace || hiddenIds === null) return null;
  if (questions.every((q) => hiddenIds.includes(q.id))) return null;
  const n = questions.length;
  const hide = () => {
    const ids = questions.map((q) => q.id);
    setHiddenIds(ids);
    try {
      window.localStorage.setItem(NUDGE_HIDDEN_KEY, JSON.stringify(ids));
    } catch {
    }
  };
  return (
    <div className={embedded ? "mb-4 flex shrink-0 justify-center font-sans" : "shrink-0 px-4 pb-2 pt-1 font-sans"}>
      <div className={embedded ? "relative inline-flex max-w-full" : "relative mx-auto w-full max-w-[42rem]"}>
        <button
          type="button"
          data-testid="questions-nudge"
          onClick={() => {
            requestQuestionsJump();
            workspace.openTab({
              kind: "autopilot",
              title: CGO_LABEL,
              payload: { kind: "autopilot" },
              dirty: false,
              pinned: false,
            });
          }}
          data-variant={embedded ? "home" : "inline"}
          className={
            embedded
              ? `group inline-flex h-9 max-w-full cursor-pointer items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.09] pl-4 pr-10 text-left text-[13px] leading-none transition-colors hover:border-amber-500/50 hover:bg-amber-500/[0.14] ${NOTICE_FOCUS}`
              : `group ${NOTICE_SURFACE} cursor-pointer pr-10 text-left transition-[background-color,border-color,box-shadow] hover:border-inkMuted/40 hover:bg-creamDeep hover:shadow-[0_2px_8px_rgb(14_15_17/0.06)] ${NOTICE_FOCUS}`
          }
        >
          {embedded ? (
            <span aria-hidden className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500/60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
          ) : (
            <span aria-hidden className={NOTICE_DOT} />
          )}
          <span className={embedded ? "min-w-0 truncate text-inkSoft" : `${NOTICE_LABEL} flex-1 truncate`}>
            Zavi has {n} {n === 1 ? "question" : "questions"} for you
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-ink">
            Open {CGO_LABEL}
            <NextChevron className="transition-transform duration-150 ease-out group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5 motion-reduce:transition-none" />
          </span>
        </button>
        <button
          type="button"
          data-testid="questions-nudge-hide"
          onClick={hide}
          aria-label="Hide"
          title="Hide"
          className={`absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-inkMuted transition-colors hover:bg-ink/[0.06] hover:text-ink ${NOTICE_FOCUS}`}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function answeredLabel(answer: unknown): string {
  if (answer === "yes") return "Yes";
  if (answer === "no") return "No";
  if (answer === "not_now") return "Not now";
  if (answer && typeof answer === "object" && typeof (answer as { text?: unknown }).text === "string") {
    return `"${(answer as { text: string }).text}"`;
  }
  if (typeof answer === "string" && answer.trim()) return `"${answer.replace(/^My words: /, "")}"`;
  return "answered";
}

const PILL =
  "flex h-8 items-center rounded-full px-4 text-[14px] font-medium transition-opacity disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export function WaitingForYou({
  questions,
  canAnswer,
  queuedCount = 0,
  answered,
  onAnswered,
  onAsk,
}: {
  questions: WaitingQuestion[];
  canAnswer: boolean;
  queuedCount?: number;
  answered: Readonly<Record<string, Answered>>;
  onAnswered: (id: string, a: Answered) => void;
  onAsk?: (text: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [wordsOpen, setWordsOpen] = useState<string | null>(null);
  const [words, setWords] = useState<Record<string, string>>({});

  async function answer(q: WaitingQuestion, a: "yes" | "no" | "not_now" | { text: string }) {
    setBusy(q.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/growth/questions/${encodeURIComponent(q.id)}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: a }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        outcome?: string;
        answer?: unknown;
        via?: string | null;
        applied?: string | null;
        note?: string | null;
        error?: { message?: string };
      };
      if (!res.ok) {
        setError({ id: q.id, message: j.error?.message ?? "Could not save your answer. Try again." });
        return;
      }
      const label = answeredLabel(j.answer ?? a);
      setWordsOpen(null);
      onAnswered(
        q.id,
        j.outcome === "already_answered"
          ? { label: `Already answered: ${label} via ${viaLabel(j.via)}`, note: null }
          : j.outcome === "closed"
            ? { label: "No longer open", note: "Nothing changed." }
            : a === "not_now"
              ? { label: "Not now", note: "Zavi won't ask this again for two weeks." }
              : j.note
              ? { label: `Not applied: ${label}`, note: j.note }
              : { label: `Answered: ${label}`, note: j.applied ?? null },
      );
    } catch {
      setError({ id: q.id, message: "Could not save your answer. Try again." });
    } finally {
      setBusy(null);
    }
  }

  if (questions.length === 0) return null;
  const anchorId = questions.find((q) => !answered[q.id])?.id ?? null;

  return (
    <>
      {questions.map((q) => {
        const done = answered[q.id];
        const rec = q.recommended === "yes" ? "Yes" : q.recommended === "no" ? "No" : null;
        const text = (words[q.id] ?? "").trim();
        const boxOpen = !q.yes_no || wordsOpen === q.id;
        return (
          <li
            key={q.id}
            id={q.id === anchorId ? QUESTIONS_ANCHOR_ID : undefined}
            className={`scroll-mt-4 border-t border-rule px-4 py-3.5 first:border-t-0 ${done ? "bg-successBg dark:bg-success/10" : ""}`}>
            <p className="text-[11px] font-bold uppercase tracking-[0.05em] text-inkMuted">Question</p>
            <p className="mt-0.5 text-[14px] font-semibold leading-6 text-ink">
              {q.ordinal != null ? `${q.ordinal}. ` : ""}
              {q.ask}
              {rec && <span className="font-normal text-inkMuted"> (I recommend: {rec})</span>}
            </p>
            {q.why && <p className="mt-0.5 text-[13px] text-inkMuted">{q.why}</p>}
            {done ? (
              <p className="mt-1.5 text-[13px] font-medium text-success" role="status">
                {done.label}
                {done.note && <span className="block font-normal text-inkMuted">{done.note}</span>}
              </p>
            ) : (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {canAnswer && q.yes_no && (
                    <>
                      {(["yes", "no"] as const).map((a) => (
                        <button
                          key={a}
                          type="button"
                          disabled={busy === q.id}
                          onClick={() => void answer(q, a)}
                          className={`${PILL} ${
                            q.recommended === a
                              ? "bg-ink text-cream hover:opacity-90"
                              : "border border-rule text-ink hover:bg-creamDeep"
                          }`}
                        >
                          {a === "yes" ? "Yes" : "No"}
                        </button>
                      ))}
                    </>
                  )}
                  {canAnswer && q.yes_no && (
                    <button
                      type="button"
                      aria-expanded={wordsOpen === q.id}
                      onClick={() => setWordsOpen(wordsOpen === q.id ? null : q.id)}
                      className="text-[13px] text-inkMuted underline decoration-rule underline-offset-2 hover:text-ink"
                    >
                      Type an answer
                    </button>
                  )}
                  {canAnswer && !q.fact_check && (
                    <button
                      type="button"
                      disabled={busy === q.id}
                      onClick={() => void answer(q, "not_now")}
                      className="text-[13px] text-inkMuted underline decoration-rule underline-offset-2 hover:text-ink disabled:opacity-50"
                    >
                      Not now
                    </button>
                  )}
                </div>
                {canAnswer && boxOpen && (
                  <form
                    className="mt-2 flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (text && busy !== q.id) void answer(q, { text });
                    }}
                  >
                    <input
                      aria-label="Your answer"
                      value={words[q.id] ?? ""}
                      maxLength={500}
                      onChange={(e) => setWords((w) => ({ ...w, [q.id]: e.target.value }))}
                      placeholder="Tell Zavi…"
                      className="min-w-0 flex-1 rounded-full border border-rule bg-creamDeep px-3.5 py-1.5 text-[14px] text-ink placeholder:text-inkMuted focus:border-inkMuted focus:outline-none"
                    />
                    <button type="submit" disabled={!text || busy === q.id} className={`${PILL} bg-ink text-cream hover:opacity-90`}>
                      {busy === q.id ? "Sending…" : "Send"}
                    </button>
                    {onAsk && (
                      <p className="w-full text-[13px] text-inkMuted">
                        Not sure?{" "}
                        <button
                          type="button"
                          onClick={() => onAsk(`About your question "${q.ask}": `)}
                          className="underline decoration-rule underline-offset-2 hover:text-ink"
                        >
                          Ask Zavi
                        </button>
                      </p>
                    )}
                  </form>
                )}
              </>
            )}
            {error?.id === q.id && (
              <p className="mt-2 text-[13px] text-warn dark:text-marigold" role="alert">
                {error.message}
              </p>
            )}
          </li>
        );
      })}
      {queuedCount > 0 && (
        <li className="border-t border-rule px-4 py-3 text-[13px] text-inkMuted first:border-t-0" data-testid="questions-queued">
          {queuedCount} more {queuedCount === 1 ? "question" : "questions"} after these. {queuedCount === 1 ? "It opens" : "They open"} as you answer.
        </li>
      )}
    </>
  );
}
