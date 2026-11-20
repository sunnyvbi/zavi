
import {
  parseHtmlPreviewEnvelope,
  type ParsedHtmlPreview,
} from "./output-schema";

export const PREVIEW_APPROVE_MARKER =
  "Approve to build it, or tell me what to change.";

export const PREVIEW_INERT_MARKER =
  "Static mock of one screen — the buttons and links inside it are inert.";

const STRONG_DESIGN_TERMS: readonly string[] = [
  "redesign",
  "restyle",
  "re-style",
  "recolor",
  "re-color",
  "layout",
  "spacing",
  "padding",
  "margin",
  "font",
  "typography",
  "theme",
  "styling",
  "look and feel",
  "mockup",
  "mock up",
  "wireframe",
  "hero",
  "navbar",
  "design",
  "ui",
  "ux",
];

const WEAK_SURFACE_TERMS: readonly string[] = [
  "page",
  "screen",
  "button",
  "cta",
  "card",
  "copy",
  "wording",
  "headline",
  "banner",
  "header",
  "footer",
  "modal",
  "color",
  "colour",
  "style",
  "link",
  "tab",
  "icon",
  "label",
  "menu",
  "sidebar",
  "form",
  "badge",
];

const STRONG_UX_VERBS: readonly string[] = [
  "move",
  "reposition",
  "resize",
  "realign",
  "align",
  "recolor",
  "re-color",
  "restyle",
  "redesign",
];

const CHANGE_VERBS: readonly string[] = [
  "add",
  "change",
  "move",
  "make",
  "update",
  "edit",
  "reposition",
  "resize",
  "align",
  "shrink",
  "grow",
  "swap",
  "replace",
  "tweak",
  "adjust",
  "fix",
  "reword",
  "rewrite",
  "use",
  "switch",
];

const QUALITY_INTENT_TERMS: readonly string[] = [
  "bigger",
  "larger",
  "smaller",
  "tighter",
  "looser",
  "wider",
  "narrower",
  "taller",
  "shorter",
  "bolder",
  "cleaner",
  "darker",
  "lighter",
  "prominent",
  "cramped",
  "too big",
  "too small",
  "too tall",
  "too tight",
  "too wide",
];

const PREVIEW_COMPLAINT_TERMS: readonly string[] = [
  "not working",
  "isn't working",
  "isnt working",
  "is not working",
  "doesn't work",
  "doesnt work",
  "does not work",
  "not clickable",
  "can't see",
  "cant see",
  "cannot see",
  "nothing happens",
  "no other page",
  "doesn't do anything",
  "doesnt do anything",
  "does not do anything",
  "not doing anything",
  "aren't doing anything",
  "arent doing anything",
  "inert",
  "unclickable",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildMatcher(terms: readonly string[]): RegExp {
  const alts = terms
    .map((v) => escapeRegExp(v).replace(/\\?\s+/g, "\\s+"))
    .join("|");
  return new RegExp(`\\b(?:${alts})s?\\b`, "i");
}
const STRONG_RE = buildMatcher([...STRONG_DESIGN_TERMS, ...STRONG_UX_VERBS]);
const WEAK_RE = buildMatcher(WEAK_SURFACE_TERMS);
const VERB_RE = buildMatcher([...CHANGE_VERBS, ...STRONG_UX_VERBS]);
const QUALITY_RE = buildMatcher(QUALITY_INTENT_TERMS);
const COMPLAINT_RE = buildMatcher(PREVIEW_COMPLAINT_TERMS);

function hasChangeIntent(text: string): boolean {
  return VERB_RE.test(text) || QUALITY_RE.test(text);
}

const VISUAL_CORRECTION_VERBS: readonly string[] = [
  "move",
  "reposition",
  "resize",
  "realign",
  "align",
  "recolor",
  "re-color",
  "shrink",
  "enlarge",
];
const VISUAL_CORRECTION_RE = buildMatcher([
  ...QUALITY_INTENT_TERMS,
  ...VISUAL_CORRECTION_VERBS,
]);

function hasVisualCorrectionIntent(text: string): boolean {
  return VISUAL_CORRECTION_RE.test(text);
}

export function isUxDesignShapedTurn(userText: string): boolean {
  const text = (userText ?? "").trim();
  if (text.length < 3) return false;
  if (STRONG_RE.test(text)) return true;
  if (WEAK_RE.test(text) && hasChangeIntent(text)) return true;
  return false;
}

const EXPLICIT_PREVIEW_RE =
  /\b(preview|prototype|mock|mock-?up|wireframe|re-?show)\b|\b(see|show|render|view|display)\b[^.?!]{0,24}\b(preview|mock|mock-?up|design|it again|that again)\b/i;

export function hasExplicitPreviewIntent(userText: string): boolean {
  const text = (userText ?? "").trim();
  if (text.length < 3) return false;
  return EXPLICIT_PREVIEW_RE.test(text);
}

export function isPreviewComplaintTurn(userText: string): boolean {
  const text = (userText ?? "").trim();
  if (text.length < 3) return false;
  return COMPLAINT_RE.test(text);
}

export type PriorMessageLike = {
  role?: unknown;
  content?: unknown;
};

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}

