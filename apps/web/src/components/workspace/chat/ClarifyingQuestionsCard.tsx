"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { agentDisplayName } from "@/lib/agentRegistry";
import { FOCUS_RING } from "../layout/shared";
import { createBrowserSupabase } from "@/lib/supabase";
import { NextChevron } from "@/components/ui/NextChevron";

type ClarifyOption = {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  prefill?: boolean;
  preview?: string;
  provenance?: {
    source_id?: string;
    source_type?: "memory" | "connector";
    source_label?: string;
    excerpt?: string;
  };
};

type ClarifyQuestion = {
  id: string;
  text: string;
  header: string;
  why?: string;
  type: "single" | "multi" | "text";
  options: ClarifyOption[];
  allow_other: boolean;
  allow_skip?: boolean;
  required?: boolean;
  max_length?: number;
  sensitive?: boolean;
};

export type ClarifyEnvelope = {
  envelope_kind: "clarifying_questions";
  schema_version: number;
  request_id: string;
  agent_slug: string;
  intro?: string;
  questions: ClarifyQuestion[];
  submit_label?: string;
};

type Answer = {
  optionIds: string[];
  otherText: string;
  skipped: boolean;
};

function emptyAnswer(): Answer {
  return { optionIds: [], otherText: "", skipped: false };
}

function prefillEligible(o: ClarifyOption): boolean {
  return o.prefill === true && !!o.provenance && typeof o.provenance.source_id === "string";
}

function seedAnswers(env: ClarifyEnvelope): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const q of env.questions) {
    const a = emptyAnswer();
    if (q.type === "multi") {
      a.optionIds = q.options.filter(prefillEligible).map((o) => o.id);
    } else if (q.type === "single") {
      const first = q.options.find(prefillEligible);
      if (first) a.optionIds = [first.id];
    }
    out[q.id] = a;
  }
  return out;
}

