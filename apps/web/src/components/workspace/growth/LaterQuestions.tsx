"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { SETUP_QUESTIONS, type SetupQuestion, type SetupQuestionKey } from "../setup/setupQuestionsCopy";

type InterviewRead = {
  slots?: Array<{ key?: unknown; answer?: unknown }>;
  skipped?: unknown;
  customers_answered?: unknown;
};

function unanswered(body: InterviewRead): SetupQuestion[] {
  if (body.skipped === true) return [];
  const known = new Set<SetupQuestionKey>();
  for (const s of body.slots ?? []) {
    if (typeof s.answer === "string" && s.answer.trim()) known.add(s.key as SetupQuestionKey);
  }
  if (body.customers_answered === true) known.add("customers");
  return SETUP_QUESTIONS.filter((q) => !known.has(q.key));
}

const PILL = "inline-flex min-h-10 cursor-pointer items-center rounded-full border px-3.5 text-[14px] font-medium leading-5 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40";

export function LaterQuestions({ active }: { active: boolean }) {
  const [left, setLeft] = useState<SetupQuestion[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/workspace/growth-interview");
        if (!res.ok) return;
        const body = (await res.json()) as InterviewRead;
        if (!stopped) setLeft(unanswered(body));
      } catch {
        if (!stopped) setLeft([]);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [active]);

  const question = left[0];
  if (!active || !question) return null;

  const answer = async (choices: string[]) => {
    setSaving(true);
    setFailed(false);
    try {
      const res = await apiFetch("/api/workspace/growth-interview/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: question.key, answer: choices.join(", ") }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPicked([]);
      setLeft((now) => now.filter((q) => q.key !== question.key));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const skip = async () => {
    setSaving(true);
    setFailed(false);
    try {
      const res = await apiFetch("/api/workspace/growth-interview/skip", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLeft([]);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const tap = (option: string) => {
    if (!question.multi) {
      void answer([option]);
      return;
    }
    setPicked((now) => (now.includes(option) ? now.filter((o) => o !== option) : [...now, option]));
  };

  return (
    <section data-testid="later-questions" aria-label="A question from Zavi" aria-busy={saving || undefined} className="mb-6 rounded-3xl bg-creamDeep p-5">
      <h2 className="text-[17px] font-semibold leading-6 text-ink">{question.question}</h2>
      <p className="text-[14px] leading-5 text-inkMuted">{question.why}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {question.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={saving}
            aria-pressed={question.multi ? picked.includes(option) : undefined}
            onClick={() => tap(option)}
            className={`${PILL} ${picked.includes(option) ? "border-ink bg-ink text-cream" : "border-rule bg-cream text-ink hover:border-ink/15"}`}
          >
            {option}
          </button>
        ))}
        {question.multi && (
          <button type="button" disabled={saving || picked.length === 0} onClick={() => void answer(picked)} className={`${PILL} border-ink bg-ink text-cream`}>
            Save
          </button>
        )}
        <button type="button" disabled={saving} onClick={() => void skip()} className={`${PILL} border-rule bg-cream text-inkMuted hover:text-ink`}>
          Skip these
        </button>
      </div>
      {failed && <p role="alert" className="mt-2 text-[14px] text-inkMuted">That didn&apos;t save. Try again.</p>}
    </section>
  );
}
