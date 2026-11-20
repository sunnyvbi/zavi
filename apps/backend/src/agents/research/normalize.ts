
import { blockSchema } from "./blocks";
import { stripLeakedJson } from "./clean-prose";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const STRUCTURED_LEAK_KEYS = new Set([
  "stat_tiles",
  "tiles",
  "rows",
  "bars",
  "persona_cards",
]);

const ITEM_TITLE_KEYS = [
  "title",
  "label",
  "name",
  "question",
  "competitor",
  "move",
  "heading",
];
const ITEM_BODY_KEYS = [
  "body_md",
  "answer_md",
  "why_now",
  "commentary_md",
  "body",
  "detail",
  "description",
  "summary",
  "text",
];

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function itemToProse(item: unknown): string | null {
  if (typeof item === "string") return item.trim() ? `- ${item.trim()}` : null;
  if (typeof item === "number" || typeof item === "boolean") return `- ${String(item)}`;
  if (!isPlainObject(item)) return null;

  const lead = firstString(item, ITEM_TITLE_KEYS);
  const body = firstString(item, ITEM_BODY_KEYS);
  if (lead && body) return `- **${lead}** — ${body}`;
  if (lead) return `- **${lead}**`;
  if (body) return `- ${body}`;

  const scalars = Object.entries(item)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(([k, v]) => `${k}: ${String(v)}`);
  return scalars.length > 0 ? `- ${scalars.join(" · ")}` : null;
}

function renderDegradedValue(key: string, value: unknown): string | null {
  if (typeof value === "string") return `- **${key}:** ${value}`;
  if (typeof value === "number" || typeof value === "boolean") {
    return `- **${key}:** ${String(value)}`;
  }
  if (Array.isArray(value)) {
    const lines = value.map(itemToProse).filter((l): l is string => l !== null);
    return lines.length > 0 ? `**${key}**\n\n${lines.join("\n")}` : null;
  }
  if (isPlainObject(value)) {
    const line = itemToProse(value);
    return line ? `**${key}**\n\n${line}` : null;
  }
  return null;
}

function degradeToMarkdown(block: Record<string, unknown>): Record<string, unknown> {
  const { type: _t, title, body_md, prose_md, text, ...rest } = block;
  const prefix = title ? `**${String(title)}**\n\n` : "";
  const passthrough = [body_md, prose_md, text].find((v) => typeof v === "string") as
    | string
    | undefined;
  const body =
    typeof passthrough === "string"
      ? passthrough
      : Object.entries(rest)
          .filter(([k]) => !STRUCTURED_LEAK_KEYS.has(k))
          .map(([k, v]) => renderDegradedValue(k, v))
          .filter((l): l is string => l !== null)
          .join("\n");
  return { type: "markdown", body_md: stripLeakedJson(prefix + body) };
}

function asNumArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "number");
}

function asStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string");
}

const TIER_SYNONYMS: Record<string, "validated" | "inferred" | "assumption" | "high-risk"> = {
  validated: "validated",
  verified: "validated",
  confirmed: "validated",
  supported: "validated",
  inferred: "inferred",
  likely: "inferred",
  partial: "inferred",
  assumption: "assumption",
  assumed: "assumption",
  "high-risk": "high-risk",
  high_risk: "high-risk",
  "high risk": "high-risk",
  risky: "high-risk",
  speculative: "high-risk",
  unsupported: "high-risk",
  unverified: "high-risk",
};

function coerceTier(raw: unknown): "validated" | "inferred" | "assumption" | "high-risk" {
  if (typeof raw !== "string") return "high-risk";
  return TIER_SYNONYMS[raw.trim().toLowerCase()] ?? "high-risk";
}

function asChips(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (!isPlainObject(item)) return item;
    if ("tier" in item && "text" in item) {
      return { ...item, tier: coerceTier(item.tier) };
    }
    return {
      tier: coerceTier(item.status ?? item.tier),
      text: item.claim ?? item.text ?? "",
      supporting_source_indices: asNumArray(item.supporting_source_indices),
    };
  });
}

function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function isContentfulNonObject(v: unknown): boolean {
  return v != null && !(typeof v === "string" && v.trim() === "");
}