function clampExcerpt(s: string, max = 120): string {
  const clean = s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function isRequiredSatisfied(q: ClarifyQuestion, a: Answer): boolean {
  if (q.type === "text") return a.otherText.trim().length > 0;
  return a.optionIds.length > 0 || a.otherText.trim().length > 0;
}

type StructuredAnswer = {
  question_id: string;
  option_ids?: string[];
  other_text?: string;
  skipped?: boolean;
};
function toStructuredAnswers(
  env: ClarifyEnvelope,
  answers: Record<string, Answer>,
): StructuredAnswer[] {
  return env.questions.map((q) => {
    const a = answers[q.id] ?? emptyAnswer();
    const out: StructuredAnswer = { question_id: q.id };
    if (a.skipped) {
      out.skipped = true;
      return out;
    }
    if (a.optionIds.length > 0) out.option_ids = a.optionIds;
    if (a.otherText.trim().length > 0) out.other_text = a.otherText.trim();
    return out;
  });
}

type CardProps = {
  envelope: ClarifyEnvelope;
  agentSlug: string;
  threadId?: string | null;
};

export function ClarifyingQuestionsCard(props: CardProps) {
  if (
    !Array.isArray(props.envelope.questions) ||
    props.envelope.questions.length === 0
  ) {
    return null;
  }
  return <ClarifyCardInner {...props} />;
}

function ClarifyCardInner({ envelope, agentSlug }: CardProps) {
  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    seedAnswers(envelope),
  );
  const [inflight, setInflight] = useState(false);
  const [step, setStep] = useState(0);
  const [activeOption, setActiveOption] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const questions = envelope.questions;
  const total = questions.length;
  const step_ = Math.min(step, total - 1);
  const q = questions[step_];
  const a = answers[q.id] ?? emptyAnswer();
  const isLast = step_ === total - 1;

  const setAnswer = useCallback(
    (qid: string, patch: Partial<Answer>) => {
      setAnswers((prev) => ({ ...prev, [qid]: { ...(prev[qid] ?? emptyAnswer()), ...patch } }));
    },
    [],
  );

  const toggleOption = useCallback(
    (optId: string) => {
      const cur = answers[q.id] ?? emptyAnswer();
      const has = cur.optionIds.includes(optId);
      if (q.type === "single") {
        setAnswer(q.id, { optionIds: has ? [] : [optId], skipped: false });
      } else {
        setAnswer(q.id, {
          optionIds: has
            ? cur.optionIds.filter((x) => x !== optId)
            : [...cur.optionIds, optId],
          skipped: false,
        });
      }
    },
    [answers, q, setAnswer],
  );

  const unansweredRequired = useMemo(
    () =>
      questions.filter(
        (qq) =>
          qq.required &&
          !isRequiredSatisfied(qq, answers[qq.id] ?? emptyAnswer()),
      ),
    [questions, answers],
  );

  const goTo = useCallback(
    (idx: number) => {
      setError(null);
      setActiveOption(0);
      optionRefs.current = [];
      setStep(Math.max(0, Math.min(idx, total - 1)));
    },
    [total],
  );
  const goNext = useCallback(() => {
    if (!isLast) goTo(step_ + 1);
  }, [isLast, step_, goTo]);
  const goBack = useCallback(() => goTo(step_ - 1), [step_, goTo]);

  const submitWith = useCallback(
    async (snapshot: Record<string, Answer>) => {
      const missing = questions.filter(
        (qq) =>
          qq.required &&
          !isRequiredSatisfied(qq, snapshot[qq.id] ?? emptyAnswer()),
      );
      if (missing.length > 0) {
        const idx = questions.findIndex((qq) => qq.id === missing[0].id);
        if (idx >= 0) goTo(idx);
        setError(`Please answer: ${missing.map((qq) => qq.header).join(", ")}.`);
        return;
      }
      setError(null);
      setInflight(true);
      try {
        const res = await apiFetch(
          `/api/agents/${encodeURIComponent(agentSlug)}/clarify-submit`,
          {
            method: "POST",
            body: JSON.stringify({
              request_id: envelope.request_id,
              answers: toStructuredAnswers(envelope, snapshot),
            }),
          },
        );
        if (res.ok) {
          setSubmitted(true);
        } else {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          setError(body?.error?.message ?? "Couldn't send your answers. Please try again.");
        }
      } catch {
        setError("Couldn't send your answers. Please try again.");
      } finally {
        setInflight(false);
      }
    },
    [questions, envelope, agentSlug, goTo],
  );
  const submit = useCallback(() => submitWith(answers), [submitWith, answers]);

  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await supabase
          .from("agent_clarification_responses")
          .select("draft_answers,status")
          .eq("request_id", envelope.request_id)
          .maybeSingle();
        if (cancelled || !data) return;
        if (data.status === "submitted" || data.status === "consumed") {
          setSubmitted(true);
        } else {
          const draft = data.draft_answers as Record<string, Answer> | null;
          if (draft && Object.keys(draft).length > 0) {
            setAnswers((prev) => ({ ...prev, ...draft }));
          }
        }
      } catch (e) {
        console.warn("[clarify-card] hydrate read failed", (e as Error).message);
      } finally {
        if (!cancelled) hydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, envelope.request_id]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (submitted) return;
    if (!hydratedRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void supabase.rpc("upsert_clarification_draft", {
        p_request_id: envelope.request_id,
        p_answers: answers,
      });
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [answers, submitted, supabase, envelope.request_id]);

  const onOptionKeyDown = useCallback(
    (e: React.KeyboardEvent, idx: number) => {
      const n = q.options.length;
      if (n === 0) return;
      let target = idx;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        target = (idx + 1) % n;
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        target = (idx - 1 + n) % n;
      } else {
        return;
      }
      setActiveOption(target);
      optionRefs.current[target]?.focus();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.id, q.options.length],
  );

  if (submitted) {
    return (
      <div className="mt-2 rounded-[16px] border border-rule bg-cream px-5 py-3.5 text-[13px] text-inkMuted">
        Answers sent. {agentDisplayName(agentSlug)} is continuing…
      </div>
    );
  }

  return (
    <div className="mt-2 w-full rounded-[16px] border border-rule bg-cream px-6 pb-6 pt-5 motion-safe:transition-all">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.08em] text-inkMuted">
          {q.header}
        </span>
        <span className="text-[11px] tabular-nums text-inkMuted" aria-live="polite">
          {step_ + 1} of {total}
        </span>
      </div>

      {total > 1 && (
        <div className="mb-5 flex gap-1" aria-hidden="true">
          {questions.map((qq, i) => (
            <span
              key={qq.id}
              className={`h-1 flex-1 rounded-full ${i <= step_ ? "bg-ink/70" : "bg-ink/10"}`}
            />
          ))}
        </div>
      )}

      <div className="text-[16px] font-semibold leading-[1.4] text-ink">
        {q.text}
        {q.required && (
          <span className="ml-1 text-danger" aria-label="required">
            *
          </span>
        )}
      </div>
      {q.why && (
        <p className="mt-1.5 text-[13px] leading-[1.5] text-inkMuted">{q.why}</p>
      )}

      {}
      {q.type !== "text" && q.options.length > 0 && (
        <div
          role={q.type === "single" ? "radiogroup" : "group"}
          aria-label={q.text}
          className="mt-5 space-y-2"
        >
          {q.options.map((opt, i) => {
            const selected = a.optionIds.includes(opt.id);
            return (
              <button
                key={opt.id}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                type="button"
                role={q.type === "single" ? "radio" : "checkbox"}
                aria-checked={selected}
                tabIndex={i === activeOption ? 0 : -1}
                onKeyDown={(e) => onOptionKeyDown(e, i)}
                onClick={() => {
                  setActiveOption(i);
                  toggleOption(opt.id);
                }}
                className={`flex w-full items-start gap-3 rounded-[12px] border px-4 py-3 text-left text-[14px] motion-safe:transition-colors ${FOCUS_RING} ${
                  selected
                    ? "border-ink/40 bg-ink/[0.06]"
                    : "border-rule bg-transparent hover:bg-ink/[0.03]"
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center ${
                    q.type === "single" ? "rounded-full" : "rounded"
                  } border ${selected ? "border-ink bg-ink text-cream" : "border-inkLight"}`}
                  aria-hidden="true"
                >
                  {selected && <span className="text-[11px] leading-none">✓</span>}
                </span>
                <span className="min-w-0">
                  <span className="font-medium text-ink">
                    {opt.label}
                    {}
                    {opt.recommended && opt.provenance && (
                      <span className="ml-1.5 text-[12px] font-normal text-inkMuted">
                        recommended
                      </span>
                    )}
                  </span>
                  {opt.description && (
                    <span className="mt-0.5 block text-[13px] leading-[1.5] text-inkMuted">
                      {opt.description}
                    </span>
                  )}
                  {}
                  {opt.provenance && (opt.prefill || opt.recommended) && (
                    <span
                      className="mt-1 block truncate text-[12px] text-inkLight"
                      title={opt.provenance.excerpt || opt.provenance.source_label || ""}
                    >
                      Suggested from {opt.provenance.source_label || "saved context"}
                      {opt.provenance.excerpt
                        ? `: “${clampExcerpt(opt.provenance.excerpt)}”`
                        : ""}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {}
      {(q.type === "text" || q.allow_other) && (
        <div className="mt-4">
          {q.type !== "text" && (
            <label
              htmlFor={`${q.id}-other`}
              className="mb-1.5 block text-[14px] font-medium text-inkMuted"
            >
              Other
            </label>
          )}
          <textarea
            id={`${q.id}-other`}
            value={a.otherText}
            maxLength={q.max_length ?? 2000}
            onChange={(e) =>
              setAnswer(q.id, { otherText: e.target.value, skipped: false })
            }
            placeholder={q.type === "text" ? "Type your answer…" : "Something else…"}
            rows={q.type === "text" ? 3 : 2}
            className="block w-full resize-none rounded-[12px] border border-rule bg-transparent px-4 py-3 text-[14px] leading-[1.5] text-ink placeholder:text-inkLight focus:border-inkMuted focus:outline-none"
          />
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-2 rounded-lg bg-danger/10 px-3 py-1.5 text-[12px] text-danger"
        >
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center gap-2">
        {step_ > 0 && (
          <button
            type="button"
            onClick={goBack}
            className={`inline-flex h-9 items-center rounded-full px-3.5 text-[13px] text-ink transition-colors hover:bg-ink/[0.05] ${FOCUS_RING}`}
          >
            Back
          </button>
        )}
        {}
        {q.allow_skip && !q.required && (
          <button
            type="button"
            onClick={() => {
              const next = {
                ...answers,
                [q.id]: { skipped: true, optionIds: [], otherText: "" },
              };
              setAnswers(next);
              if (!isLast) goNext();
              else void submitWith(next);
            }}
            className={`inline-flex h-9 items-center rounded-full px-3 text-[13px] text-inkMuted transition-colors hover:bg-ink/[0.05] hover:text-ink ${FOCUS_RING}`}
          >
            Skip
          </button>
        )}
        <div className="flex-1" />
        {!isLast ? (
          <button
            type="button"
            onClick={goNext}
            className={`inline-flex h-9 items-center rounded-full bg-ink px-4 text-[13px] font-medium text-cream transition-colors hover:bg-ink/90 ${FOCUS_RING}`}
          >
            Next <NextChevron />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={inflight}
            className={`inline-flex h-9 items-center rounded-full bg-ink px-4 text-[13px] font-medium text-cream transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink/10 disabled:text-inkLight ${FOCUS_RING}`}
          >
            {inflight ? "Sending…" : (envelope.submit_label ?? "Send answers")}
          </button>
        )}
      </div>
    </div>
  );
}
