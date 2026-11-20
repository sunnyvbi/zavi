
import { z } from "zod";
import { DEFAULT_BLOG_THEME, type BlogTheme } from "./brand-theme";

const MAX_TITLE = 300;
const MAX_BODY_BYTES = 100 * 1024;
const MAX_HERO_IMAGES = 3;

const heroImageSchema = z.object({
  url: z.string().min(1),
  alt: z.string().max(300).optional(),
});

export const renderBlogHtmlInputSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE),
  subtitle: z.string().max(500).optional(),
  body: z
    .string()
    .min(1)
    .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_BODY_BYTES, {
      message: `body exceeds ${MAX_BODY_BYTES} bytes`,
    }),
  heroImages: z.array(heroImageSchema).max(MAX_HERO_IMAGES).optional(),
  readTimeMinutes: z.number().int().positive().max(120).optional(),
});
export type RenderBlogHtmlInput = z.infer<typeof renderBlogHtmlInputSchema>;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function renderInline(raw: string): string {
  let out = "";
  let i = 0;
  const line = raw;
  while (i < line.length) {
    const code = /^`([^`]+)`/.exec(line.slice(i));
    if (code) {
      out += `<code>${escapeHtml(code[1])}</code>`;
      i += code[0].length;
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(line.slice(i));
    if (link) {
      const text = renderInline(link[1]);
      const href = safeUrl(link[2]);
      if (href) {
        out += `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${text}</a>`;
      } else {
        out += text;
      }
      i += link[0].length;
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*/.exec(line.slice(i));
    if (bold) {
      out += `<strong>${renderInline(bold[1])}</strong>`;
      i += bold[0].length;
      continue;
    }
    out += escapeHtml(line[i]);
    i += 1;
  }
  return out;
}

const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*```\s*([A-Za-z0-9+#._-]{0,20})\s*$/;
const FENCE_END = /^\s*```\s*$/;
const TABLE_DIVIDER = /^\s*\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-{1,}:?\s*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function alignments(divider: string): Array<"l" | "c" | "r"> {
  return splitRow(divider).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "c";
    if (right) return "r";
    return "l";
  });
}

function renderTable(rows: string[], divider: string): string {
  const align = alignments(divider);
  const cell = (text: string, index: number, tag: "th" | "td") =>
    `<${tag} class="ta-${align[index] ?? "l"}">${renderInline(text)}</${tag}>`;
  const [head, ...body] = rows;
  const thead = `<thead><tr>${splitRow(head).map((c, i) => cell(c, i, "th")).join("")}</tr></thead>`;
  const tbody = body.length
    ? `<tbody>${body
        .map((row) => `<tr>${splitRow(row).map((c, i) => cell(c, i, "td")).join("")}</tr>`)
        .join("")}</tbody>`
    : "";
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

function renderBody(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listItems.length) {
      const tag = listOrdered ? "ol" : "ul";
      blocks.push(`<${tag}>${listItems.join("")}</${tag}>`);
      listItems = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      const language = fence[1].toLowerCase();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_END.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      const className = language ? ` class="language-${escapeHtml(language)}"` : "";
      blocks.push(
        `<pre><code${className}>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    if (!trimmed) {
      flushAll();
      continue;
    }

    if (RULE.test(line)) {
      flushAll();
      blocks.push("<hr />");
      continue;
    }

    if (
      trimmed.includes("|") &&
      i + 1 < lines.length &&
      TABLE_DIVIDER.test(lines[i + 1])
    ) {
      flushAll();
      const divider = lines[i + 1];
      const rows = [trimmed];
      i += 2;
      while (i < lines.length && lines[i].trim().includes("|")) {
        rows.push(lines[i].trim());
        i += 1;
      }
      i -= 1;
      blocks.push(renderTable(rows, divider));
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const blockquote = /^>\s?(.*)$/.exec(trimmed);
    if (blockquote) {
      flushParagraph();
      flushList();
      quote.push(blockquote[1]);
      continue;
    }

    const ordered = /^(\d+)\.\s+(.*)$/.exec(trimmed);
    const unordered = /^[-*]\s+(.*)$/.exec(trimmed);
    if (ordered || unordered) {
      flushParagraph();
      flushQuote();
      const wantOrdered = Boolean(ordered);
      if (listItems.length && wantOrdered !== listOrdered) flushList();
      listOrdered = wantOrdered;
      const itemText = ordered ? ordered[2] : unordered![1];
      listItems.push(`<li>${renderInline(itemText)}</li>`);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }
  flushAll();
  return blocks.filter(
    (block, index) => !(block === "<hr />" && blocks[index + 1]?.startsWith("<h")),
  );
}

function renderFigure(
  img: NonNullable<RenderBlogHtmlInput["heroImages"]>[number],
  className: string,
): string {
  const src = safeUrl(img.url);
  if (!src) return "";
  const alt = escapeHtml(img.alt ?? "");
  return `<figure class="${className}"><img src="${escapeHtml(src)}" alt="${alt}" loading="lazy" /></figure>`;
}

function composeBody(
  blocks: string[],
  heroImages: RenderBlogHtmlInput["heroImages"],
): { hero: string; body: string } {
  const images = (heroImages ?? []).filter((img) => safeUrl(img.url));
  if (!images.length) return { hero: "", body: blocks.join("\n") };

  const hero = renderFigure(images[0], "hero");
  const rest = images.slice(1);
  if (!rest.length) return { hero, body: blocks.join("\n") };

  const slots = blocks
    .map((block, index) => (/^<h[12]>/.test(block) ? index : -1))
    .filter((index) => index > 0);

  if (!slots.length) {
    return {
      hero: hero + rest.map((img) => renderFigure(img, "hero")).join("\n"),
      body: blocks.join("\n"),
    };
  }

  const step = slots.length / (rest.length + 1);
  const chosen = new Map<number, string>();
  const leftover: string[] = [];
  rest.forEach((img, i) => {
    const want = Math.min(slots.length - 1, Math.max(0, Math.round(step * (i + 1)) - 1));
    let slot: number | undefined = slots[want];
    while (slot !== undefined && chosen.has(slot)) {
      const from: number = slot;
      slot = slots.find((candidate) => candidate > from && !chosen.has(candidate));
    }
    if (slot === undefined) leftover.push(renderFigure(img, "hero"));
    else chosen.set(slot, renderFigure(img, "inline"));
  });

  const out: string[] = [];
  blocks.forEach((block, index) => {
    const figure = chosen.get(index);
    if (figure) out.push(figure);
    out.push(block);
  });
  return { hero: hero + leftover.join("\n"), body: out.join("\n") };
}

export function renderBlogHtml(
  input: RenderBlogHtmlInput,
  theme: BlogTheme = DEFAULT_BLOG_THEME,
): string {
  const parsed = renderBlogHtmlInputSchema.parse(input);
  const title = escapeHtml(parsed.title);
  const subtitle = parsed.subtitle ? escapeHtml(parsed.subtitle) : "";
  const byline = parsed.readTimeMinutes
    ? `${parsed.readTimeMinutes} min read`
    : "";
  const { hero: gallery, body } = composeBody(renderBody(parsed.body), parsed.heroImages);

  const css = `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; background: ${theme.paper}; color: ${theme.ink};
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
      line-height: 1.65; }
    .wrap { max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; }
    h1 { font-size: 40px; line-height: 1.1; letter-spacing: -0.5px; margin: 0 0 12px; }
    .subtitle { font-size: 19px; color: ${theme.slate}; margin: 0 0 8px; }
    .byline { font-size: 14px; color: ${theme.slate}; margin: 0 0 28px;
      padding-bottom: 20px; border-bottom: 1px solid ${theme.mist}; }
    figure.hero { margin: 0 0 32px; }
    /* In-body images breathe on both sides — they interrupt the reading, so
       they need more room above than a paragraph does. */
    figure.inline { margin: 36px 0 32px; }
    figure.hero img, figure.inline img { width: 100%; height: auto;
      border-radius: 12px; display: block; }
    h2 { font-size: 26px; margin: 36px 0 12px; padding-top: 4px; }
    h2::before { content: ""; display: block; width: 40px; height: 3px;
      background: ${theme.accent}; margin-bottom: 14px; border-radius: 2px; }
    h3 { font-size: 20px; margin: 28px 0 8px; }
    p { margin: 0 0 18px; font-size: 17px; }
    a { color: ${theme.accentText}; }
    ul, ol { margin: 0 0 18px; padding-left: 22px; }
    li { margin: 0 0 8px; font-size: 17px; }
    strong { color: ${theme.ink}; }
    blockquote { margin: 0 0 18px; padding: 2px 0 2px 18px;
      border-left: 3px solid ${theme.accent}; color: ${theme.slate}; font-size: 17px; }
    hr { border: 0; border-top: 1px solid ${theme.mist}; margin: 36px 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.88em; background: ${theme.cloud}; border: 1px solid ${theme.mist};
      border-radius: 4px; padding: 1px 5px; }
    pre { margin: 0 0 22px; padding: 16px 18px; background: ${theme.cloud};
      border: 1px solid ${theme.mist}; border-radius: 10px; overflow-x: auto; }
    pre code { display: block; background: none; border: 0; padding: 0;
      font-size: 13.5px; line-height: 1.6; white-space: pre; color: ${theme.ink}; }
    .table-wrap { overflow-x: auto; margin: 0 0 24px; }
    table { border-collapse: collapse; width: 100%; font-size: 15px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid ${theme.mist};
      text-align: left; vertical-align: top; }
    th { background: ${theme.cloud}; font-weight: 600; white-space: nowrap; }
    .ta-c { text-align: center; }
    .ta-r { text-align: right; }
    .footer { margin-top: 48px; padding-top: 20px; border-top: 1px solid ${theme.mist};
      font-size: 13px; color: ${theme.slate}; }
    @media (max-width: 600px) { h1 { font-size: 30px; } .wrap { padding: 32px 18px 60px; } }
  `.trim();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<article class="wrap">
<h1>${title}</h1>
${subtitle ? `<p class="subtitle">${subtitle}</p>` : ""}
${byline ? `<p class="byline">${byline}</p>` : `<div class="byline"></div>`}
${gallery}
${body}
<div class="footer">Drafted by your Content Designer · review before publishing.</div>
</article>
</body>
</html>`;
}
