"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { apiFetch } from "@/lib/api";
import { Markdown } from "@/components/workspace/Markdown";
import { modifyPlaceholder, modifyQuickReplies } from "./proposalView";

export type ProposalRevision = {
  id: string;
  status: string;
  message: string;
  assistant_text: string | null;
  replacement_decision_id: string | null;
  last_error?: string | null;
  created_at: string;
};

export type InlineProposalDecision = {
  id: string;
  decision_class: string;
  handler: string | null;
  body: Record<string, unknown>;
  revision?: ProposalRevision | null;
};

type TranscriptTurn = {
  role: "user" | "assistant";
  body: string | null;
  created_at: string;
  run_id?: string | null;
  failed?: boolean;
};

type TranscriptResponse = {
  decision_id: string;
  transcript: TranscriptTurn[];
  active: boolean;
  transcript_error?: boolean;
};

function TypingDots() {
  return (
    <div className="flex items-center gap-2 text-[13px] leading-5 text-[#595959]">
      <span className="flex gap-1">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a8a8a8] [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a8a8a8] [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#a8a8a8]" />
      </span>
      performance-marketer is revising… this can take up to a minute
    </div>
  );
}

export function InlineProposalModifyChat({
  decision,
  open,
  onClose,
  onSubmitted,
  readOnly = false,
}: {
  decision: InlineProposalDecision;
  open: boolean;
  onClose: () => void;
  onSubmitted: () => Promise<void> | void;
  readOnly?: boolean;
}) {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [active, setActive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const revision = decision.revision ?? null;

  const visible = open || !!revision || readOnly;

  const loadTranscript = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/approvals/${decision.id}/revision-transcript`);
      if (!res.ok) return;
      const j = (await res.json()) as TranscriptResponse;
      setTranscript(j.transcript ?? []);
      setActive(!!j.active);
    } catch {
    } finally {
      setLoaded(true);
    }
  }, [decision.id]);

  useEffect(() => {
    if (!visible) return;
    void loadTranscript();
  }, [visible, loadTranscript]);

  useEffect(() => {
    if (!visible || !active) return;
    const id = setInterval(() => void loadTranscript(), 4000);
    return () => clearInterval(id);
  }, [visible, active, loadTranscript]);

  useEffect(() => {
    if (!open || transcript.length > 0) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open, transcript.length]);

  if (!visible) return null;

  const quickReplies = modifyQuickReplies(decision.decision_class, decision.handler, decision.body);
  const placeholder = modifyPlaceholder(decision.decision_class, decision.handler, decision.body);

  const submit = async () => {
    const text = message.trim();
    if (text.length < 3 || submitting || active) return;
    setSubmitting(true);
    setError(null);
    setTranscript((prev) => [
      ...prev,
      { role: "user", body: text, created_at: new Date().toISOString() },
    ]);
    setActive(true);
    try {
      const res = await apiFetch(`/api/approvals/${decision.id}/revision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const msg =
          body && typeof body === "object" && "error" in body
            ? ((body as { error?: { message?: string } }).error?.message ?? "Revision request failed")
            : "Revision request failed";
        setError(msg);
        await loadTranscript();
        return;
      }
      setMessage("");
      await loadTranscript();
      await onSubmitted();
    } catch (e) {
      setError((e as Error).message);
      await loadTranscript();
    } finally {
      setSubmitting(false);
    }
  };

  const composerDisabled = active || submitting;

  return (
    <div className="mt-5 border-t border-[#f0f0f0] pt-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-[16px] font-semibold leading-5 text-[#0e0f11]">
          {readOnly ? "Conversation" : "Modify this proposal"}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-cta px-2 py-1 text-[12px] font-semibold text-[#595959] hover:bg-[#f1efe9]"
        >
          Close
        </button>
      </div>

      {}
      {transcript.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {transcript.map((t, i) =>
            t.role === "user" ? (
              <div
                key={i}
                className="self-end max-w-[88%] rounded-lg bg-[#f0f0f0] px-3 py-2 text-[13px] font-medium leading-5 text-[#0e0f11]"
              >
                {t.body}
              </div>
            ) : t.failed ? (
              <div
                key={i}
                className="self-start max-w-[92%] rounded-lg border border-[#f1c0bc] bg-[#fdf2f1] px-3 py-2 text-[13px] leading-5 text-[#c0392b]"
              >
                performance-marketer couldn’t complete this revision. You can approve the original or ask again.
              </div>
            ) : (
              <div
                key={i}
                className="self-start max-w-[92%] rounded-lg border border-[#e5e5e5] bg-white px-3.5 py-2.5 text-[#0e0f11]"
              >
                <Markdown source={t.body ?? ""} disableActionLinks />
              </div>
            ),
          )}
        </div>
      )}

      {active && (
        <div className="mb-3">
          <TypingDots />
        </div>
      )}

      {!readOnly && loaded && transcript.length === 0 && !active && (
        <div className="mb-3 text-[13px] leading-5 text-[#595959]">
          Tell performance-marketer what to change. It will come back with a revised proposal for approval.
        </div>
      )}

      {}
      {readOnly ? (
        <div className="text-[12px] leading-5 text-[#a8a8a8]">
          This proposal is no longer pending. The conversation is shown for reference.
        </div>
      ) : (
        <>
          {}
          <div className="mb-2 flex flex-wrap gap-2">
            {quickReplies.map((q) => (
              <button
                key={q}
                type="button"
                disabled={composerDisabled}
                onClick={() => setMessage(q)}
                className="rounded-cta bg-[#f1efe9] px-2 py-1 text-[12px] font-semibold text-[#595959] hover:bg-[#e8e4da] hover:text-[#0e0f11] disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
          <TextareaAutosize
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={composerDisabled}
            minRows={2}
            maxRows={5}
            placeholder={active ? "Waiting for performance-marketer…" : placeholder}
            className="w-full resize-none rounded-lg border border-[#e5e5e5] bg-white px-3 py-2 text-[16px] leading-5 text-[#0e0f11] outline-none placeholder:text-[#a8a8a8] focus:border-[#0e0f11] disabled:bg-[#f7f7f7] disabled:opacity-70"
          />
          {error && <div className="mt-2 text-[12px] font-medium text-[#c0392b]">{error}</div>}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={message.trim().length < 3 || composerDisabled}
              className="rounded-cta bg-[#0e0f11] px-3 py-2 text-[13px] font-semibold text-white transition-opacity disabled:opacity-50"
            >
              {submitting ? "Sending…" : "Ask for revision"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
