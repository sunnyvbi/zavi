import { MODELS } from "@/services/llm/models";
import { getAnthropic, heliconePropertyHeaders } from "@/services/anthropic";

const RESOLVE_MODEL = "claude-haiku-4-5-20251001";
const RESOLVE_TIMEOUT_MS = 8000;
const RUNS_MODEL = MODELS.anthropic.sonnet;
const RUNS_TIMEOUT_MS = 15000;

export type InlineEditContext = {
  tag: string;
  text: string;
  segments?: string[];
  style: Record<string, string>;
  attrs?: Record<string, string>;
  message: string;
  companyContext?: string;
};

export type OutlineEl = { selector: string; tag: string; text: string };

const SYSTEM = [
  "You edit exactly ONE existing DOM element on a website.",
  "You are given the element's tag, its current text, its current inline styles, and its current link/image attributes, plus a plain-English instruction from the site owner.",
  "Output ONLY a JSON object (no prose, no markdown fence) with any of these optional keys:",
  '  "text": string — the new visible text (plain text only).',
  '  "segments": string[] — only for an element given current_segments, see below.',
  '  "style": object — any subset of {color, backgroundColor, fontSize, fontFamily, fontWeight, fontStyle, textDecoration, textAlign}. CSS values only (e.g. "#0a2540", "1.25rem", "bold").',
  '  "attrs": object — any subset of {href, src}. href for a link, src for an image (https URL only).',
  "Rules:",
  "- Change ONLY what the instruction asks. Omit keys you are not changing.",
  "- A general ask to improve, polish, refine, tighten, strengthen, make better, or make it more X (with no specific change named) IS a text instruction when current_text is non-empty: rewrite the text so it is clearer and stronger, keep the same meaning and roughly the same length. Praise or commentary attached to such an ask does not cancel it.",
  "- The owner asked because they want different words. For such an ask, write a noticeably better version (sharper verbs, more concrete, better rhythm). Returning the current words unchanged is a failure, even when the current copy is already good.",
  "- Polishing changes wording, never facts. Every claim in the rewrite must already be in the current text: do not swap one claim for another (\"no queue\" must not become \"no fees\"), and do not add or drop information. Keep proper nouns, product and brand names, prices, numbers and dates exactly as written.",
  '- When "current_segments" is given, the element holds several runs of text in page order: a heading with a differently styled line, or a container such as a card or section holding its own headings, paragraphs, labels and buttons. Return text changes as "segments": an array with EXACTLY as many strings as current_segments, each replacing the run at the same index, keeping each run\'s leading and trailing spaces. Never return "text" for such an element.',
  "- For a general ask on a container, polish the headings and sentences. Copy short labels, badges, prices and button text through unchanged unless the instruction names them.",
  '- Otherwise return text changes as "text".',
  "- NEVER invent a selector or reference another element. You only patch THIS element.",
  '- If given "brand_context" about the site\'s product/company, use it so a text edit fits the brand (e.g. a fitting name). Never invent facts not in brand_context.',
  "- If the instruction cannot be satisfied by text/style/attrs on this element, return {}.",
  "- Output must be a single valid JSON object and nothing else.",
].join("\n");

export function extractJsonObject(text: string): unknown {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : t).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no json object in output");
  return JSON.parse(body.slice(start, end + 1));
}

const STYLE_WORDS =
  /\b(bold|italic|underline|colou?r|background|font|typeface|size|bigger|smaller|larger|align|alignment|cent(er|re)d?|left|right|red|blue|green|black|white|grey|gray|navy|dark|light)\b/i;
const TEXT_WORDS =
  /\b(polish|improve|better|rewrite|reword|rephrase|wording|copy|words?|shorter|longer|shorten|punch(y|ier)?|tone|tighten|clearer|clarify|say|says|read|typo|spelling|grammar|translate|headline|tagline|sentence|write|refine|strengthen|compelling|friendlier|warmer|formal|casual)\b/i;

export function isStyleOnlyAsk(message: string): boolean {
  return STYLE_WORDS.test(message) && !TEXT_WORDS.test(message);
}

