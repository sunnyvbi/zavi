import { getAnthropic } from "@/services/anthropic";
import { MODELS } from "@/services/llm/models";
import { xmlEscapeContent } from "@/services/onboarding/enrichment/sanitize";
import type { PrefillFields } from "./prefill";

export type ChatStep = "site" | "confirm" | "audience" | "extras" | "material" | "ready";

export type Grammar = "dense" | "calm";

export interface ChatDraft {
  site_url: string;
  email: string;
  brief: string;
  grammar: Grammar | null;
  pending: string;
  skipped: string[];
  missing: string[];
  prefill: PrefillFields | null;
}

export interface ChatTurn {
  step: ChatStep;
  message: string;
  options: Array<{ label: string; value: string }>;
  allowFreeText: boolean;
  draft: ChatDraft;
}

export const EMPTY_DRAFT: ChatDraft = {
  site_url: "",
  email: "",
  brief: "",
  grammar: null,
  pending: "",
  skipped: [],
  missing: [],
  prefill: null,
};

type Completer = (system: string, user: string) => Promise<string>;

const SUMMARY_SYSTEM = [
  "You are Zavi, reading a stranger's website back to them in your own words before making",
  "their launch video. Two sentences, maximum forty words.",
  "",
  "Say what the product IS and what a person DOES with it, in the register the site itself",
  "uses. A bike shop gets bike words. A payments API gets developer words. Never translate a",
  "concrete thing into a business abstraction: 'you ride out on your own bike' beats",
  "'improving the customer fitting experience'.",
  "",
  "Use ONLY what the read of their site supports. Invent no number, customer, award or claim.",
  "If the read is thin, say what little it supports and stop. Do not pad.",
  "",
  "End with nothing. No question, no offer to help, no sign-off. The interface asks the",
  "question; you are only the description.",
  "No em dashes.",
].join("\n");

const MERGE_SYSTEM = [
  "You are Zavi, folding a founder's correction into the brief for their launch video.",
  "",
  "You are given what we understood from their site, and what they just told us. Produce ONE",
  "paragraph, under 120 words, describing what the film should show.",
  "",
  "THEIR WORDS WIN. Where the correction contradicts the site read, the correction is right",
  "and the site read is dropped, not balanced against. They are looking at their own product.",
  "",
  "Keep their register. If they describe school emails and a supply list, the brief says school",
  "emails and a supply list; do not lift it into 'household task automation'. Keep concrete",
  "nouns, prices, place names and times exactly as written.",
  "",
  "Invent nothing. No number, customer, award or claim that is not in one of the two inputs.",
  "Write the brief only. No preamble, no commentary. No em dashes.",
].join("\n");

