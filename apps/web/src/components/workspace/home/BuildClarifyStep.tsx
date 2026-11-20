"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { isBuilderClarifyDynamicEnabled } from "@/lib/workspace/builderClarifyFlag";
import { NextChevron } from "@/components/ui/NextChevron";

type Choice = { id: string; label: string; recommended?: boolean };
type Question = {
  id: string;
  header: string;
  text: string;
  why: string;
  choices: Choice[];
  allowOther: boolean;
};

export const NAME_QUESTION_ID = "name";
const NAME_FROM_IDEA_ID = "name-from-idea";
const NAME_SUGGEST_ID = "name-suggest";
const NAME_DESCRIPTIVE_ID = "name-descriptive";
const MAX_STEP_QUESTIONS = 4;
const MAX_KEY_CHOICES = 4;
const MAX_DIGIT_KEY = 9;

const SUGGEST_CHOICE: Choice = { id: NAME_SUGGEST_ID, label: "Suggest a name for me" };

const NAME_QUESTION: Question = {
  id: NAME_QUESTION_ID,
  header: "Name",
  text: "What do you have in mind for the name?",
  why: "Your site and its address are named after it.",
  choices: [
    { id: NAME_FROM_IDEA_ID, label: "Use the name in my idea", recommended: true },
    SUGGEST_CHOICE,
    { id: NAME_DESCRIPTIVE_ID, label: "A plain name that says what it does" },
  ],
  allowOther: true,
};

const FALLBACK_QUESTIONS: Question[] = [
  NAME_QUESTION,
  {
    id: "audience",
    header: "Audience",
    text: "Who is this app for?",
    why: "Shapes the tone, the copy, and which features come first.",
    choices: [
      { id: "consumers", label: "Consumers" },
      { id: "businesses", label: "Businesses" },
      { id: "internal", label: "My internal team" },
      { id: "me", label: "Just me" },
    ],
    allowOther: true,
  },
  {
    id: "core_action",
    header: "Core action",
    text: "What's the ONE main thing a user does here?",
    why: "The first version is built around this action.",
    choices: [],
    allowOther: true,
  },
];

const AUDIENCE_IN_IDEA =
  /\b(?:anybody|anyone|everybody|everyone|customers?|clients?|consumers?|businesses|companies|teams?|parents|kids|students|families|locals|tourists|visitors|users|people|members|patients|guests|shoppers|buyers|owners|renters|drivers|travell?ers|professionals|freelancers|founders|b2b|b2c)\b/i;
const ACTION_IN_IDEA =
  /\b(?:order|buy|book|reserve|rent|purchase|browse|subscribe|sign up|signup|donate|apply|hire|schedule|pay|track|find|search|compare|enrol|enroll|join|request|sell|swipe|chat|message|upload|vote|learn|listen|download|contact|visit)(?:s|es|ed|ing)?\b/i;

function answeredByIdea(q: Question, idea: string): boolean {
  if (q.id === NAME_QUESTION_ID) return false;
  const asksAudience = /\baudience\b/i.test(q.header) || /^who\s+(?:(?:is|are)\s+(?:this(?:\s+(?:app|site|website|product))?|it|the\s+(?:app|site|website|product))\s+for|(?:are|will be)\s+(?:the|your|our)\s+(?:target\s+)?(?:users?|customers?|audience)|(?:will|should)\s+use)\b/i.test(q.text);
  const asksAction = /\b(?:core|main) (?:action|goal)\b/i.test(q.header) || /\b(?:main|one) (?:thing|action)\b/i.test(q.text);
  return (asksAudience && AUDIENCE_IN_IDEA.test(idea)) || (asksAction && ACTION_IN_IDEA.test(idea));
}

const NAME_LEAD =
  "\\b(?:called|named|name it|call it|brand(?:ed)? as|(?:(?:website|site|business|shop|store|brand|app|company|bakery|restaurant|cafe)(?:'s)?\\s+)?name\\s+(?:of\\s+(?:the|my|our)\\s+\\w+\\s+)?(?:is|will be|should be|would be|shall be))";
const NOT_A_NAME = /^(?:a|an|the|my|our|your|it|this|that|something|anything|one|best|good|great|nice|simple|short|catchy|memorable|unique|cool|fun|later|tbd)$/i;