function itemHasContent(it: unknown): boolean {
  if (!isPlainObject(it)) return isContentfulNonObject(it);
  return hasText(it.title) || hasText(it.body_md) || hasText(it.text);
}

function recItemHasContent(it: unknown): boolean {
  if (!isPlainObject(it)) return isContentfulNonObject(it);
  return hasText(it.body_md);
}

function cardHasContent(c: unknown): boolean {
  if (!isPlainObject(c)) return isContentfulNonObject(c);
  const meta = c.meta;
  return (
    hasText(c.title) ||
    hasText(c.body_md) ||
    (isPlainObject(meta) && (hasText(meta.label) || hasText(meta.value)))
  );
}

function sanitizeBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  switch (block.type as string) {
    case "recommendations": {
      if (!Array.isArray(block.items)) return block;
      const kept = block.items.filter(recItemHasContent);
      if (kept.length === 0) return null;
      const items = kept.map((it, i) =>
        isPlainObject(it)
          ? {
              ...it,
              index: i + 1,
              label:
                typeof it.label === "string" && /^\d+$/.test(it.label.trim())
                  ? String(i + 1)
                  : it.label,
            }
          : it,
      );
      return { ...block, items };
    }
    case "material_moves": {
      if (!Array.isArray(block.items)) return block;
      const items = block.items.filter(
        (it) => isPlainObject(it) && (hasText(it.move) || hasText(it.why_now)),
      );
      return items.length > 0 ? { ...block, items } : null;
    }
    case "gap_list":
    case "risks": {
      if (!Array.isArray(block.items)) return block;
      const items = block.items.filter(itemHasContent);
      return items.length > 0 ? { ...block, items } : null;
    }
    case "cards_grid": {
      if (!Array.isArray(block.cards)) return block;
      const cards = block.cards.filter(cardHasContent);
      return cards.length > 0 ? { ...block, cards } : null;
    }
    case "markdown":
      return hasText(block.body_md) ? block : null;
    case "validation": {
      if (!Array.isArray(block.chips)) return block;
      const chips = block.chips.filter((c) => (isPlainObject(c) ? hasText(c.text) : true));
      return chips.length > 0 ? { ...block, chips } : null;
    }
    default:
      return block;
  }
}