export async function resolveInlineEdit(
  ctx: InlineEditContext,
  tags: { tenantId?: string | null; agentSlug?: string | null; runId?: string | null } = {},
): Promise<unknown> {
  const client = getAnthropic();
  const userContent = JSON.stringify({
    tag: ctx.tag,
    current_text: ctx.text.slice(0, 2000),
    ...(ctx.segments ? { current_segments: ctx.segments } : {}),
    current_style: ctx.style,
    current_attrs: ctx.attrs ?? {},
    ...(ctx.companyContext ? { brand_context: ctx.companyContext.slice(0, 1500) } : {}),
    instruction: ctx.message.slice(0, 500),
  });
  const runs = !!ctx.segments && !isStyleOnlyAsk(ctx.message);
  const timeoutMs = runs ? RUNS_TIMEOUT_MS : RESOLVE_TIMEOUT_MS;
  const res = await withAbortTimeout("resolveInlineEdit", timeoutMs, (signal) =>
    client.messages.create(
      {
        model: runs ? RUNS_MODEL : RESOLVE_MODEL,
        max_tokens: runs ? 3000 : ctx.segments ? 1500 : 400,
        ...(runs ? {} : { temperature: 0 }),
        system: SYSTEM,
        messages: [{ role: "user", content: userContent }],
      },
      { headers: heliconePropertyHeaders({ ...tags, agentSlug: tags.agentSlug ?? "website-inline-edit" }), signal },
    ),
  );
  const out = res.content.map((b) => (b.type === "text" ? b.text : "")).join(" ");
  return extractJsonObject(out);
}

export async function withAbortTimeout<T>(label: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const OUTLINE_SYSTEM = [
  "You edit ONE element on a web page.",
  "You are given a list of the page's editable elements — each with a `selector`, a `tag`, and its current `text` — plus a plain-English instruction from the site owner.",
  "Pick the ONE element the instruction refers to, and produce the change for it.",
  'Output ONLY a JSON object (no prose, no fence): { "selector": <one of the given selectors, copied EXACTLY>, "patch": { ...optional text/style/attrs... } }.',
  'patch keys: "text" (new plain text); "style" (subset of {color, backgroundColor, fontSize, fontFamily, fontWeight, fontStyle, textDecoration, textAlign}, CSS values only); "attrs" (subset of {href, src}).',
  "Rules:",
  "- The selector MUST be copied verbatim from the list — never invent or modify one.",
  "- Change ONLY what the instruction asks; omit patch keys you are not changing.",
  "- A general ask to improve, polish, strengthen, tidy, clean up, make better, or make it more X (with no specific change named) IS a text instruction: pick the element whose text most carries the page's message, rewrite that text so it is clearer and stronger, keep the same meaning and roughly the same length, and return it as \"text\". Praise or commentary attached to such an ask does not cancel it.",
  '- If given "brand_context" about the product/company, use it so the edit fits the brand (e.g. a fitting name). Never invent facts not in brand_context.',
  "- If no element matches, or the change needs more than text/style/link/image, return {}.",
  "- Output must be a single valid JSON object and nothing else.",
].join("\n");

export async function resolveChatEditFromOutline(
  outline: OutlineEl[],
  message: string,
  opts: { companyContext?: string } = {},
  tags: { tenantId?: string | null; agentSlug?: string | null; runId?: string | null } = {},
): Promise<unknown> {
  const client = getAnthropic();
  const userContent = JSON.stringify({
    elements: outline
      .slice(0, 150)
      .map((e) => ({ selector: e.selector, tag: e.tag, text: e.text.slice(0, 160) })),
    ...(opts.companyContext ? { brand_context: opts.companyContext.slice(0, 1500) } : {}),
    instruction: message.slice(0, 500),
  });
  const res = await withAbortTimeout("resolveChatEditFromOutline", RESOLVE_TIMEOUT_MS, (signal) =>
    client.messages.create(
      {
        model: RESOLVE_MODEL,
        max_tokens: 500,
        temperature: 0,
        system: OUTLINE_SYSTEM,
        messages: [{ role: "user", content: userContent }],
      },
      { headers: heliconePropertyHeaders({ ...tags, agentSlug: tags.agentSlug ?? "website-chat-edit" }), signal },
    ),
  );
  const out = res.content.map((b) => (b.type === "text" ? b.text : "")).join(" ");
  return extractJsonObject(out);
}