export function ideaGivesName(idea: string): boolean {
  const own = idea.split(/\s*\bAdditional context:/i)[0] ?? "";
  const personal = (lead: RegExpMatchArray) => {
    const before = own.slice(0, lead.index);
    return (/\b(?:my|his|her|their)(?:\s+(?:first|full|last|real|given))?\s*$/i.test(before) && /^name\s+(?:is|will be|should be|would be|shall be)\b/i.test(lead[0])) || /\b(?:i\s+am|i'm)\s*$/i.test(before);
  };
  for (const quoted of own.matchAll(new RegExp(`(?:${NAME_LEAD})\\s+["\u201c'][^"\u201d'\\n]{2,40}["\u201d']`, "gi"))) {
    if (!personal(quoted)) return true;
  }
  for (const lead of own.matchAll(new RegExp(`(?:${NAME_LEAD})\\s+`, "gi"))) {
    if (personal(lead)) continue;
    const word = /^[A-Za-z0-9][A-Za-z0-9&'-]*/.exec(own.slice(lead.index! + lead[0].length))?.[0] ?? "";
    if (word.length > 0 && !NOT_A_NAME.test(word) && !/^(?:after|for)$/.test(word)) return true;
  }
  const owned = OWNED_NAME_RE.exec(own)?.[1];
  if (!owned || /^\d/.test(owned) || OWNED_NOT_A_BUSINESS.test(owned.split(/\s+/)[0]!)) return false;
  return !(owned.split(/\s+/).length === 1 && NOT_A_NAME.test(owned));
}

const OWNED_NOT_A_BUSINESS =
  /^(?:shopify|airbnb|google|facebook|meta|instagram|uber|amazon|etsy|ebay|youtube|tiktok|linkedin|whatsapp|twitter|pinterest|zomato|swiggy|doordash|grubhub|wix|wordpress|squarespace|webflow|substack|patreon|fiverr|upwork)$/i;

const OWNED_NAME_RE =
  /\b(?:I|we|We)\s+(?:run|own|operate|started|founded|opened|manage)\s+([A-Z0-9][A-Za-z0-9&'\u2019-]*(?:\s+(?:&\s+)?[A-Z0-9][A-Za-z0-9&'\u2019-]*){0,3})(?=\s*(?:[,.;:!?(\u2014\u2013]|\s-\s|$)|\s+(?:in|on|at|from|which|that|where|with|since|here)\b)/;

function withoutIdeaName(q: Question): Question {
  const fromIdea = q.choices.find((c) => c.id === NAME_FROM_IDEA_ID);
  if (!fromIdea) return q;
  const rest = q.choices.filter((c) => c !== fromIdea);
  return { ...q, choices: [...rest, fromIdea].map((c, i) => ({ ...c, recommended: i === 0 })) };
}

function openQuestions(questions: Question[], idea: string): Question[] {
  if (ideaIsDetailed(idea)) return [];
  const named = ideaGivesName(idea);
  return questions
    .filter((q) => !answeredByIdea(q, idea) && !(named && q.id === NAME_QUESTION_ID))
    .map((q) => (q.id === NAME_QUESTION_ID ? withoutIdeaName(q) : q));
}

const DETAILED_IDEA_WORDS = 15;

export function ideaIsDetailed(idea: string): boolean {
  const own = idea.split(/\s*\bAdditional context:/i)[0] ?? "";
  return (own.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}&'-]*/gu) ?? []).length >= DETAILED_IDEA_WORDS;
}

export function ideaAnswersEverything(idea: string): boolean {
  return openQuestions(FALLBACK_QUESTIONS, idea).length === 0;
}

const QUESTIONS_FETCH_TIMEOUT_MS = 7000;

type Answer = { choiceLabel: string | null; other: string };

function emptyAnswersFor(questions: Question[]): Record<string, Answer> {
  return Object.fromEntries(
    questions.map((q) => [q.id, { choiceLabel: null, other: "" }]),
  );
}

function coerceQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = String(rec.id ?? "").trim();
    const header = String(rec.header ?? "").trim();
    const text = String(rec.text ?? "").trim();
    if (!id || !header || !text) continue;
    const why = String(rec.why ?? "").trim();
    const choices: Choice[] = Array.isArray(rec.choices)
      ? (rec.choices as unknown[])
          .map((c): Choice | null => {
            if (!c || typeof c !== "object") return null;
            const cr = c as Record<string, unknown>;
            const cid = String(cr.id ?? "").trim();
            const label = String(cr.label ?? "").trim();
            return cid && label ? { id: cid, label, recommended: cr.recommended === true } : null;
          })
          .filter((c): c is Choice => c !== null)
      : [];
    out.push({ id, header, text, why, choices: recommendedFirst(choices), allowOther: rec.allowOther !== false });
  }
  return withNameFirst(out);
}

