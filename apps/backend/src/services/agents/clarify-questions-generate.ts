
import { callModel } from "@/services/llm/call-model";
import { MODELS, DEFAULT_PROVIDER } from "@/services/llm/models";
import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";
import { renderUntrustedBlock } from "./prompt-injection";
import { explicitName } from "@/services/sites/label";

export type ClarifyChoice = { id: string; label: string; recommended: boolean };
export type ClarifyQuestion = {
  id: string;
  header: string;
  text: string;
  why: string;
  choices: ClarifyChoice[];
  allowOther: boolean;
};

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_QUESTIONS = 4;
const MAX_CHOICES = 4;
export const NAME_QUESTION_ID = "name";
export const NAME_QUESTION_TEXT = "What do you have in mind for the name?";

function isNameQuestion(rec: Record<string, unknown>, header: string): boolean {
  return String(rec.id ?? "").trim().toLowerCase() === NAME_QUESTION_ID || /\bname\b/i.test(header);
}

function isLogoQuestion(rec: Record<string, unknown>, header: string, text: string): boolean {
  return /^logo\b/i.test(String(rec.id ?? "").trim()) || /\blogos?\b/i.test(header) || /\blogos?\b/i.test(text);
}

const STYLE_WORDS =
  /\b(?:(?:design|visual|site|website|app|page|brand) style|style (?:of|for) (?:the|your) (?:site|website|app|page)|look and feel|look & feel|colou?r (?:scheme|palette)|colou?rs? (?:for|of) (?:the|your) (?:site|website|app|page)|palette|fonts?|typography|themes?|vibe|aesthetics?)\b/i;

function isStyleQuestion(rec: Record<string, unknown>, header: string, text: string): boolean {
  return /^(?:style|look|theme|colou?r|font|vibe|design)\b/i.test(String(rec.id ?? "").trim()) || STYLE_WORDS.test(header) || STYLE_WORDS.test(text);
}

type CacheEntry = { questions: ClarifyQuestion[]; ts: number };
const cache = new Map<string, CacheEntry>();

