
import { createHash } from "node:crypto";
import {
  htmlPreviewMetadataSchema,
  htmlPreviewSchema,
  type HtmlPreview,
  type ParsedHtmlPreview,
} from "./output-schema";

export const CONTRACT_HTML_MAX_CHARS = 16 * 1024;
export const CONTRACT_SPEC_MAX_CHARS = 8 * 1024;
export const CONTRACT_TOTAL_MAX_CHARS = 24 * 1024;

export const CONTRACT_VERSION = 1;

export type LastAssistantRow =
  | { meta?: unknown; agent_run_id?: string | null }
  | null
  | undefined;

export function selectLatestPreviewRow(
  rows: readonly Exclude<LastAssistantRow, null | undefined>[],
): Exclude<LastAssistantRow, null | undefined> | undefined {
  return rows.find((row) => {
    const envelope = (row.meta as { envelope?: unknown } | undefined)?.envelope;
    return (
      envelope !== null &&
      typeof envelope === "object" &&
      (envelope as { kind?: unknown }).kind === "html_preview"
    );
  });
}

export function selectApprovedPreview(row: LastAssistantRow): ParsedHtmlPreview | null {
  const meta = (row?.meta ?? null) as { envelope?: unknown } | null;
  if (!meta || typeof meta !== "object") return null;

  const env = meta.envelope as
    | (Record<string, unknown> & { kind?: unknown; pending_html_preview?: unknown })
    | null
    | undefined;
  if (!env || typeof env !== "object") return null;

  if (env.kind !== "html_preview") return null;
  if (env.pending_html_preview !== true) return null;

  const metadata = htmlPreviewMetadataSchema.safeParse(env);
  if (metadata.success) return metadata.data;
  const legacy = htmlPreviewSchema.safeParse(env);
  return legacy.success ? legacy.data : null;
}

export function getCanonicalPreviewState(
  row: LastAssistantRow,
): "ready" | "failed" | "none" {
  const env = ((row?.meta as { envelope?: unknown } | undefined)?.envelope ??
    null) as Record<string, unknown> | null;
  if (!env || env.kind !== "html_preview") return "none";
  if (env.state === "html_preview_failed") return "failed";
  return selectApprovedPreview(row) ? "ready" : "failed";
}

export type PreviewTurnGate = {
  block_build: boolean;
  retry_preview: boolean;
};

const PREVIEW_RETRY_RE =
  /\b(?:retry|regenerate|recreate|show|render)\b[\s\S]{0,40}\bpreview\b|\bpreview\b[\s\S]{0,40}\b(?:again|retry|regenerate|recreate)\b/i;
const PREVIEW_APPROVAL_RE =
  /^\s*(?:yes(?:\s+please)?|yep|approved?|looks good(?:\s+to me)?|lgtm|go ahead|proceed|ship it|build it)\s*[.!]*\s*$/i;
const PREVIEW_ACTION_RE =
  /\b(?:build|implement|code|ship|approve|apply|merge|open\s+(?:a\s+)?pr|create\s+(?:a\s+)?pr|make\s+(?:the|this|that)\s+change|continue\s+(?:with|to)\s+(?:the\s+)?(?:build|implementation))\b/i;