function recommendedFirst(choices: Choice[]): Choice[] {
  const at = choices.findIndex((c) => c.recommended);
  if (at < 0) return choices;
  const top = choices[at];
  const rest = choices.filter((_, i) => i !== at).map((c) => (c.recommended ? { ...c, recommended: false } : c));
  return [top, ...rest];
}

function withNameFirst(questions: Question[]): Question[] {
  if (questions.length === 0) return questions;
  const found = questions.find((q) => q.id === NAME_QUESTION_ID);
  const others = questions.filter((q) => q.id !== NAME_QUESTION_ID && !isLogoQuestion(q));
  let name = NAME_QUESTION;
  if (found && found.choices.length > 0) {
    let choices = found.choices.slice(0, MAX_KEY_CHOICES);
    if (!choices.some((c) => c.recommended)) choices = choices.map((c, i) => ({ ...c, recommended: i === 0 }));
    if (choices.length < MAX_KEY_CHOICES && !choices.some((c) => c.id === NAME_SUGGEST_ID)) choices = [...choices, SUGGEST_CHOICE];
    name = { ...NAME_QUESTION, why: found.why || NAME_QUESTION.why, choices };
  }
  return [name, ...others].slice(0, MAX_STEP_QUESTIONS);
}

function isLogoQuestion(q: Question): boolean {
  return /^logo\b/i.test(q.id) || /\blogos?\b/i.test(q.header) || /\blogos?\b/i.test(q.text);
}