function hashIdea(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function slugId(label: string, idx: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base ? `${base}-${idx}` : `q-${idx}`;
}

export function parseClarifyJson(text: string): ClarifyQuestion[] {
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: ClarifyQuestion[] = [];
  let named: ClarifyQuestion | null = null;
  for (let i = 0; i < arr.length && out.length + (named ? 1 : 0) < MAX_QUESTIONS; i++) {
    const item = arr[i];
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const header = String(rec.header ?? "").trim().slice(0, 24);
    const questionText = String(rec.text ?? rec.question ?? "").trim().slice(0, 200);
    if (!header || !questionText) continue;
    const why = String(rec.why ?? "").trim().slice(0, 160);
    const isName = !named && isNameQuestion(rec, header);
    if (!isName && (isLogoQuestion(rec, header, questionText) || isStyleQuestion(rec, header, questionText))) continue;

    const choices: ClarifyChoice[] = [];
    const rawChoices = rec.choices;
    if (Array.isArray(rawChoices)) {
      for (const c of rawChoices) {
        if (choices.length >= MAX_CHOICES) break;
        const label = decodeXmlEntities(
          typeof c === "string"
            ? c
            : c && typeof c === "object"
              ? String((c as { label?: unknown }).label ?? "")
              : "",
        ).trim();
        if (!label || label.length > 40) continue;
        const recommended =
          !choices.some((x) => x.recommended) &&
          !!c &&
          typeof c === "object" &&
          (c as { recommended?: unknown }).recommended === true;
        choices.push({ id: slugId(label, choices.length), label, recommended });
      }
    }

    if (isName) {
      if (choices.length > 0 && !choices.some((x) => x.recommended)) choices[0].recommended = true;
      named = {
        id: NAME_QUESTION_ID,
        header: "Name",
        text: NAME_QUESTION_TEXT,
        why,
        choices,
        allowOther: true,
      };
      continue;
    }

    out.push({
      id: slugId(header, out.length),
      header,
      text: questionText,
      why,
      choices,
      allowOther: true,
    });
  }
  return named ? [named, ...out] : out;
}

const NAME_SEARCH_TIMEOUT_MS = 3_000;
const MAX_REAL_NAMES = 8;

export type NameSearch = (query: string) => Promise<string[]>;

const tavilyTitles: NameSearch = async (query) => {
  const { callWebSearchTool } = await import("@/services/mcp/internal/web-search");
  const r = await callWebSearchTool("", "search", { query, max_results: 8, search_depth: "basic", include_answer: false });
  if (!r.ok || r.is_error) return [];
  const json = JSON.parse(r.content) as { results?: Array<{ title?: unknown }> };
  return (json.results ?? []).map((x) => (typeof x.title === "string" ? x.title : "")).filter(Boolean);
};

export function nameSearchQuery(idea: string): string {
  const line = decodeXmlEntities(idea).split(/\n/)[0]!.replace(/\s+/g, " ").trim().slice(0, 140);
  return `${line} business names`;
}

export function businessNameFromTitle(title: string): string | null {
  const name = decodeXmlEntities(title).split(/\s[|\-–—:·]\s|\s\(/)[0]!.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 40) return null;
  if (/\b(?:best|top|\d+|near me|reviews?|list|ideas?|names?|how|what|guide)\b/i.test(name)) return null;
  return name;
}

export async function realBusinessNames(idea: string, search: NameSearch = tavilyTitles): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const titles = await Promise.race([
      search(nameSearchQuery(idea)),
      new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), NAME_SEARCH_TIMEOUT_MS);
      }),
    ]);
    const out: string[] = [];
    for (const t of titles) {
      const name = businessNameFromTitle(t);
      if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
      if (out.length >= MAX_REAL_NAMES) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const STOCK_WORDS = "Hub|Flex|Smart|Easy|Quick|Insta|Mobile|Rent|Rents|Rental|Rentals|Share|Zone|Spot|Mart|Direct|Ify";
const STOCK_WORD_RE = new RegExp(`^(?:${STOCK_WORDS}|My)$`, "i");
const STOCK_PART_RE = new RegExp(`^(?:${STOCK_WORDS}|My)(?=[A-Z])|(?<=[a-z])(?:${STOCK_WORDS})$`);

export function isGenericName(name: string): boolean {
  return name.split(/\s+/).some((word) => {
    const w = word.replace(/[^A-Za-z]/g, "");
    return STOCK_WORD_RE.test(w) || STOCK_PART_RE.test(w);
  });
}

export function namedInIdea(name: string, idea: string): boolean {
  const label = decodeXmlEntities(name).trim();
  if (label.replace(/[^A-Za-z0-9]/g, "").length < 3 || !/^[A-Z0-9]/.test(label)) return false;
  const text = decodeXmlEntities(idea);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, "g");
  for (const m of text.matchAll(re)) {
    const at = (m.index ?? 0) + m[1].length;
    const before = text.slice(0, at).trimEnd();
    if (before.length > 0 && !/[.!?:\n]$/.test(before)) return true;
    if (/["'“‘]$/.test(text.slice(0, at))) return true;
    const isMultiWord = label.split(/\s+/).filter(Boolean).length >= 2;
    if (isMultiWord && /^\s*(?:[:,|(—–]|-\s|is\s)/.test(text.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

function copiesIdea(name: string, idea: string): boolean {
  const ideaWords = new Set(decodeXmlEntities(idea).toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const nameWords = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return nameWords.length > 0 && nameWords.every((w) => ideaWords.has(w));
}

export function distinctiveNameChoices(question: ClarifyQuestion, idea: string, realNames: readonly string[]): ClarifyQuestion {
  const taken = new Set(realNames.map((n) => n.toLowerCase()));
  const given = question.choices.filter((c) => namedInIdea(c.label, idea));
  const kept = question.choices.filter(
    (c) =>
      given.includes(c) ||
      (!isGenericName(c.label) && !taken.has(c.label.toLowerCase()) && !copiesIdea(c.label, idea)),
  );
  if (kept.length === 0) return question;
  const ordered = [...given, ...kept.filter((c) => !given.includes(c))];
  const choices = ordered.map((c, i) => ({ ...c, recommended: given.length > 0 ? i === 0 : c.recommended }));
  if (!choices.some((c) => c.recommended)) choices[0] = { ...choices[0]!, recommended: true };
  const unchanged = choices.length === question.choices.length && choices.every((c, i) => c === question.choices[i]);
  return unchanged ? question : { ...question, choices };
}

const AUDIENCE_IN_IDEA =
  /\b(?:anybody|anyone|everybody|everyone|customers?|clients?|consumers?|businesses|companies|teams?|parents|kids|students|families|locals|tourists|visitors|users|people|members|patients|guests|shoppers|buyers|owners|renters|drivers|travell?ers|professionals|freelancers|founders|b2b|b2c)\b/i;
const ACTION_IN_IDEA =
  /\b(?:order|buy|book|reserve|rent|purchase|browse|subscribe|sign up|signup|donate|apply|hire|schedule|pay|track|find|search|compare|enrol|enroll|join|request|sell|swipe|chat|message|upload|vote|learn|listen|download|contact|visit)(?:s|es|ed|ing)?\b/i;

function asksAudience(q: ClarifyQuestion): boolean {
  return /\baudience\b/i.test(q.header) || /^who\s+(?:(?:is|are)\s+(?:this(?:\s+(?:app|site|website|product))?|it|the\s+(?:app|site|website|product))\s+for|(?:are|will be)\s+(?:the|your|our)\s+(?:target\s+)?(?:users?|customers?|audience)|(?:will|should)\s+use)\b/i.test(q.text);
}

function asksCoreAction(q: ClarifyQuestion): boolean {
  return /\b(?:core|main) (?:action|goal)\b/i.test(q.header) || /\b(?:main|one) (?:thing|action)\b/i.test(q.text);
}

export function answeredByIdea(q: ClarifyQuestion, idea: string): boolean {
  const text = decodeXmlEntities(idea);
  if (q.id === NAME_QUESTION_ID) return explicitName(text) !== null;
  return (asksAudience(q) && AUDIENCE_IN_IDEA.test(text)) || (asksCoreAction(q) && ACTION_IN_IDEA.test(text));
}

export async function generateClarifyQuestions(
  args: {
    tenantId: string;
    idea: string;
  },
  deps: { search?: NameSearch } = {},
): Promise<ClarifyQuestion[]> {
  const idea = (args.idea ?? "").trim();
  if (idea.length < 8) return [];

  const cacheKey = `${args.tenantId}:${hashIdea(idea)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.questions;

  try {
    const realNames = await realBusinessNames(idea, deps.search);
    const system =
      "You help scope a web app before an AI team builds the first version. " +
      "Given the operator's idea, return ONLY a JSON array of 1 to 3 items. " +
      "Item 1 is ALWAYS the name question: {\"id\": \"name\", \"header\": \"Name\", " +
      `"text": "${NAME_QUESTION_TEXT}", "why": string, ` +
      "\"choices\": [{\"label\": string, \"recommended\": boolean}] (EXACTLY 4 short business names, 1-3 words each, " +
      "the kind a real owner in this trade and place would pick (the place, the craft, a person's name, an evocative word), " +
      "never a stock compound (-Hub, -ly, -ify, Flex-, Smart-, -Rent, -Share, -Go) and never one of the real businesses listed with the idea; " +
      "if the idea already names the business, that exact name is the first choice; " +
      "the first choice has \"recommended\": true, the others false)}. " +
      "Items 2-3 are optional short scoping questions about decisions the idea leaves open (never about the name, a logo, or the look: style, colours, fonts or theme are picked by Zavi, " +
      "and never something the idea already says, such as who it is for or what visitors do there; if nothing important is open, return only the name question): {\"header\": string (1-2 words, e.g. \"Audience\"), \"text\": string (the question), " +
      "\"why\": string (one short clause on why it matters), \"choices\": [{\"label\": string, \"recommended\": boolean}] " +
      "(2-4 likely answers, best fit first and recommended, or [] for a free-text question)}. " +
      "Make the questions SPECIFIC to this idea (not generic) and answerable in one tap. " +
      "No commentary, no code fences, just the JSON array.";
    const real = realNames.length
      ? `\n\nReal businesses in this space (do not reuse these names or their pattern):\n${renderUntrustedBlock("business_names", realNames.join("\n"))}`
      : "";
    const user = `App idea:\n${idea}${real}\n\nReturn the JSON array (the name question, then up to 2 scoping questions the idea does not already answer) now.`;
    const resp = await callModel({
      provider: DEFAULT_PROVIDER,
      model: MODELS.anthropic.haiku,
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: user }],
    });
    const questions = parseClarifyJson(resp.text ?? "")
      .filter((q) => !answeredByIdea(q, idea))
      .map((q) => (q.id === NAME_QUESTION_ID ? distinctiveNameChoices(q, idea, realNames) : q));
    if (questions.length > 0) {
      cache.set(cacheKey, { questions, ts: Date.now() });
      return questions;
    }
  } catch {
  }
  return [];
}