function normalizeBlock(block: Record<string, unknown>): Record<string, unknown> {
  const type = block.type as string;

  switch (type) {
    case "exec_summary":
    case "summary":
      return {
        type: "exec_summary",
        ...(block.pull_quote !== undefined ? { pull_quote: block.pull_quote } : {}),
        ...(block.stat_tiles !== undefined ? { stat_tiles: block.stat_tiles } : {}),
        prose_md: (block.prose_md as string) ?? (block.body_md as string) ?? "",
        citations: asNumArray(block.citations),
      };

    case "competitive_table": {
      const clamp = (v: unknown, n: number): string =>
        typeof v === "string" ? v.slice(0, n) : "";
      const rows = Array.isArray(block.rows)
        ? block.rows.slice(0, 12).map((row) => {
            if (!isPlainObject(row)) return row;
            const r = row as Record<string, unknown>;
            const out: Record<string, unknown> = {
              ...r,
              positioning: clamp(r.positioning, 600),
              gap: clamp(r.gap, 600),
              citations: asNumArray(r.citations),
            };
            if (typeof r.brand === "string") out.brand = r.brand.slice(0, 200);
            if (typeof r.price === "string") out.price = r.price.slice(0, 120);
            return out;
          })
        : [];
      return { ...block, type: "competitive_table", rows };
    }

    case "comparison_table":
    case "table":
    case "comparison":
      return {
        type: "table",
        ...(block.title !== undefined ? { title: block.title } : {}),
        columns: asStrArray(block.columns),
        rows: Array.isArray(block.rows)
          ? block.rows.map((row) => {
              if (Array.isArray(row)) return row.map((cell) => String(cell));
              if (isPlainObject(row)) {
                const cols = asStrArray(block.columns);
                const keys =
                  cols.length > 0
                    ? cols
                    : Object.keys(row).filter((k) => k !== "citations" && k !== "type");
                return keys.map((k) => String(row[k] ?? ""));
              }
              return [];
            })
          : [],
        citations: asNumArray(block.citations),
      };

    case "markdown":
    case "prose":
    case "text": {
      const bodyParts: string[] = [];
      if (block.title) bodyParts.push(`**${block.title}**\n\n`);
      bodyParts.push((block.body_md as string) ?? (block.prose_md as string) ?? "");
      return { type: "markdown", body_md: stripLeakedJson(bodyParts.join("")) };
    }

    case "validation": {
      const rawItems = block.chips ?? block.items;
      return { type: "validation", chips: asChips(rawItems) };
    }

    case "recommendations": {
      const items = Array.isArray(block.items)
        ? block.items.map((it, i) => {
            if (!isPlainObject(it)) return it;
            return {
              index: typeof it.index === "number" ? it.index : i + 1,
              label: typeof it.label === "string" ? it.label : String(i + 1),
              title: typeof it.title === "string" ? it.title : "",
              body_md: (it.body_md as string) ?? (it.text as string) ?? "",
              citations: asNumArray(it.citations),
            };
          })
        : [];
      return { type: "recommendations", items };
    }

    case "material_moves": {
      const items = Array.isArray(block.items)
        ? block.items.map((it) => {
            if (!isPlainObject(it)) return it;
            return {
              competitor: typeof it.competitor === "string" ? it.competitor : "",
              move: (it.move as string) ?? (it.change as string) ?? "",
              why_now: (it.why_now as string) ?? (it.why as string) ?? "",
              citations: asNumArray(it.citations),
            };
          })
        : [];
      return { type: "material_moves", items };
    }

    case "hero":
    case "stat_tiles":
    case "persona_cards":
    case "qa_grid":
    case "theme_bars":
    case "sentiment_meter":
    case "cards_grid":
    case "gap_list":
    case "risks":
    case "source_list":
      return block;

    default:
      return degradeToMarkdown(block);
  }
}

export function normalizeRawResearchEnvelope(raw: unknown): unknown {
  try {
    if (!isPlainObject(raw)) return raw;
    const kind = raw.kind;

    if (kind === "clarification") {
      if (!Array.isArray(raw.questions)) return raw;
      const CAP = 400;
      const clamp = (v: unknown): unknown =>
        typeof v === "string" && v.length > CAP ? v.slice(0, CAP) : v;
      const questions = raw.questions.map((q) =>
        isPlainObject(q) ? { ...q, question: clamp(q.question), why: clamp(q.why) } : q,
      );
      return { ...raw, questions };
    }

    if (kind !== "report") return raw;

    const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : [];
    const blocks = rawBlocks
      .map((b) => {
        if (!isPlainObject(b)) return b;
        const mapped = normalizeBlock(b as Record<string, unknown>);
        const sanitized = sanitizeBlock(mapped);
        if (sanitized === null) return null;
        return blockSchema.safeParse(sanitized).success
          ? sanitized
          : degradeToMarkdown(b as Record<string, unknown>);
      })
      .filter((b) => b !== null);

    const validation = asChips(raw.validation).filter((c) =>
      isPlainObject(c) ? hasText(c.text) : true,
    );

    const rawLenses = Array.isArray(raw.lenses) ? raw.lenses : [];
    const lenses = rawLenses.map((lens) => {
      if (!isPlainObject(lens)) return lens;
      const provenance = lens.provenance;
      if (!isPlainObject(provenance)) return lens;
      const fe = provenance.fetch_errors;
      const fetch_errors = Array.isArray(fe)
        ? fe.length
        : typeof fe === "number"
        ? fe
        : 0;
      return {
        ...lens,
        provenance: { ...provenance, fetch_errors },
      };
    });

    return {
      ...raw,
      blocks,
      validation,
      lenses,
      failed_lenses: asStrArray(raw.failed_lenses),
      generated_at:
        typeof raw.generated_at === "string" && raw.generated_at.trim()
          ? raw.generated_at
          : new Date().toISOString(),
      sources: Array.isArray(raw.sources) ? raw.sources : [],
    };
  } catch {
    return raw;
  }
}
