
export interface InternalMarkerHit {
  kind: string;
  excerpt: string;
  location: string;
}

interface MarkerRule {
  kind: string;
  pattern: RegExp;
}

const RULES: readonly MarkerRule[] = [
  {
    kind: "win_probability",
    pattern: /\bwin[\s_-]?(probability|band|likelihood)\b/i,
  },
  {
    kind: "fight_accept_recommendation",
    pattern:
      /\brecommendation\s*[:=]\s*(fight|accept)\b|(?:dispute|chargeback|stripe|win[\s_-]?(band|probability)|reason\s+code)[\s\S]{0,200}?\brecommend\s+(accepting|fighting)\b|\brecommend\s+(accepting|fighting)\b[\s\S]{0,200}?(?:dispute|chargeback|stripe|win[\s_-]?(band|probability)|reason\s+code)/i,
  },
  {
    kind: "not_for_submission_marker",
    pattern:
      /\bnot\s+for\s+(stripe\s+)?submission\b|\binternal\s+(review\s+)?only\b|\bdo\s+not\s+(include|submit)\b[^.\n]{0,40}\b(this|in|to)\b|\bdo\s+not\s+submit\s+to\s+stripe\b/i,
  },
  {
    kind: "self_directed_instruction",
    pattern: /\bdo\s+not\s+claim\b|\bdo\s+NOT\s+fill\b|\bleave\s+.{0,20}\bempty\b/i,
  },
  {
    kind: "tool_or_connector_status",
    pattern:
      /\b(operator\s+db|connector|mcp|stripe|slack|github|integration|api)\b[^.\n]{0,40}\b(not\s+connected|is\s+(down|unavailable|missing))\b|\bapproval\s+channel\s+unavailable\b|\b(call|read|retrieval|lookup)\s+was\s+blocked\b|\bcould\s+NOT\s+be\s+read\b|\bmanual\s+evidence\s+assembly\s+required\b/i,
  },
  {
    kind: "operator_task_list",
    pattern:
      /\bnext\s+steps?\s+for\s+the\s+operator\b|\bpaste\s+(this\s+)?into\s+(the\s+)?dashboard\b|\blog\s+into\s+(the\s+)?stripe\s+dashboard\b/i,
  },
  {
    kind: "agent_self_reference",
    pattern:
      /\bno\s+agent\s+action\s+has\s+been\s+taken\b|\bthis\s+(pdf|document)\s+is\s+a\s+review\s+draft\b/i,
  },
];

function excerptAround(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + len + 30);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

function scan(text: string, location: string, out: InternalMarkerHit[]): void {
  if (!text) return;
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (m) {
      out.push({
        kind: rule.kind,
        excerpt: excerptAround(text, m.index, m[0].length),
        location,
      });
    }
  }
}

export function detectInternalMarkers(input: {
  title: string;
  footer?: string;
  sections: Array<{
    heading: string;
    body_markdown: string;
    preformatted?: string;
    table?: { columns: string[]; rows: string[][] } | undefined;
    logo_spec?: { elements?: Array<Record<string, unknown>> } | undefined;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}): InternalMarkerHit[] {
  const hits: InternalMarkerHit[] = [];
  scan(input.title, "title", hits);
  if (input.footer) scan(input.footer, "footer", hits);
  input.sections.forEach((s, i) => {
    scan(s.heading, `section[${i}].heading`, hits);
    scan(s.body_markdown, `section[${i}].body`, hits);
    if (s.preformatted) scan(s.preformatted, `section[${i}].preformatted`, hits);
    if (s.table) {
      scan(s.table.columns.join(" | "), `section[${i}].table.columns`, hits);
      s.table.rows.forEach((r, ri) =>
        scan(r.join(" | "), `section[${i}].table.row[${ri}]`, hits),
      );
    }
    const els = s.logo_spec?.elements;
    if (Array.isArray(els)) {
      els.forEach((el, ei) => {
        if (el && el.type === "text" && typeof el.content === "string") {
          scan(el.content, `section[${i}].logo_spec.elements[${ei}].content`, hits);
        }
      });
    }
  });
  return hits;
}
