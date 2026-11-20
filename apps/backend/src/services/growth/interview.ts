
import type { WriteNoteSource } from "@/services/memory";

export function extractCompanyFacts(doc: string | null | undefined): {
  oneLiner: string | null;
  shape: string | null;
} {
  const raw = (doc ?? "").trim();
  if (!raw) return { oneLiner: null, shape: null };

  const firstPara = raw.split(/\n\s*\n/)[0] ?? "";
  const plain = firstPara
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.{20,240}?[.!?])(\s|$)/.exec(plain)?.[1]?.trim() ?? null;
  const oneLiner = sentence && /\s/.test(sentence) && sentence.split(" ").length >= 5
    ? sentence
    : null;

  const lowered = plain.toLowerCase() + " " + raw.slice(0, 1200).toLowerCase();
  const SHAPES: Array<[string, RegExp]> = [
    ["marketplace", /\bmarketplace\b|\btwo-sided\b|\bpeer-to-peer\b|\bp2p\b/],
    ["fintech", /\bfintech\b|\bpayments? (?:company|platform)\b|\bneobank\b|\blending\b/],
    ["ecommerce", /\be-?commerce\b|\bonline store\b|\bd2c\b|\bdirect-to-consumer\b/],
    ["saas", /\bsaas\b|\bsoftware[- ]as[- ]a[- ]service\b|\bsubscription software\b/],
    ["services", /\bagency\b|\bconsultancy\b|\bservices business\b/],
  ];
  let shape: string | null = null;
  for (const [name, re] of SHAPES) {
    if (re.test(lowered)) {
      shape = name;
      break;
    }
  }
  return { oneLiner, shape };
}

export type KnownContext = {
  shape?: string | null;
  stage?: number | null;
  oneLiner?: string | null;
  gtmMotion?: string | null;
};

export type SlotKey = "metric" | "constraint" | "channels";

export type InterviewSlot = {
  key: SlotKey;
  question: string;
  why: string;
  options: readonly string[];
};

export type SlotState = InterviewSlot & {
  answer: string | null;
  inferred: boolean;
  settled: boolean;
};

const METRIC_OPTIONS = [
  "More people finding us",
  "More of them actually buying",
  "Customers worth more",
  "Customers staying longer",
  "More sellers or suppliers on our side",
] as const;

const CONSTRAINT_OPTIONS = [
  "They never hear about us",
  "They look, but don't buy",
  "They sign up, then never get going",
  "They buy once and don't come back",
  "We can't keep up with the demand we have",
  "Honestly, I'm not sure",
] as const;

const CHANNEL_OPTIONS = [
  "Someone I already knew",
  "I reached out to them myself",
  "Word of mouth from a customer",
  "They searched and found us",
  "We paid for ads",
  "Saw us on social",
  "Nothing repeatable yet",
] as const;

export const CUSTOMERS_QUESTION = "Roughly how many new customers did you get last month?";
export const CUSTOMERS_OPTIONS = ["0", "1-5", "6-20", "21-100", "100+", "Not sure"] as const;

export function slotsFor(_ctx: KnownContext): InterviewSlot[] {
  return [
    {
      key: "metric",
      question: "If one thing got better over the next 3 months, what should it be?",
      why: "Everything I do gets judged on whether it moved this.",
      options: [...METRIC_OPTIONS],
    },
    {
      key: "constraint",
      question: "Where do you lose people?",
      why: "This is the one thing I'll try hardest to fix.",
      options: [...CONSTRAINT_OPTIONS],
    },
    {
      key: "channels",
      question: "Think about the last handful of customers. How did they find you?",
      why: "Whatever already worked is usually what's worth doing more of.",
      options: [...CHANNEL_OPTIONS],
    },
  ];
}

export function isUsableGtmMotion(gtmMotion: string | null | undefined): boolean {
  if (typeof gtmMotion !== "string") return false;
  const s = gtmMotion.trim();
  if (s.length === 0) return false;
  return !/not specified|operator to confirm|unknown|unclear|n\/a/i.test(s);
}

export function buildInterview(
  ctx: KnownContext,
  answers: Partial<Record<SlotKey, string>> = {},
): { slots: SlotState[]; next: SlotState | null; complete: boolean } {
  const slots: SlotState[] = slotsFor(ctx).map((slot) => {
    const given = answers[slot.key]?.trim();
    if (given) {
      return { ...slot, answer: given, inferred: false, settled: true };
    }
    if (slot.key === "channels" && isUsableGtmMotion(ctx.gtmMotion)) {
      return { ...slot, answer: ctx.gtmMotion!.trim(), inferred: true, settled: false };
    }
    return { ...slot, answer: null, inferred: false, settled: false };
  });

  const next =
    slots.find((s) => s.inferred && !s.settled) ?? slots.find((s) => !s.settled) ?? null;

  return { slots, next, complete: next === null };
}

export function playback(ctx: KnownContext, orgName?: string | null): string | null {
  const oneLiner = (ctx.oneLiner ?? "").trim();
  if (!oneLiner) return null;

  const extras: string[] = [];
  const stageLine = stageLabel(ctx.stage);
  if (stageLine) extras.push(stageLine);
  if (isUsableGtmMotion(ctx.gtmMotion)) {
    extras.push(`customers mostly come from ${ctx.gtmMotion!.trim()}`);
  }

  const head = `Here's what I have: ${oneLiner.replace(/\.$/, "")}.`;
  return extras.length > 0 ? `${head} You're ${extras.join(", ")}.` : head;
}

function stageLabel(stage: number | null | undefined): string | null {
  if (typeof stage !== "number") return null;
  if (stage <= 0) return "pre-launch";
  if (stage === 1) return "just launched";
  if (stage <= 3) return "early but live";
  if (stage <= 5) return "scaling";
  return "operating at scale";
}

export function interviewPairs(
  metadata: Record<string, unknown>,
): Array<{ question: string; answer: string }> {
  const stored = (metadata.interview ?? {}) as {
    answers?: Partial<Record<SlotKey | "customers", string>>;
  };
  const answers = stored.answers ?? {};
  if (Object.keys(answers).length === 0) return [];
  const { slots } = buildInterview({}, answers);
  const pairs = slots
    .filter((s) => s.answer !== null && s.answer.trim().length > 0)
    .map((s) => ({ question: s.question, answer: s.answer as string }));
  const customers = answers.customers?.trim();
  return customers ? [...pairs, { question: CUSTOMERS_QUESTION, answer: customers }] : pairs;
}

export type StrategyNote = {
  id: string | null;
  metadata: Record<string, unknown>;
  title?: string;
  body_markdown?: string;
  source?: string;
  source_ref?: string | null;
  tags?: string[];
};

export function interviewNoteFields(note: StrategyNote, placeholder: string, currentTag: string) {
  if (note.metadata.strategy != null && note.id) {
    return {
      title: note.title ?? "Growth strategy",
      body_markdown: note.body_markdown ?? "",
      source: (note.source ?? "human") as WriteNoteSource,
      ...(note.source_ref ? { source_ref: note.source_ref } : {}),
      tags: note.tags ?? [currentTag],
    };
  }
  return { title: "Growth strategy — in progress", body_markdown: placeholder, source: "human" as const, tags: [currentTag] };
}