function cleanName(raw: string): string {
  return raw
    .replace(/["\u201c\u201d\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

function nameValue(q: Question, a: Answer): string | null {
  const typed = cleanName(a.other);
  const choice = q.choices.find((c) => c.label === a.choiceLabel) ?? null;
  if (choice?.id === NAME_SUGGEST_ID) {
    const hint = typed ? ` Ideas to start from: ${typed}.` : "";
    return `No name yet. Suggest a short, memorable name for the business and use it on the site.${hint}`;
  }
  if (typed) return `The business is called "${typed}".`;
  if (!choice) return null;
  if (choice.id === NAME_FROM_IDEA_ID) return "Use the business name given in the idea above.";
  if (choice.id === NAME_DESCRIPTIVE_ID) return "Use a plain name that says what the business does.";
  const picked = cleanName(choice.label);
  return picked ? `The business is called "${picked}".` : null;
}

function buildAugmentedIdea(
  idea: string,
  questions: Question[],
  answers: Record<string, Answer>,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const a = answers[q.id];
    if (!a) continue;
    if (q.id === NAME_QUESTION_ID) {
      const name = nameValue(q, a);
      if (name) lines.push(`- ${q.header}: ${name}`);
      continue;
    }
    const other = a.other.trim();
    const val =
      a.choiceLabel && other ? `${a.choiceLabel}: ${other}` : other || a.choiceLabel;
    if (val) lines.push(`- ${q.header}: ${val}`);
  }
  if (lines.length === 0) return idea;
  return `${idea}\n\nAdditional context:\n${lines.join("\n")}`;
}

const CARD = "raised-surface mt-3 rounded-[16px] border border-rule bg-cream px-6 pb-6 pt-5 shadow-composer";
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/30 focus-visible:ring-offset-1 focus-visible:ring-offset-cream";
const GHOST_BUTTON = `inline-flex h-9 items-center rounded-full px-3 text-[13px] text-inkMuted transition-colors hover:bg-ink/[0.05] hover:text-ink ${FOCUS_RING}`;
const BACK_BUTTON = `inline-flex h-9 items-center rounded-full px-3.5 text-[13px] text-ink transition-colors hover:bg-ink/[0.05] ${FOCUS_RING}`;
const PRIMARY_BUTTON = `inline-flex h-9 items-center rounded-full bg-ink px-4 text-[13px] font-medium text-cream transition-colors hover:bg-ink/90 ${FOCUS_RING}`;

type Props = {
  idea: string;
  onComplete: (augmentedIdea: string) => void;
  onSkip: () => void;
};

export function BuildClarifyStep({ idea, onComplete, onSkip }: Props) {
  const [questions, setQuestions] = useState<Question[]>(() => openQuestions(FALLBACK_QUESTIONS, idea));
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    emptyAnswersFor(openQuestions(FALLBACK_QUESTIONS, idea)),
  );
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState<boolean>(() => isBuilderClarifyDynamicEnabled() && !ideaAnswersEverything(idea));

  useEffect(() => {
    if (!isBuilderClarifyDynamicEnabled() || ideaAnswersEverything(idea)) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUESTIONS_FETCH_TIMEOUT_MS);

    (async () => {
      try {
        const res = await apiFetch("/api/workspace/autopilot/clarify-questions", {
          method: "POST",
          body: JSON.stringify({ idea }),
          signal: controller.signal,
        });
        if (cancelled || !res.ok) return;
        const payload = (await res.json()) as { questions?: unknown };
        const dyn = openQuestions(coerceQuestions(payload.questions), idea);
        if (cancelled || dyn.length === 0) return;
        setQuestions(dyn);
        setAnswers(emptyAnswersFor(dyn));
        setStep(0);
      } catch {
      } finally {
        clearTimeout(timer);
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const otherRef = useRef<HTMLTextAreaElement>(null);
  const otherId = useId();

  useEffect(() => {
    if (loading) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || target?.isContentEditable) return;
      const idx = Math.min(step, questions.length - 1);
      const cur = questions[idx];
      if (!cur) return;
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key);
        const keyed = cur.choices.slice(0, MAX_DIGIT_KEY);
        if (n <= keyed.length) {
          e.preventDefault();
          const label = keyed[n - 1].label;
          setAnswers((prev) => {
            const was = prev[cur.id] ?? { choiceLabel: null, other: "" };
            return { ...prev, [cur.id]: { ...was, choiceLabel: label } };
          });
        } else if (cur.allowOther && n === keyed.length + 1) {
          e.preventDefault();
          otherRef.current?.focus();
        }
        return;
      }
      if (e.key === "Enter" && tag !== "BUTTON" && tag !== "A") {
        e.preventDefault();
        if (idx === questions.length - 1) onComplete(buildAugmentedIdea(idea, questions, answers));
        else setStep(idx + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, step, questions, answers, idea, onComplete]);

  const nothingToAsk = !loading && questions.length === 0;
  const skippedRef = useRef(false);
  useEffect(() => {
    if (!nothingToAsk || skippedRef.current) return;
    skippedRef.current = true;
    onComplete(idea);
  }, [nothingToAsk, idea, onComplete]);
  if (nothingToAsk) return null;

  if (loading) {
    const bar = "animate-pulse rounded-full bg-ink/[0.06]";
    return (
      <div className={CARD} aria-busy="true">
        <div className="flex items-center gap-3" aria-hidden="true">
          <span className={`h-2.5 w-16 ${bar}`} />
          <div className="flex flex-1 items-center gap-1">
            {[0, 1, 2].map((seg) => (
              <span key={seg} className={`h-1 flex-1 rounded-full ${seg === 0 ? "bg-ink/20" : "bg-ink/10"}`} />
            ))}
          </div>
          <span className={`h-2.5 w-8 ${bar}`} />
        </div>

        <p className="mt-5 flex items-center gap-2 text-[16px] font-semibold text-ink" aria-live="polite">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-inkMuted" aria-hidden />
          Reading your idea…
        </p>
        <p className="mt-1 text-[13px] leading-[1.5] text-inkMuted">
          Tailoring a few questions to your first version. Takes a few seconds.
        </p>

        <div className="mt-5 overflow-hidden rounded-[12px] border border-rule" aria-hidden="true">
          {[62, 48, 54].map((width, row) => (
            <div key={row} className="flex items-center gap-3 border-b border-rule px-3.5 py-3 last:border-b-0">
              <span className="w-4 shrink-0 text-[12px] tabular-nums text-inkLight/60">{row + 1}.</span>
              <span className="flex-1">
                <span
                  className={`block h-3 ${bar}`}
                  style={{ width: `${width}%`, animationDelay: `${row * 150}ms` }}
                />
              </span>
              <span className="h-[18px] w-[18px] shrink-0 rounded-full border border-ink/10" />
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center gap-2">
          <button type="button" onClick={onSkip} className={GHOST_BUTTON}>
            Skip questions
          </button>
          <div className="flex-1" />
          <span className="inline-flex h-9 items-center rounded-full bg-ink/10 px-4 text-[13px] font-medium text-inkLight" aria-hidden="true">
            <span className="inline-flex items-center gap-0.5">Next<NextChevron /></span>
          </span>
        </div>
      </div>
    );
  }

  const total = questions.length;
  const stepIdx = Math.min(step, total - 1);
  const q = questions[stepIdx];
  const a = answers[q.id] ?? { choiceLabel: null, other: "" };
  const isLast = stepIdx === total - 1;

  function pick(label: string) {
    setAnswers((prev) => {
      const cur = prev[q.id] ?? { choiceLabel: null, other: "" };
      return {
        ...prev,
        [q.id]: { ...cur, choiceLabel: cur.choiceLabel === label ? null : label },
      };
    });
  }
  function setOther(text: string) {
    setAnswers((prev) => {
      const cur = prev[q.id] ?? { choiceLabel: null, other: "" };
      return { ...prev, [q.id]: { ...cur, other: text } };
    });
  }
  function next() {
    if (isLast) onComplete(buildAugmentedIdea(idea, questions, answers));
    else setStep(stepIdx + 1);
  }

  return (
    <div className={CARD}>
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-inkMuted">{q.header}</span>
        <div className="flex flex-1 items-center gap-1" aria-hidden="true">
          {questions.map((item, i) => (
            <span
              key={item.id}
              className={`h-1 flex-1 rounded-full transition-colors ${i <= stepIdx ? "bg-ink/70" : "bg-ink/10"}`}
            />
          ))}
        </div>
        <span className="text-[11px] tabular-nums text-inkMuted" aria-live="polite">
          {stepIdx + 1} of {total}
        </span>
      </div>

      <p className="mt-5 text-[16px] font-semibold leading-[1.4] text-ink">{q.text}</p>
      {q.why && <p className="mt-1.5 text-[13px] leading-[1.5] text-inkMuted">{q.why}</p>}

      <div className="mt-5 overflow-hidden rounded-[12px] border border-rule">
        {q.choices.length > 0 && (
          <div role="radiogroup" aria-label={q.text}>
            {q.choices.map((c, i) => {
              const selected = a.choiceLabel === c.label;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => pick(c.label)}
                  className={`flex w-full items-center gap-3 border-b border-rule px-4 py-3 text-left text-[14px] transition-colors last:border-b-0 focus-visible:bg-ink/[0.05] focus-visible:outline-none ${
                    selected ? "bg-ink/[0.06]" : "hover:bg-ink/[0.03]"
                  }`}
                >
                  <span className="w-4 shrink-0 text-[12px] tabular-nums text-inkLight" aria-hidden="true">
                    {i < MAX_DIGIT_KEY ? `${i + 1}.` : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-ink">{c.label}</span>
                    {c.recommended && <span className="ml-2 text-[12px] text-inkMuted">(Recommended)</span>}
                  </span>
                  <span
                    className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors ${
                      selected ? "border-ink bg-ink text-cream" : "border-ink/20"
                    }`}
                    aria-hidden="true"
                  >
                    {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {q.allowOther && (
          <div className={`flex items-start gap-3 px-4 py-3 ${q.choices.length > 0 ? "border-t border-rule" : ""}`}>
            <span className="mt-px w-4 shrink-0 text-[12px] leading-[22px] tabular-nums text-inkLight" aria-hidden="true">
              {q.choices.length < MAX_DIGIT_KEY ? `${q.choices.length + 1}.` : ""}
            </span>
            <label htmlFor={otherId} className="sr-only">
              {q.id === NAME_QUESTION_ID ? "Type a name" : "Other"}
            </label>
            <textarea
              id={otherId}
              ref={otherRef}
              value={a.other}
              maxLength={500}
              onChange={(e) => setOther(e.target.value)}
              placeholder={
                q.id === NAME_QUESTION_ID
                  ? "Type the name you want…"
                  : q.choices.length > 0
                    ? "Something else…"
                    : "Type your answer…"
              }
              rows={q.choices.length > 0 ? 1 : 3}
              className="min-w-0 flex-1 resize-none border-0 bg-transparent p-0 text-[14px] leading-[22px] text-ink outline-none placeholder:text-inkLight [field-sizing:content] max-h-32"
            />
          </div>
        )}
      </div>

      <div className="mt-6 flex items-center gap-2">
        <button type="button" onClick={onSkip} className={GHOST_BUTTON}>
          Skip all
        </button>
        {q.choices.length > 0 && (
          <p className="hidden min-w-0 truncate text-[11px] text-inkLight sm:block">
            Press 1 to {Math.min(q.choices.length + (q.allowOther ? 1 : 0), MAX_DIGIT_KEY)} to choose, Enter to continue
          </p>
        )}
        <div className="flex-1" />
        {stepIdx > 0 && (
          <button type="button" onClick={() => setStep(stepIdx - 1)} className={BACK_BUTTON}>
            Back
          </button>
        )}
        <button type="button" onClick={next} className={PRIMARY_BUTTON}>
          {isLast ? "Continue" : <span className="inline-flex items-center gap-0.5">Next<NextChevron /></span>}
        </button>
      </div>
    </div>
  );
}