async function defaultComplete(system: string, user: string): Promise<string> {
  const anthropic = getAnthropic();
  const r = await anthropic.messages.create({
    model: MODELS.anthropic.haiku,
    max_tokens: 400,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = r.content[0];
  return block && block.type === "text" ? block.text.trim() : "";
}

export async function describeSite(
  fields: PrefillFields,
  deps: { complete?: Completer } = {},
): Promise<string> {
  const complete = deps.complete ?? defaultComplete;
  const read = [
    `<name>${xmlEscapeContent(fields.product_name)}</name>`,
    `<one_liner>${xmlEscapeContent(fields.one_liner)}</one_liner>`,
    `<audience>${xmlEscapeContent(fields.audience)}</audience>`,
    `<what_it_does>${xmlEscapeContent(fields.features)}</what_it_does>`,
    `<problem>${xmlEscapeContent(fields.problem)}</problem>`,
    `<using_it>${xmlEscapeContent(fields.screen)}</using_it>`,
  ].join("\n");
  try {
    const out = await complete(SUMMARY_SYSTEM, read);
    if (out) return out;
  } catch {
  }
  return fields.one_liner || fields.product_name || "";
}

export async function mergeIntoBrief(
  siteRead: string,
  fromVisitor: string,
  deps: { complete?: Completer } = {},
): Promise<string> {
  const complete = deps.complete ?? defaultComplete;
  const user = [
    `<from_their_site>${xmlEscapeContent(siteRead)}</from_their_site>`,
    `<what_they_told_us>${xmlEscapeContent(fromVisitor)}</what_they_told_us>`,
  ].join("\n");
  try {
    const out = await complete(MERGE_SYSTEM, user);
    if (out) return out;
  } catch {
  }
  return [siteRead, fromVisitor].filter(Boolean).join("\n\n");
}

const NAME_SYSTEM = [
  "A founder has described what they are launching. Extract two things and nothing else.",
  "",
  "Line 1: NAME: the product or company name, as they wrote it. Under 60 characters.",
  "Line 2: ONE_LINER: one sentence saying what it is and what a person does with it, in",
  "THEIR words and their register. Under 140 characters.",
  "",
  "Take both from what they wrote. Invent no name, no claim, no number. If they never name",
  "the thing, use the most specific noun phrase they used for it.",
  "Output exactly those two lines. No preamble, no em dashes.",
].join("\n");

const EMPTY_FIELDS: PrefillFields = {
  product_name: "",
  one_liner: "",
  features: "",
  audience: "",
  cta_text: "",
  problem: "",
  metrics: "",
  regions: "",
  screen: "",
};

export async function fieldsFromWords(
  words: string,
  deps: { complete?: Completer } = {},
): Promise<PrefillFields> {
  const complete = deps.complete ?? defaultComplete;
  const firstSentence = (words.split(/(?<=[.!?])\s/)[0] ?? words).trim().slice(0, 140);
  let name = "";
  let oneLiner = "";
  try {
    const out = await complete(NAME_SYSTEM, xmlEscapeContent(words));
    for (const line of out.split("\n")) {
      const n = /^\s*NAME:\s*(.+)$/i.exec(line);
      const o = /^\s*ONE_LINER:\s*(.+)$/i.exec(line);
      if (n) name = n[1].trim().slice(0, 60);
      if (o) oneLiner = o[1].trim().slice(0, 140);
    }
  } catch {
  }
  return {
    ...EMPTY_FIELDS,
    product_name: name || firstSentence.split(/[,.:]/)[0].trim().slice(0, 60) || "Our product",
    one_liner: oneLiner || firstSentence || words.slice(0, 140),
    cta_text: "Get started",
  };
}

export function tidyFields(fields: PrefillFields): PrefillFields {
  const metricLines = fields.metrics
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const cut = line.indexOf("|");
      if (cut === -1) return false;
      return line.slice(0, cut).trim().length <= 160 && line.slice(cut + 1).trim().length <= 40;
    })
    .slice(0, 3);
  while (metricLines.length > 0 && metricLines.join("\n").length > 200) metricLines.pop();
  const metrics = metricLines.join("\n");
  const regions = fields.regions
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && r.length <= 40)
    .slice(0, 8);
  return {
    ...fields,
    metrics,
    regions: regions.length >= 2 ? regions.join(", ") : "",
    one_liner: fields.one_liner.slice(0, 200),
    audience: fields.audience.slice(0, 160),
    problem: fields.problem.slice(0, 240),
    screen: fields.screen.slice(0, 600),
    features: fields.features.slice(0, 2000),
  };
}

export const MATERIAL_QUESTIONS: Record<string, { field: keyof PrefillFields; ask: string }> = {
  problem: {
    field: "problem",
    ask: "One more thing and it will be long enough. What is broken today, before someone finds you?",
  },
  product_surface: {
    field: "screen",
    ask: "What does someone actually DO with it? One sentence, the thing they do most.",
  },
  metrics: {
    field: "metrics",
    ask: "Any real number you can stand behind? Write it as Label|Value, like Customers|1,200. Nothing made up.",
  },
  coverage: {
    field: "regions",
    ask: "Where do you operate? Two or more places, separated by commas.",
  },
  features: {
    field: "features",
    ask: "What else should it show off? One per line.",
  },
};

export function applyMaterial(fields: PrefillFields, key: string, answer: string): PrefillFields {
  const q = MATERIAL_QUESTIONS[key];
  if (!q) return fields;
  const value = answer.trim();
  if (!value) return fields;
  const merged =
    q.field === "metrics" || q.field === "features"
      ? [fields[q.field], value].filter(Boolean).join("\n")
      : value;
  return tidyFields({ ...fields, [q.field]: merged });
}

export const AUDIENCE_OPTIONS: Array<{ label: string; value: Grammar; hint: string }> = [
  {
    label: "People who'd buy it",
    value: "calm",
    hint: "customers, non-technical, deciding if they want this",
  },
  {
    label: "People who'd build with it",
    value: "dense",
    hint: "operators, engineers, evaluating how it works",
  },
];
