
import type { NoteOutcome } from "./outcome-aggregate";

export type EpisodeSignalRow = {
  agent_slug: string;
  agent_run_id: string;
  outcome: NoteOutcome;
  trust_tier: number;
  redacted_trajectory: {
    question?: unknown;
    output_text?: unknown;
    connectors_used?: unknown;
    candidate_sources_checked?: unknown;
    candidate_dead_ends?: unknown;
  } | null;
};

export type BuiltEpisodeNote = {
  title: string;
  body_markdown: string;
  source_ref: string;
  metadata: Record<string, unknown>;
};

const OUTPUT_SNIPPET_MAX = 400;

function asTrimmed(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const PROV_LIST_MAX = 6;

function asStringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
}

function deadEndLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const tool = asTrimmed((e as { tool?: unknown }).tool);
    if (!tool) continue;
    const code = asTrimmed((e as { code?: unknown }).code);
    out.push(code ? `${tool} (${code})` : tool);
  }
  return out;
}

function checkedLabels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const tool = asTrimmed((e as { tool?: unknown }).tool);
    if (!tool) continue;
    const n = (e as { returned_count?: unknown }).returned_count;
    out.push(typeof n === "number" && n > 0 ? `${tool} (${n} ids)` : tool);
  }
  return out;
}

function provLine(label: string, items: string[]): string | null {
  if (items.length === 0) return null;
  const shown = items.slice(0, PROV_LIST_MAX);
  const more = items.length - shown.length;
  return `${label}: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

export function buildEpisodeNote(s: EpisodeSignalRow): BuiltEpisodeNote | null {
  const question = asTrimmed(s.redacted_trajectory?.question);
  if (!question) return null;

  const output = asTrimmed(s.redacted_trajectory?.output_text);
  const outcomeWord = s.outcome === "accepted" ? "accepted" : "rejected";
  const proposed =
    output.length > OUTPUT_SNIPPET_MAX
      ? `${output.slice(0, OUTPUT_SNIPPET_MAX)}…`
      : output;

  const title = `${s.agent_slug} — operator ${outcomeWord}: ${question.slice(0, 70)}`;

  const lines = [
    `Past decision by **${s.agent_slug}** — operator **${outcomeWord}** it.`,
    "",
    `When asked:`,
    `> ${question}`,
  ];
  if (proposed) {
    lines.push("", `What I proposed:`, `> ${proposed}`);
  }

  const connectors = asStringList(s.redacted_trajectory?.connectors_used);
  const checked = checkedLabels(s.redacted_trajectory?.candidate_sources_checked);
  const deadEnds = deadEndLabels(s.redacted_trajectory?.candidate_dead_ends);
  const provLines = [
    provLine("Connectors used", connectors),
    provLine("Evidence pulled", checked),
    provLine("Dead ends hit", deadEnds),
  ].filter((l): l is string => l !== null);
  if (provLines.length > 0) {
    lines.push("", "How the work went:", ...provLines.map((l) => `- ${l}`));
  }

  lines.push(
    "",
    `Outcome: the operator **${outcomeWord}** this. ` +
      (s.outcome === "rejected"
        ? "Do not repeat this approach without checking why it was rejected."
        : "This approach worked before."),
    "",
    `_(episode ${s.agent_run_id})_`,
  );

  return {
    title,
    body_markdown: lines.join("\n"),
    source_ref: `episode:${s.agent_run_id}`,
    metadata: {
      kind: "agent_experience",
      outcome: s.outcome,
      agent_slug: s.agent_slug,
      agent_run_id: s.agent_run_id,
      ...(connectors.length > 0 ? { connectors_used: connectors } : {}),
      ...(checked.length > 0 ? { sources_checked_count: checked.length } : {}),
      ...(deadEnds.length > 0 ? { dead_end_count: deadEnds.length } : {}),
    },
  };
}