export function previousAssistantWasHtmlPreview(
  priorMessages: readonly PriorMessageLike[] | null | undefined,
): boolean {
  if (!Array.isArray(priorMessages) || priorMessages.length === 0) return false;
  for (let i = priorMessages.length - 1; i >= 0; i--) {
    const m = priorMessages[i];
    if (!m || m.role !== "assistant") continue;
    const body = contentToText(m.content);
    return (
      body.includes(PREVIEW_APPROVE_MARKER) || body.includes(PREVIEW_INERT_MARKER)
    );
  }
  return false;
}

export type SuppressReason = "complaint" | "not_design_shaped";

export type SuppressDecision = {
  suppress: boolean;
  reason?: SuppressReason;
};

export function shouldSuppressHtmlPreview(opts: {
  userText: string;
  priorMessages?: readonly PriorMessageLike[] | null;
}): SuppressDecision {
  const userText = (opts.userText ?? "").trim();

  if (
    isPreviewComplaintTurn(userText) &&
    previousAssistantWasHtmlPreview(opts.priorMessages) &&
    !hasVisualCorrectionIntent(userText)
  ) {
    return { suppress: true, reason: "complaint" };
  }

  if (!isPreviewComplaintTurn(userText) && hasExplicitPreviewIntent(userText)) {
    return { suppress: false };
  }

  if (!isUxDesignShapedTurn(userText)) {
    return { suppress: true, reason: "not_design_shaped" };
  }

  return { suppress: false };
}

const HTML_PREVIEW_BLOCK_GLOBAL_RE =
  /<html_preview(?:\s[^>]*)?>[\s\S]*?<\/html_preview\s*>/gi;
const HTML_PREVIEW_OPEN_TAIL_RE = /<html_preview(?:\s[^>]*)?>[\s\S]*$/i;

export const HTML_PREVIEW_STRIP_FALLBACK =
  "I put together a preview but couldn't render it. Say \"show me the preview\" and I'll regenerate it.";

export function stripHtmlPreviewBlock(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  const hadBlock = /<html_preview(?:\s[^>]*)?>/i.test(text);
  const out = text
    .replace(HTML_PREVIEW_BLOCK_GLOBAL_RE, "")
    .replace(HTML_PREVIEW_OPEN_TAIL_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (out.length > 0) return out;
  return hadBlock ? HTML_PREVIEW_STRIP_FALLBACK : "";
}

export type HtmlPreviewSurface = {
  envelope: ParsedHtmlPreview;
  outputText: string;
};

export function resolveEngineerHtmlPreview(opts: {
  rawText: string;
  userText: string;
  priorMessages?: readonly PriorMessageLike[] | null;
}): HtmlPreviewSurface | null {
  const decision = shouldSuppressHtmlPreview({
    userText: opts.userText,
    priorMessages: opts.priorMessages,
  });
  if (decision.suppress) return null;

  const envelope = parseHtmlPreviewEnvelope(opts.rawText);
  if (!envelope) return null;

  const outputText = `${envelope.summary}\n\n${PREVIEW_INERT_MARKER}\n\n---\n${PREVIEW_APPROVE_MARKER}`;
  return { envelope, outputText };
}
