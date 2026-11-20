import type { ResearchReport } from "./output-schema";
import type { Block, Source } from "./blocks";
import { stripLeakedJson } from "./clean-prose";

function cites(c: number[] | undefined): string {
  if (!c || c.length === 0) return "";
  return ` _[${c.join(", ")}]_`;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function head(level: 2 | 3, text: string, proseOnly: boolean): string {
  return proseOnly ? `**${text}**` : `${"#".repeat(level)} ${text}`;
}

function renderBlock(b: Block, proseOnly: boolean): string {
  switch (b.type) {
    case "hero": {
      const parts = [proseOnly ? `**${b.title}**` : `# ${b.title}`];
      if (b.subtitle) parts.push(`_${b.subtitle}_`);
      if (b.big_stat) parts.push(`**${b.big_stat.value}** — ${b.big_stat.label}`);
      return parts.join("\n\n");
    }
    case "exec_summary": {
      const parts: string[] = proseOnly ? [] : ["## Executive summary"];
      if (b.pull_quote) parts.push(`> ${b.pull_quote}`);
      if (b.stat_tiles?.length) {
        parts.push(b.stat_tiles.map((t) => `- **${t.value}** — ${t.label}${cites(t.citation ? [t.citation] : [])}`).join("\n"));
      }
      parts.push(`${b.prose_md}${cites(b.citations)}`);
      return parts.join("\n\n");
    }
    case "stat_tiles":
      return b.tiles.map((t) => `- **${t.value}** — ${t.label}${cites(t.citation ? [t.citation] : [])}`).join("\n");
    case "persona_cards":
      return b.cards
        .map((c) =>
          `${head(3, `${c.name} — ${c.tagline}`, proseOnly)}\n\n` +
          `- Primary need: ${c.fields.primary_need}\n- Pain point: ${c.fields.pain_point}\n` +
          `- Behavior: ${c.fields.behavior}\n- Valued feature: ${c.fields.valued_feature}\n` +
          `- Buy likelihood: ${c.buy_likelihood}/5\n\n${c.commentary_md}${cites(c.citations)}`,
        )
        .join("\n\n");
    case "qa_grid":
      return b.items.map((i) => `**Q: ${i.question}**\n\n${i.answer_md}${cites(i.citations)}`).join("\n\n");
    case "theme_bars": {
      const heading = b.title ? `${head(3, b.title, proseOnly)}\n\n` : "";
      return heading + b.bars.map((bar) => `- **${bar.label}** (${bar.pct}%)${bar.quote ? ` — "${bar.quote}"` : ""}${cites(bar.citations)}`).join("\n");
    }
    case "sentiment_meter":
      return `Sentiment — Positive ${b.sentiment.pos}% · Neutral ${b.sentiment.neu}% · Negative ${b.sentiment.neg}%`;
    case "cards_grid":
      return b.cards.map((c) => `${head(3, c.title, proseOnly)}\n\n${c.body_md}${c.meta ? `\n\n_${c.meta.label}: ${c.meta.value}_` : ""}${cites(c.citations)}`).join("\n\n");
    case "competitive_table": {
      const header = "| Brand | Price | Positioning | Gap |\n|---|---|---|---|";
      const rows = b.rows.map((r) => `| ${cell(r.brand)} | ${cell(r.price ?? "—")} | ${cell(r.positioning)} | ${cell(r.gap)} |`);
      return [header, ...rows].join("\n");
    }
    case "material_moves":
      return b.items.map((i) => `- **${i.competitor}: ${i.move}** — ${i.why_now}${cites(i.citations)}`).join("\n");
    case "gap_list":
      return b.items.map((i) => `${head(3, `[${i.category}] ${i.title}`, proseOnly)}\n\n${i.body_md}${cites(i.citations)}`).join("\n\n");
    case "recommendations":
      return b.items.map((i) => `${i.index}. **${i.label}** — ${i.title}\n\n   ${i.body_md}${cites(i.citations)}`).join("\n\n");
    case "risks":
      return b.items.map((i) => `- ${i.tone === "warn" ? "⚠️" : "ℹ️"} **${i.title}** — ${i.body_md}${cites(i.citations)}`).join("\n");
    case "validation":
      return b.chips.map((c) => `- \`${c.tier}\` ${c.text}${cites(c.supporting_source_indices)}`).join("\n");
    case "source_list":
      return b.sources.map((s) => `${s.n}. [${s.title}](${s.url})`).join("\n");
    case "markdown":
      return b.body_md;
    case "table": {
      const heading = b.title ? `${head(3, b.title, proseOnly)}\n\n` : "";
      const header = `| ${b.columns.map(cell).join(" | ")} |\n| ${b.columns.map(() => "---").join(" | ")} |`;
      const rows = b.rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
      return heading + [header, ...rows].join("\n") + cites(b.citations);
    }
    default: {
      const _exhaustive: never = b;
      void _exhaustive;
      return "";
    }
  }
}

function renderSources(sources: Source[], proseOnly: boolean): string {
  if (!sources.length) return "";
  const label = proseOnly ? "**Sources**" : "## Sources";
  return label + "\n\n" + sources.map((s) => `${s.n}. [${s.title}](${s.url})`).join("\n");
}

export function detectProseOnly(ask: string | undefined | null): boolean {
  if (!ask) return false;
  return /\b(prose[- ]only|no\s+head(?:ing|er)s?|no\s+markdown|without\s+head(?:ing|er)s?|one\s+paragraph|single\s+paragraph)\b/i.test(
    ask,
  );
}

export type RenderResearchOptions = {
  proseOnly?: boolean;
};

export function renderResearchReportMarkdown(report: ResearchReport, opts: RenderResearchOptions = {}): string {
  const proseOnly = opts.proseOnly === true;
  const parts: string[] = [];
  parts.push(proseOnly ? `**${report.title}**` : `# ${report.title}`);
  if (report.subtitle) parts.push(`_${report.subtitle}_`);

  for (const block of report.blocks) {
    const rendered = renderBlock(block, proseOnly).trim();
    if (rendered.length > 0) parts.push(rendered);
  }

  const hasSourceListBlock = report.blocks.some((b) => b.type === "source_list");
  if (!hasSourceListBlock) {
    const src = renderSources(report.sources, proseOnly).trim();
    if (src.length > 0) parts.push(src);
  }

  return stripLeakedJson(parts.join("\n\n").trim());
}

export function renderResearchClarificationMarkdown(
  questions: ReadonlyArray<{ question: string; why?: string }>,
): string {
  const items = questions
    .filter((q) => typeof q?.question === "string" && q.question.trim().length > 0)
    .map((q, i) => {
      const why =
        typeof q.why === "string" && q.why.trim().length > 0
          ? `\n   _${q.why.trim()}_`
          : "";
      return `${i + 1}. ${q.question.trim()}${why}`;
    });
  if (items.length === 0) {
    return "I need a bit more detail before I can research this well — can you say more about what you're after?";
  }
  return [
    "I can dig into this — I just need a bit more to go deep:",
    "",
    items.join("\n"),
  ].join("\n");
}
