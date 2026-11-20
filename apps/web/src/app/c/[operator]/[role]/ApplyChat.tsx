"use client";

import { useEffect, useRef, useState } from "react";
import { candidateFetch } from "@/lib/candidateApi";
import { Textarea } from "@/components/Input";

type Msg = { id: string | number; role: "agent" | "candidate"; content: string };

const ACCEPT = ".pdf,.docx,.txt";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function AgentAvatar() {
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-cream"
      aria-hidden
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
        <path
          d="M8 1.5l1.6 3.6 3.9.4-2.9 2.6.8 3.9L8 12.6 4.6 12.5l.8-3.9L2.5 6l3.9-.4L8 1.5z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 px-1 py-1.5" aria-label="Typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 rounded-full bg-inkMuted/60 motion-safe:animate-bounce"
          style={{ animationDelay: `${i * 0.16}s`, animationDuration: "1s" }}
        />
      ))}
    </span>
  );
}

export function ApplyChat({
  operatorSlug,
  roleSlug,
  roleTitle: _roleTitle,
  operatorLabel,
}: {
  operatorSlug: string;
  roleSlug: string;
  roleTitle: string;
  operatorLabel?: string;
}) {
  const [phase, setPhase] = useState<"intake" | "chatting" | "done">("intake");
  const [email, setEmail] = useState("");
  const [resume, setResume] = useState<File | null>(null);
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [reply, setReply] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [awaitingAgent, setAwaitingAgent] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastSeenIdRef = useRef<number>(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!applicationId || !token) return;
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelled) return;
        const res = await candidateFetch(
          `/api/c/applications/${applicationId}/messages?token=${encodeURIComponent(token!)}&since_id=${lastSeenIdRef.current}`,
        );
        if (!res.ok) continue;
        const out = await res.json();
        const newAgentMsgs = (out.messages ?? []).filter(
          (m: any) => m.role === "agent",
        );
        if (newAgentMsgs.length === 0) continue;
        const maxId = newAgentMsgs.reduce(
          (acc: number, m: any) => Math.max(acc, Number(m.id)),
          lastSeenIdRef.current,
        );
        lastSeenIdRef.current = maxId;
        setMsgs((prev) => [...prev, ...newAgentMsgs]);
        if (!cancelled) setAwaitingAgent(false);
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [applicationId, token]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, awaitingAgent]);

  async function start() {
    if (!resume || !email) return;
    setSubmitting(true);
    setError(null);
    const fd = new FormData();
    fd.append("operator_slug", operatorSlug);
    fd.append("role_slug", roleSlug);
    fd.append("candidate_email", email);
    fd.append("resume", resume);
    const res = await fetch("/api/c/applications/start", {
      method: "POST",
      body: fd,
    });
    const out = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (out.application_id) {
      setApplicationId(out.application_id);
      setToken(out.candidate_token);
      setPhase("chatting");
      setAwaitingAgent(true);
    } else {
      setError(
        out?.error?.message ||
          (res.status === 429
            ? "Too many attempts right now. Please try again in a little while."
            : "We couldn't start your application. Check your resume file (PDF, DOCX, or TXT) and try again."),
      );
    }
  }

  async function send() {
    if (!reply.trim() || !applicationId || !token) return;
    const myMsg = reply;
    setMsgs((prev) => [
      ...prev,
      { id: Date.now(), role: "candidate", content: myMsg },
    ]);
    setReply("");
    setAwaitingAgent(true);
    const res = await candidateFetch(
      `/api/c/applications/${applicationId}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ candidate_token: token, message: myMsg }),
      },
    );
    if (res.status === 409) {
      setAwaitingAgent(false);
      setPhase("done");
    }
  }

  if (phase === "done") {
    return (
      <div className="rounded-2xl border border-ink/10 bg-white p-7 text-center shadow-[0_8px_24px_-12px_rgba(25,25,25,0.10)] sm:p-9">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-mint/40 text-mintDeep">
          <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden>
            <path
              d="M5 12.5l4.5 4.5L19 7.5"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <h2 className="mt-4 font-display text-[24px] font-semibold tracking-tighter text-ink">
          Thanks, your application is in
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-[16px] leading-[1.6] text-inkMuted">
          {operatorLabel ? `${operatorLabel}'s team` : "The team"} will review
          everything you shared and reach out by email about next steps. A real
          person reviews every application.
        </p>
      </div>
    );
  }

  if (phase === "intake") {
    return (
      <div className="rounded-2xl border border-ink/10 bg-white p-6 shadow-[0_8px_24px_-12px_rgba(25,25,25,0.10)] sm:p-7">
        <h2 className="font-display text-[20px] font-semibold tracking-tighter text-ink">
          Apply
        </h2>
        <p className="mt-1.5 text-[16px] leading-[1.6] text-inkMuted">
          We use a short, conversational screen to make first contact more
          human. It takes a few minutes.
        </p>

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-inkMuted">
              Email
            </span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl border border-ink/15 bg-cream/40 px-3.5 py-3 text-[14px] text-ink placeholder:text-inkMuted/60 transition-colors focus:border-ink focus:bg-white focus:outline-none focus:ring-4 focus:ring-ink/5"
            />
          </label>

          <div>
            <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-inkMuted">
              Resume
            </span>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) {
                  setResume(f);
                  setError(null);
                }
              }}
              className={`flex w-full flex-col items-center justify-center gap-2 rounded-cta border border-dashed px-4 py-7 text-center transition-colors ${
                dragOver
                  ? "border-mintDeep bg-mint/15"
                  : resume
                    ? "border-ink/25 bg-cream/40"
                    : "border-ink/20 bg-cream/30 hover:border-ink/40 hover:bg-cream/50"
              }`}
            >
              {resume ? (
                <>
                  <span className="flex size-9 items-center justify-center rounded-lg bg-ink/5 text-ink">
                    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
                      <path
                        d="M14 3v4a1 1 0 001 1h4M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="max-w-full truncate text-[16px] font-medium text-ink">
                    {resume.name}
                  </span>
                  <span className="font-mono text-[11px] text-inkMuted">
                    {formatBytes(resume.size)} · tap to replace
                  </span>
                </>
              ) : (
                <>
                  <span className="flex size-9 items-center justify-center rounded-lg bg-ink/5 text-inkMuted">
                    <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
                      <path
                        d="M12 16V4m0 0l-4 4m4-4l4 4M5 20h14"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="text-[16px] font-medium text-ink">
                    Drag your resume here, or tap to browse
                  </span>
                  <span className="font-mono text-[11px] text-inkMuted">
                    PDF, DOCX or TXT
                  </span>
                </>
              )}
            </button>
            {}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              onChange={(e) => {
                setResume(e.target.files?.[0] ?? null);
                setError(null);
              }}
              className="sr-only"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-coral/30 bg-coral/[0.07] px-3.5 py-3 text-[16px] leading-[1.5] text-ink">
              {error}
            </div>
          )}

          <button
            disabled={!resume || !email || submitting}
            className="inline-flex h-12 w-full items-center justify-center rounded-cta bg-ink px-4 text-[14px] font-medium text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
            onClick={start}
          >
            {submitting ? "Starting…" : "Start application"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-ink/10 bg-white shadow-[0_8px_24px_-12px_rgba(25,25,25,0.10)]">
      {}
      <div className="flex items-center gap-2.5 border-b border-ink/[0.07] px-4 py-3 sm:px-4">
        <AgentAvatar />
        <div className="min-w-0">
          <p className="truncate text-[16px] font-semibold text-ink">
            {operatorLabel ? `${operatorLabel} hiring` : "Hiring screen"}
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-mintDeep">
            Online · screening
          </p>
        </div>
      </div>

      {}
      <div className="max-h-[58vh] space-y-3 overflow-y-auto px-4 py-4 sm:px-4">
        {msgs.length === 0 && !awaitingAgent && (
          <p className="py-6 text-center text-[16px] text-inkMuted">
            Getting things ready…
          </p>
        )}
        {msgs.map((m) => {
          const isCandidate = m.role === "candidate";
          return (
            <div
              key={m.id}
              className={`flex items-end gap-2 ${isCandidate ? "justify-end" : "justify-start"}`}
            >
              {!isCandidate && <AgentAvatar />}
              <div
                className={`max-w-[80%] whitespace-pre-wrap text-[16px] leading-[1.55] tracking-[-0.1px] ${
                  isCandidate
                    ? "rounded-2xl rounded-br-md bg-ink px-3.5 py-2.5 text-cream"
                    : "rounded-2xl rounded-bl-md border border-ink/10 bg-cream/50 px-3.5 py-2.5 text-inkSoft"
                }`}
              >
                {m.content}
              </div>
              {isCandidate && (
                <span
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-cream font-mono text-[11px] font-semibold text-inkMuted ring-1 ring-ink/10"
                  aria-hidden
                >
                  You
                </span>
              )}
            </div>
          );
        })}

        {}
        {awaitingAgent && (
          <div className="flex items-end gap-2">
            <AgentAvatar />
            <div className="rounded-2xl rounded-bl-md border border-ink/10 bg-cream/50 px-2 py-1.5">
              <TypingDots />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {}
      <div className="border-t border-ink/[0.07] bg-cream/30 px-3 py-3 sm:px-4">
        <div className="flex items-end gap-2">
          <Textarea
            unstyled
            className="flex-1 resize-none rounded-xl border border-ink/15 bg-white px-3.5 py-2.5 text-[16px] leading-[1.5] text-ink placeholder:text-inkMuted/60 transition-colors focus:border-ink focus:outline-none focus:ring-4 focus:ring-ink/5"
            rows={1}
            placeholder="Type your reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-cta bg-ink text-cream transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={send}
            disabled={!reply.trim()}
            aria-label="Send"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden>
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