const PREVIEW_ACTION_NEGATION_RE =
  /\b(?:do\s+not|don['’]?t|never|cancel|stop)\b[^.?!]{0,40}\b(?:build|implement|ship|approve|merge|open\s+(?:a\s+)?pr)\b/i;

export function resolveFailedPreviewTurnGate(args: {
  canonical_state: "ready" | "failed" | "not_displayed" | "none";
  intent: "info" | "ship" | "ambiguous" | undefined;
  user_text: string;
}): PreviewTurnGate {
  if (
    args.canonical_state !== "failed" &&
    args.canonical_state !== "not_displayed"
  ) {
    return { block_build: false, retry_preview: false };
  }
  if (PREVIEW_RETRY_RE.test(args.user_text)) {
    return { block_build: false, retry_preview: true };
  }
  if (args.intent === "info") {
    return { block_build: false, retry_preview: false };
  }
  if (PREVIEW_ACTION_NEGATION_RE.test(args.user_text)) {
    return { block_build: false, retry_preview: false };
  }
  const block =
    args.intent === "ship" ||
    PREVIEW_APPROVAL_RE.test(args.user_text) ||
    PREVIEW_ACTION_RE.test(args.user_text);
  return { block_build: block, retry_preview: false };
}

export type DesignContract = {
  text: string;
  hash: string;
  version: number;
  truncated: boolean;
};

function renderSpec(spec: NonNullable<HtmlPreview["design_spec"]>): string {
  const lines: string[] = [];
  if (spec.components?.length) {
    lines.push(`Components the mock draws: ${spec.components.join("; ")}`);
  }
  lines.push(
    spec.native_controls?.length
      ? `Native browser controls used ON PURPOSE (these, and only these, may appear as native controls in the build): ${spec.native_controls.join("; ")}`
      : `Native browser controls used on purpose: NONE. Every control in this mock is custom — do not substitute a native one.`,
  );
  if (spec.palette?.length) lines.push(`Palette: ${spec.palette.join(", ")}`);
  if (spec.spacing) lines.push(`Spacing: ${spec.spacing}`);
  if (spec.cta_states) lines.push(`CTA states: ${spec.cta_states}`);
  return lines.join("\n").slice(0, CONTRACT_SPEC_MAX_CHARS);
}

export function buildDesignContract(envelope: HtmlPreview): DesignContract {
  const parts: string[] = [];

  parts.push(`Title: ${envelope.title}`);
  parts.push(`Summary: ${envelope.summary}`);

  if (envelope.design_spec) {
    parts.push("");
    parts.push("APPROVED DESIGN SPEC:");
    parts.push(renderSpec(envelope.design_spec));
  }

  if (envelope.rationale?.length) {
    parts.push("");
    parts.push("Why each change was made:");
    for (const r of envelope.rationale) parts.push(`- ${r.change} — ${r.why}`);
  }

  const head = parts.join("\n");

  const htmlBudget = Math.max(
    0,
    Math.min(CONTRACT_HTML_MAX_CHARS, CONTRACT_TOTAL_MAX_CHARS - head.length - 64),
  );
  const truncated = envelope.html.length > htmlBudget;
  const html = truncated
    ? `${envelope.html.slice(0, htmlBudget)}\n<!-- … mock truncated to fit the prompt budget; the APPROVED DESIGN SPEC above is authoritative … -->`
    : envelope.html;

  const text = [head, "", "APPROVED MOCK (HTML):", html].join("\n");

  return {
    text,
    hash: createHash("sha256").update(`v${CONTRACT_VERSION}\n${text}`, "utf8").digest("hex"),
    version: CONTRACT_VERSION,
    truncated,
  };
}

const TYPE_EQ = String.raw`\btype\s*=\s*\{?\s*["']`;
const NATIVE_CONTROL_PATTERNS: ReadonlyArray<{ canonical: string; re: RegExp }> = [
  { canonical: "datetime-local", re: new RegExp(`<input[^>]*${TYPE_EQ}datetime-local["']`, "i") },
  { canonical: "date", re: new RegExp(`<input[^>]*${TYPE_EQ}date["']`, "i") },
  { canonical: "time", re: new RegExp(`<input[^>]*${TYPE_EQ}time["']`, "i") },
  { canonical: "month", re: new RegExp(`<input[^>]*${TYPE_EQ}month["']`, "i") },
  { canonical: "color", re: new RegExp(`<input[^>]*${TYPE_EQ}color["']`, "i") },
  { canonical: "select", re: /<select(\s|>)/i },
];

const CANONICAL_IDS: ReadonlySet<string> = new Set(
  NATIVE_CONTROL_PATTERNS.map((p) => p.canonical),
);

function canonicalizeAllowed(entry: string): string | null {
  const s = entry.toLowerCase();
  const byLength = [...CANONICAL_IDS].sort((a, b) => b.length - a.length);
  for (const id of byLength) {
    if (new RegExp(`(^|[^a-z0-9-])${id}([^a-z0-9-]|$)`).test(s)) return id;
  }
  return null;
}

function isBlessed(canonical: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => canonicalizeAllowed(a) === canonical);
}

export type FidelityVerdict =
  | { ok: true }
  | { ok: false; substituted: string[] };

export function designSpecFromContract(contract: unknown): HtmlPreview["design_spec"] | undefined {
  if (!contract || typeof contract !== "object") return undefined;
  const spec = (contract as { spec?: unknown }).spec;
  if (!spec || typeof spec !== "object") return undefined;
  return spec as HtmlPreview["design_spec"];
}

export function detectNativeControlSubstitution(
  addedLines: readonly string[],
  spec: HtmlPreview["design_spec"] | undefined,
): FidelityVerdict {
  const allowed = spec?.native_controls ?? [];
  const substituted: string[] = [];

  for (const { canonical, re } of NATIVE_CONTROL_PATTERNS) {
    if (isBlessed(canonical, allowed)) continue;
    if (addedLines.some((line) => re.test(line))) substituted.push(canonical);
  }

  return substituted.length > 0 ? { ok: false, substituted } : { ok: true };
}
