
import {
  buildClarifyEnvelope,
  fromLegacyStringQuestions,
  synthesizeClarifyBubbleText,
  trimToClarifyIntro,
  GENERIC_CLARIFY_INTRO,
  CLARIFY_ENVELOPE_KIND,
  type ClarifyEnvelope,
  type ClarifyStripCounts,
} from "./clarify-envelope";
import { agentCapabilities } from "./registry";

const STRUCTURED_RESCUE_SLUGS: ReadonlySet<string> = new Set([
  "cgo",
  "pm",
  "engineer",
]);

function isStructuredRescueAgent(slug: string): boolean {
  return (
    STRUCTURED_RESCUE_SLUGS.has(slug) ||
    agentCapabilities(slug).structured_clarifications
  );
}

const META_PLACEHOLDER_RE =
  /asking \d+.*question|no \w+ (items?|emitted|backlog)|clarification turn|strategy memo .* turn/i;
const META_PLACEHOLDER_MAX_LEN = 180;

export function isMetaPlaceholder(rm: string | undefined | null): boolean {
  if (typeof rm !== "string") return false;
  const t = rm.trim();
  if (t.length === 0 || t.length >= META_PLACEHOLDER_MAX_LEN) return false;
  return META_PLACEHOLDER_RE.test(t);
}

export function stripChatJsonFences(s: string): string {
  if (!s) return s;
  const out = s
    .replace(/```[ \t]*json[ \t]*\r?\n[\s\S]*?```/gi, "")
    .replace(
      /```[ \t]*\r?\n\s*\{[\s\S]*?"(?:recommendations|decision)"[\s\S]*?```/gi,
      "",
    )
    .replace(
      /\n+\s*\{[\s\S]*?"(?:recommendations|decision)"\s*:[\s\S]*\}\s*$/g,
      "",
    );
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function synthesizeClarifyingMarkdown(questions: string[]): string {
  const items = questions
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .map((q, i) => `${i + 1}. ${q.trim()}`);
  return `## Clarifying questions\n\n${items.join("\n\n")}`;
}

function extractStructuredQuestions(
  parsed: Record<string, unknown>,
): string[] | null {
  const cn = (
    parsed.strategy as { clarifications_needed?: unknown } | undefined
  )?.clarifications_needed;
  const strategyQuestions =
    cn && typeof cn === "object"
      ? (cn as { questions?: unknown }).questions
      : undefined;

  const candidates: unknown[] = [
    strategyQuestions,
    (parsed as { questions?: unknown }).questions,
    (parsed as { clarifications?: unknown }).clarifications,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const qs = c.filter(
        (q): q is string => typeof q === "string" && q.trim().length > 0,
      );
      if (qs.length > 0) return qs;
    }
  }
  return null;
}

function hasSubstantiveReframe(parsed: Record<string, unknown>): boolean {
  const ro = (parsed.strategy as { reframe_options?: unknown } | undefined)
    ?.reframe_options;
  return Array.isArray(ro) && ro.length > 0;
}

export type RenderSelection = {
  text: string;
  rescueKind?: "structured_questions" | "preceding_prose" | null;
  clarifyEnvelope?: ClarifyEnvelope | null;
  clarifyDegraded?: boolean;
  clarifyStripped?: ClarifyStripCounts;
};

export function selectRenderedText(args: {
  envelope: string;
  agentSlug: string;
  parsed: Record<string, unknown> | null;
  rawText: string;
  realHitIds?: ReadonlySet<string>;
}): RenderSelection {
  const { envelope, agentSlug, parsed, rawText, realHitIds } = args;

  if (!parsed || typeof parsed !== "object") {
    return { text: rawText.trim(), rescueKind: null };
  }

  if (
    (parsed as { envelope_kind?: unknown }).envelope_kind ===
    CLARIFY_ENVELOPE_KIND
  ) {
    const built = buildClarifyEnvelope({ agentSlug, rawInput: parsed, realHitIds });
    return {
      text: synthesizeClarifyBubbleText(built.envelope),
      rescueKind: "structured_questions",
      clarifyEnvelope: built.envelope,
      clarifyDegraded: built.degraded,
      clarifyStripped: built.stripped,
    };
  }

  const rm = (parsed as { rendered_markdown?: unknown }).rendered_markdown;

  if (isStructuredRescueAgent(agentSlug)) {
    const qs = extractStructuredQuestions(parsed);
    if (qs) {
      const rmScrubbed =
        typeof rm === "string" && !isMetaPlaceholder(rm)
          ? stripChatJsonFences(rm)
          : undefined;
      const rmStr =
        rmScrubbed !== undefined && rmScrubbed.trim().length > 0
          ? rmScrubbed
          : undefined;
      const introSrc = rmStr !== undefined ? trimToClarifyIntro(rmStr) : undefined;
      const built = fromLegacyStringQuestions(agentSlug, qs, introSrc);
      const showFullMemo = hasSubstantiveReframe(parsed) && rmStr !== undefined;
      const trimsAwayQuestions = agentSlug !== "cgo";
      const introProse = !trimsAwayQuestions
        ? rmStr
        : introSrc !== undefined && introSrc !== GENERIC_CLARIFY_INTRO
          ? introSrc
          : undefined;

      const strippedRaw =
        rmStr === undefined
          ? stripChatJsonFences(
              (rawText.includes(`</${envelope}>`)
                ? rawText.replace(
                    new RegExp(`<${envelope}>[\\s\\S]*<\\/${envelope}>`),
                    "",
                  )
                :
                  rawText.split(`<${envelope}>`)[0]
              ).trim(),
            ).trim()
          : "";
      const strippedProse =
        strippedRaw.length > 50 &&
        (!trimsAwayQuestions ||
          trimToClarifyIntro(strippedRaw) !== GENERIC_CLARIFY_INTRO)
          ? strippedRaw
          : undefined;
      const bodyProse = showFullMemo
        ? (rmStr as string)
        : (introProse ?? strippedProse);
      return {
        text: bodyProse ?? synthesizeClarifyBubbleText(built.envelope),
        rescueKind: "structured_questions",
        clarifyEnvelope: built.envelope,
        clarifyDegraded: built.degraded,
      };
    }
  }

  if (typeof rm === "string") {
    if (!isMetaPlaceholder(rm)) {
      return { text: stripChatJsonFences(rm), rescueKind: null };
    }
    const preEnvelope = rawText.split(`<${envelope}>`)[0].trim();
    if (preEnvelope.length > 50) {
      return { text: preEnvelope, rescueKind: "preceding_prose" };
    }
    return { text: rm, rescueKind: null };
  }

  const bullets = (parsed as { summary?: { bullets?: unknown[] } }).summary
    ?.bullets;
  if (Array.isArray(bullets) && bullets.length > 0) {
    return {
      text: (bullets as string[]).map((b) => `• ${b}`).join("\n"),
      rescueKind: null,
    };
  }
  const stripped = rawText
    .replace(new RegExp(`<${envelope}>[\\s\\S]*<\\/${envelope}>`), "")
    .trim();
  return {
    text: stripped || `[${envelope} run completed — see Runs tab for details]`,
    rescueKind: null,
  };
}
