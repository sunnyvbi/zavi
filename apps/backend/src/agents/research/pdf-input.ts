import type { ResearchReport } from "./output-schema";
import type { Block } from "./blocks";
import { MAX_TABLE_ROWS, TOTAL_PROSE_BUDGET } from "@/services/reports/schema";
import { stripLeakedJson } from "./clean-prose";

const MAX_SECTIONS = 20;
const MAX_BODY = 10_000;
const BODY_BUDGET = TOTAL_PROSE_BUDGET - 4_000;

type Section = { heading: string; body_markdown: string; table?: { columns: string[]; rows: string[][] } };

function slug(s: string): string {
  return (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "research") + ".pdf";
}

function clampBody(s: string): string {
  const t = stripLeakedJson(s).trim();
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY - 1)}…` : t;
}

function headingOr(s: string | undefined, fallback: string): string {
  const t = (s ?? "").trim();
  return (t.length > 0 ? t : fallback).slice(0, 200);
}

function blockToSection(b: Block): Section | null {
  switch (b.type) {
    case "hero":
      return { heading: b.title.slice(0, 200), body_markdown: clampBody([b.subtitle, b.big_stat ? `${b.big_stat.value} — ${b.big_stat.label}` : ""].filter(Boolean).join("\n\n")) || "—" };
    case "exec_summary":
      return { heading: "Executive summary", body_markdown: clampBody([b.pull_quote, ...(b.stat_tiles ?? []).map((t) => `- **${t.value}** — ${t.label}`), b.prose_md].filter(Boolean).join("\n\n")) };
    case "stat_tiles":
      return { heading: "Key stats", body_markdown: clampBody(b.tiles.map((t) => `- **${t.value}** — ${t.label}`).join("\n")) };
    case "persona_cards":
      return { heading: "Personas", body_markdown: clampBody(b.cards.map((c) => `**${c.name} — ${c.tagline}**\n- Need: ${c.fields.primary_need}\n- Pain: ${c.fields.pain_point}\n- Buy likelihood: ${c.buy_likelihood}/5\n${c.commentary_md}`).join("\n\n")) };
    case "qa_grid":
      return { heading: "Q&A", body_markdown: clampBody(b.items.map((i) => `**Q: ${i.question}**\n${i.answer_md}`).join("\n\n")) };
    case "theme_bars":
      return { heading: headingOr(b.title, "Themes"), body_markdown: clampBody(b.bars.map((x) => `- **${x.label}** (${x.pct}%)${x.quote ? ` — "${x.quote}"` : ""}`).join("\n")) };
    case "sentiment_meter":
      return { heading: "Sentiment", body_markdown: `Positive ${b.sentiment.pos}% · Neutral ${b.sentiment.neu}% · Negative ${b.sentiment.neg}%` };
    case "cards_grid":
      return { heading: "Details", body_markdown: clampBody(b.cards.map((c) => `**${c.title}**\n${c.body_md}${c.meta ? `\n${c.meta.label}: ${c.meta.value}` : ""}`).join("\n\n")) };
    case "competitive_table":
      return { heading: "Competitive landscape", body_markdown: "", table: { columns: ["Brand", "Price", "Positioning", "Gap"], rows: b.rows.slice(0, MAX_TABLE_ROWS).map((r) => [r.brand, r.price ?? "—", r.positioning, r.gap].map((c) => c.slice(0, 500))) } };
    case "material_moves":
      return { heading: "What changed", body_markdown: clampBody(b.items.map((i) => `**${i.competitor}: ${i.move}**\n${i.why_now}`).join("\n\n")) };
    case "gap_list":
      return { heading: "Gaps", body_markdown: clampBody(b.items.map((i) => `**[${i.category}] ${i.title}**\n${i.body_md}`).join("\n\n")) };
    case "recommendations":
      return { heading: "Recommendations", body_markdown: clampBody(b.items.map((i) => `**${i.index}. ${i.label} — ${i.title}**\n${i.body_md}`).join("\n\n")) };
    case "risks":
      return { heading: "Risks", body_markdown: clampBody(b.items.map((i) => `- **${i.title}** — ${i.body_md}`).join("\n")) };
    case "validation":
      return { heading: "Validation", body_markdown: clampBody(b.chips.map((c) => `- [${c.tier}] ${c.text}`).join("\n")) };
    case "source_list":
      return { heading: "Sources", body_markdown: clampBody(b.sources.map((s) => `- ${s.n}. ${s.title} (${s.url})`).join("\n")) };
    case "markdown":
      return { heading: "Notes", body_markdown: clampBody(b.body_md) };
    case "table": {
      const cols = b.columns.slice(0, 8).map((c) => c.slice(0, 500));
      const heading = headingOr(b.title, "Table");
      if (cols.length === 0) {
        return { heading, body_markdown: clampBody(b.rows.map((r) => `- ${r.join(" · ")}`).join("\n")) || "—" };
      }
      const rows = b.rows.slice(0, MAX_TABLE_ROWS).map((r) => r.slice(0, cols.length).map((c) => c.slice(0, 500)));
      const padded = rows.map((r) => (r.length < cols.length ? [...r, ...Array(cols.length - r.length).fill("")] : r));
      return { heading, body_markdown: "", table: { columns: cols, rows: padded } };
    }
    default: {
      const _exhaustive: never = b;
      void _exhaustive;
      return null;
    }
  }
}

export function buildResearchPdfInput(report: ResearchReport): {
  title: string;
  sections: Section[];
  filename: string;
  footer?: string;
  title_metadata?: { author?: string; subject?: string };
} {
  const sections: Section[] = [];
  let used = 0;
  const sectionCost = (s: Section): number =>
    s.heading.length + s.body_markdown.length + (s.table?.rows.flat().reduce((a, c) => a + c.length, 0) ?? 0);
  for (const block of report.blocks) {
    if (sections.length >= MAX_SECTIONS) break;
    const sec = blockToSection(block);
    if (!sec) continue;
    if (!sec.table && sec.body_markdown.trim().length === 0) sec.body_markdown = "—";
    const fixedCost = sec.heading.length + (sec.table?.rows.flat().reduce((a, c) => a + c.length, 0) ?? 0);
    const remaining = BODY_BUDGET - used - fixedCost;
    if (remaining <= 0) continue;
    if (sec.body_markdown.length > remaining) {
      sec.body_markdown = remaining > 1 ? `${sec.body_markdown.slice(0, remaining - 1)}…` : "—";
    }
    sections.push(sec);
    used += sectionCost(sec);
  }
  const hasSourceListBlock = report.blocks.some((b) => b.type === "source_list");
  if (!hasSourceListBlock && report.sources.length > 0 && sections.length < MAX_SECTIONS) {
    const sec: Section = {
      heading: "Sources",
      body_markdown: clampBody(report.sources.map((s) => `- ${s.n}. ${s.title} (${s.url})`).join("\n")),
    };
    if (sec.body_markdown.trim().length === 0) sec.body_markdown = "—";
    const fixedCost = sec.heading.length;
    const remaining = BODY_BUDGET - used - fixedCost;
    if (remaining > 0) {
      if (sec.body_markdown.length > remaining) {
        sec.body_markdown = remaining > 1 ? `${sec.body_markdown.slice(0, remaining - 1)}…` : "—";
      }
      sections.push(sec);
      used += sectionCost(sec);
    }
  }
  if (sections.length === 0) {
    sections.push({ heading: "Summary", body_markdown: (report.subtitle?.trim() || report.title).slice(0, MAX_BODY) });
  }
  return {
    title: report.title.slice(0, 200),
    sections,
    filename: slug(report.title),
    footer: `Generated by Zavi research · ${report.generated_at}`.slice(0, 500),
    title_metadata: { author: "Zavi research", subject: report.title.slice(0, 200) },
  };
}
