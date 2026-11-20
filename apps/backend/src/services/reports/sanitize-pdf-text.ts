
const WINANSI_HIGH_OK: ReadonlySet<number> = new Set([
  0x20ac,
  0x201a,
  0x0192,
  0x201e,
  0x2026,
  0x2020,
  0x2021,
  0x02c6,
  0x2030,
  0x0160,
  0x2039,
  0x0152,
  0x017d,
  0x2018,
  0x2019,
  0x201c,
  0x201d,
  0x2022,
  0x2013,
  0x2014,
  0x02dc,
  0x2122,
  0x0161,
  0x203a,
  0x0153,
  0x017e,
  0x0178,
]);

const PROSE_MAP: ReadonlyMap<number, string> = new Map([
  [0x2265, ">="],
  [0x2264, "<="],
  [0x2260, "!="],
  [0x2248, "~="],
  [0x2192, "->"],
  [0x2190, "<-"],
  [0x2194, "<->"],
  [0x21d2, "=>"],
  [0x21d0, "<="],
  [0x2713, "[x]"],
  [0x2714, "[x]"],
  [0x2717, "[ ]"],
  [0x2718, "[ ]"],
  [0x2212, "-"],
  [0x2033, '"'],
  [0x2032, "'"],
  [0x25b6, ">"],
  [0x25c0, "<"],
  [0x25bc, "v"],
  [0x25b2, "^"],
]);

const MONO_MAP: ReadonlyMap<number, string> = new Map([
  [0x2500, "-"],
  [0x2501, "-"],
  [0x2502, "|"],
  [0x2503, "|"],
  [0x250c, "+"],
  [0x2510, "+"],
  [0x2514, "+"],
  [0x2518, "+"],
  [0x251c, "+"],
  [0x2524, "+"],
  [0x252c, "+"],
  [0x2534, "+"],
  [0x253c, "+"],
  [0x2550, "-"],
  [0x2551, "|"],
  [0x2554, "+"],
  [0x2557, "+"],
  [0x255a, "+"],
  [0x255d, "+"],
  [0x25bc, "v"],
  [0x25b2, "^"],
  [0x25b6, ">"],
  [0x25c0, "<"],
  [0x2192, ">"],
  [0x2190, "<"],
  [0x2191, "^"],
  [0x2193, "v"],
  [0x2265, ">"],
  [0x2264, "<"],
  [0x2713, "x"],
  [0x2717, " "],
]);

const WINANSI_UNDEFINED: ReadonlySet<number> = new Set([
  0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x9d,
]);

function isRenderable(cp: number): boolean {
  if (cp === 0x0a || cp === 0x09) return true;
  if (cp < 0x20) return false;
  if (cp <= 0xff) return !WINANSI_UNDEFINED.has(cp);
  return WINANSI_HIGH_OK.has(cp);
}

let dropCount = 0;

export function takePdfSanitizeDropCount(): number {
  const n = dropCount;
  dropCount = 0;
  return n;
}

function sanitize(
  input: string,
  map: ReadonlyMap<number, string>,
  fallback: (cp: number) => string,
): string {
  if (!input) return input;
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isRenderable(cp)) {
      out += ch;
      continue;
    }
    const mapped = map.get(cp);
    if (mapped !== undefined) {
      out += mapped;
    } else {
      out += fallback(cp);
    }
    dropCount++;
  }
  return out;
}

export function safePdfProseText(input: string): string {
  return sanitize(input, PROSE_MAP, () => " ");
}

export function safePdfMonoText(input: string): string {
  return sanitize(input, MONO_MAP, () => " ");
}

const CAP_TITLE = 200;
const CAP_HEADING = 200;
const CAP_BODY = 10_000;
const CAP_CELL = 500;
const CAP_FOOTER = 500;

function proseClipped(input: string, cap: number): string {
  const out = safePdfProseText(input);
  return out.length <= cap ? out : out.slice(0, cap);
}

export function sanitizeRenderPdfInput<
  T extends {
    title: string;
    footer?: string;
    title_metadata?: { author?: string; subject?: string } | undefined;
    sections: Array<{
      heading: string;
      body_markdown: string;
      preformatted?: string;
      table?: { columns: string[]; rows: string[][] } | undefined;
      [k: string]: unknown;
    }>;
    [k: string]: unknown;
  },
>(input: T): T {
  return {
    ...input,
    title: proseClipped(input.title, CAP_TITLE),
    ...(input.footer !== undefined
      ? { footer: proseClipped(input.footer, CAP_FOOTER) }
      : {}),
    ...(input.title_metadata
      ? {
          title_metadata: {
            ...input.title_metadata,
            ...(input.title_metadata.author !== undefined
              ? { author: safePdfProseText(input.title_metadata.author) }
              : {}),
            ...(input.title_metadata.subject !== undefined
              ? { subject: safePdfProseText(input.title_metadata.subject) }
              : {}),
          },
        }
      : {}),
    sections: input.sections.map((s) => ({
      ...s,
      heading: proseClipped(s.heading, CAP_HEADING),
      body_markdown: proseClipped(s.body_markdown, CAP_BODY),
      ...(s.preformatted !== undefined
        ? { preformatted: safePdfMonoText(s.preformatted) }
        : {}),
      ...(s.table
        ? {
            table: {
              ...s.table,
              columns: s.table.columns.map((c) => proseClipped(c, CAP_CELL)),
              rows: s.table.rows.map((r) =>
                r.map((c) => proseClipped(c, CAP_CELL)),
              ),
            },
          }
        : {}),
    })),
  };
}
