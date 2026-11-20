
import type { RawClarifyInput } from "./clarify-envelope";

type SdkAskUserQuestionInput = {
  questions?: Array<{
    question?: unknown;
    header?: unknown;
    multiSelect?: unknown;
    options?: Array<{ label?: unknown; description?: unknown }>;
  }>;
};

export const ASK_USER_QUESTION_DENY_MESSAGE =
  "Your question has been surfaced to the user as a card with your options — they will answer it as their next message. " +
  "Do NOT call AskUserQuestion again, and do NOT repeat the question in your reply. " +
  "End your turn now with at most one short line of context.";

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_HEADER = 12;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

export function askUserQuestionToClarifyInput(raw: unknown): RawClarifyInput | null {
  const input = (raw ?? {}) as SdkAskUserQuestionInput;
  if (!Array.isArray(input.questions) || input.questions.length === 0) return null;

  const questions = input.questions.slice(0, MAX_QUESTIONS).flatMap((q, qi) => {
    const text = str(q?.question, 400);
    if (!text) return [];
    const options = (Array.isArray(q?.options) ? q.options : [])
      .slice(0, MAX_OPTIONS)
      .flatMap((o, oi) => {
        const label = str(o?.label, 120);
        if (!label) return [];
        const description = str(o?.description, 400);
        return [{ id: `o${qi + 1}_${oi + 1}`, label, ...(description ? { description } : {}) }];
      });
    return [
      {
        id: `q${qi + 1}`,
        text,
        header: str(q?.header, MAX_HEADER) ?? "Question",
        type: options.length === 0 ? "text" : q?.multiSelect === true ? "multi" : "single",
        options,
        allow_other: true,
      },
    ];
  });

  if (questions.length === 0) return null;
  return { questions } as RawClarifyInput;
}
