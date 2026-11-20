
import type { ToolCallTrace } from "@/services/tools/types";

export const FABRICATED_BLOCKER_VALIDATOR_AGENTS: ReadonlySet<string> = new Set([
  "operator",
]);

const GROUNDING_ERROR_CODE =
  /\b(?:[a-z_]*_no_thread|[a-z_]*_not_connected|[a-z_]*_not_installed|[a-z_]*_not_authorized|[a-z_]*_not_allowed|slack_workspace_unresolved|handoff_parallel_slack_unsupported|[a-z_]*_unsupported|[a-z_]*_disabled)\b/i;

const FABRICATED_BLOCKER_PATTERNS: readonly RegExp[] = [
  /slack[-\s]?(?:dm|direct message)s?\b[^.?!]*\b(?:not|isn'?t|aren'?t|un)\s*(?:available|support|supported|possible)/i,
  /platform[-\s]?level\b[^.?!]*\b(?:fail|constraint|limitation|restrict|block)/i,
  /\bplatform\s+(?:routing\s+)?(?:constraint|limitation|restriction)\b/i,
  /routing\s+context\b[^.?!]*\b(?:isn'?t|is\s+not|not)\s+available/i,
  /\b(?:can'?t|cannot|unable\s+to|won'?t\s+be\s+able\s+to)\b[^.?!]*\b(?:dispatch|hand[-\s]?off|handoff|route|delegate)\b[^.?!]*\bfrom\s+(?:here|this\s+(?:dm|thread|channel)|slack|the\s+slack)/i,
  /\b(?:can'?t|cannot|unable\s+to)\b[^.?!]*\b(?:dispatch|hand[-\s]?off|handoff|fire|kick\s+off)\b[^.?!]*\b(?:engineer|specialist|agent)\b[^.?!]*\bfrom\s+(?:here|this\s+(?:dm|thread|channel)|slack)/i,
  /paste\s+(?:it|this|that|the\s+\w+)?\s*(?:in)?to\s+the\s+(?:main\s+)?(?:web\s+|zavi\s+|praxis\s+)?chat\b/i,
  /\bin\s+the\s+(?:main\s+)?(?:web\s+)?(?:chat|workspace)\s+(?:window|interface)\b[^.?!]*\b(?:not|instead)\b/i,
];

const SELF_SERVE_TOOL_LACK_PATTERNS: readonly RegExp[] = [
  /\b(?:github__)?(?:read_file|search_code|list_files)\b(?:\s+tool)?[^.?!]*\b(?:isn'?t|is\s+not|not|aren'?t|wasn'?t)\s+(?:available|accessible|enabled|present|wired|usable)\b/i,
  /\b(?:don'?t|do\s+not|didn'?t)\s+have\s+(?:access\s+to\s+)?(?:a\s+|the\s+)?(?:(?:github__)?read_file\b|(?:file[-\s]?)?read(?:ing)?\s+(?:tool|access|capabilit))/i,
];

const SELF_SERVE_LOOKUP_HANDOFF_PATTERNS: readonly RegExp[] = [
  /\b(?:have|let|ask|get|route\b[^.?!]*\bto)\s+(?:the\s+)?(?:engineer|specialist|a\s+specialist)\b[^.?!]*\b(?:read|look\s*up|look\s+at|check|find|trace|inspect|open)\b/i,
];

export type FabricatedBlockerFlags = {
  matched_phrases: string[];
  grounded_by_tool_error: boolean;
};

export type FabricatedBlockerResult = {
  hedged: boolean;
  text: string;
  flags: FabricatedBlockerFlags;
};

function hasGroundingErrorCode(toolCalls: readonly ToolCallTrace[]): boolean {
  return toolCalls.some((t) => {
    if (typeof t?.name !== "string") return false;
    if (t.name.startsWith("memory__")) return false;
    const out = typeof t.output_preview === "string" ? t.output_preview : "";
    return GROUNDING_ERROR_CODE.test(out);
  });
}

function hasReadBudgetExhaustion(toolCalls: readonly ToolCallTrace[]): boolean {
  return toolCalls.some((t) => {
    if (typeof t?.name !== "string") return false;
    if (!/^github__(read_file|search_code|list_files)$/.test(t.name)) return false;
    const out = typeof t.output_preview === "string" ? t.output_preview : "";
    return /BUDGET EXHAUSTED/i.test(out);
  });
}

function buildHonestBanner(): string {
  return [
    "> ⚠️ **Correction** — I can dispatch specialists (engineer, support-lead, etc.) directly from right here; there is no platform limitation that prevents it, and you never need to repeat a request elsewhere.",
    "> If a handoff doesn't go through, the honest reason is an internal error on my side — I'll surface that error and retry, not ask you to work around it.",
    "",
    "",
  ].join("\n");
}

function buildSelfServeBanner(): string {
  return "> _Note: file lookups are mine to answer — I can read the repo directly rather than route this to a specialist._\n\n";
}

export function verifyNoFabricatedBlocker(args: {
  reply: string;
  toolCalls?: readonly ToolCallTrace[];
}): FabricatedBlockerResult {
  const reply = typeof args.reply === "string" ? args.reply : "";
  const toolCalls = args.toolCalls ?? [];

  const matched: string[] = [];
  const collect = (pats: readonly RegExp[]): boolean => {
    let hit = false;
    for (const pat of pats) {
      const m = reply.match(pat);
      if (m) {
        matched.push(m[0].trim());
        hit = true;
      }
    }
    return hit;
  };

  const dispatchMatch = collect(FABRICATED_BLOCKER_PATTERNS);
  const toolLackMatch = collect(SELF_SERVE_TOOL_LACK_PATTERNS);
  const lookupHandoffMatch = collect(SELF_SERVE_LOOKUP_HANDOFF_PATTERNS);

  const groundedByToolError = hasGroundingErrorCode(toolCalls);
  const flags: FabricatedBlockerFlags = {
    matched_phrases: Array.from(new Set(matched)),
    grounded_by_tool_error: groundedByToolError,
  };

  if (groundedByToolError) {
    return { hedged: false, text: reply, flags };
  }

  const toolLackFires = toolLackMatch && !hasReadBudgetExhaustion(toolCalls);
  const selfServeFires = toolLackFires || lookupHandoffMatch;

  if (!dispatchMatch && !selfServeFires) {
    return { hedged: false, text: reply, flags };
  }

  const banner =
    (selfServeFires ? buildSelfServeBanner() : "") +
    (dispatchMatch ? buildHonestBanner() : "");
  return { hedged: true, text: banner + reply, flags };
}
