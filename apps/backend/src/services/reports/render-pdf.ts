
import PDFDocument from "pdfkit";
import {
  renderPdfInputSchema,
  type RenderPdfInput,
} from "./schema";
import {
  sanitizeRenderPdfInput,
  takePdfSanitizeDropCount,
} from "./sanitize-pdf-text";
import { detectInternalMarkers } from "./internal-marker-lint";
import { DEFAULT_REPORT_THEME, type ReportTheme } from "./brand-theme";

const RENDER_TIMEOUT_MS = 15_000;

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const USABLE_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const TABLE_FONT_SIZE = 10;
const TABLE_ROW_HEIGHT_LINES_CAP = 6;
const BODY_FONT_SIZE = 10.5;
const MONO_FONT_SIZE = 8;
const MONO_LINE_HEIGHT = MONO_FONT_SIZE + 2;

const BAND_HEIGHT = 80;
const FOOTER_BASELINE = 34;

export type InlineToken = { text: string; bold: boolean };

export function parseInlineBold(line: string): InlineToken[] {
  const out: InlineToken[] = [];
  let buf = "";
  let inBold = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "*" && line[i + 1] === "*") {
      if (buf.length > 0) {
        out.push({ text: buf, bold: inBold });
        buf = "";
      }
      inBold = !inBold;
      i += 2;
      continue;
    }
    buf += line[i];
    i += 1;
  }
  if (inBold) {
    return [{ text: line, bold: false }];
  }
  if (buf.length > 0) {
    out.push({ text: buf, bold: false });
  }
  return collapse(out);
}

function collapse(tokens: InlineToken[]): InlineToken[] {
  if (tokens.length === 0) return tokens;
  const out: InlineToken[] = [tokens[0]];
  for (let i = 1; i < tokens.length; i++) {
    const last = out[out.length - 1];
    if (last.bold === tokens[i].bold) {
      last.text += tokens[i].text;
    } else {
      out.push(tokens[i]);
    }
  }
  return out;
}

export type Block =
  | { kind: "paragraph"; tokens: InlineToken[] }
  | { kind: "bullet"; tokens: InlineToken[] };

export function parseBlocks(body: string): Block[] {
  const paragraphs = body.split(/\n\s*\n/);
  const blocks: Block[] = [];
  for (const para of paragraphs) {
    const trimmed = para.replace(/\s+$/g, "");
    if (trimmed.length === 0) continue;
    const lines = trimmed.split("\n");
    const allBullets = lines.every((l) => /^\s*[-*]\s+/.test(l));
    if (allBullets) {
      for (const l of lines) {
        const text = l.replace(/^\s*[-*]\s+/, "");
        blocks.push({ kind: "bullet", tokens: parseInlineBold(text) });
      }
    } else {
      const joined = lines.join(" ").replace(/\s+/g, " ").trim();
      blocks.push({ kind: "paragraph", tokens: parseInlineBold(joined) });
    }
  }
  return blocks;
}

const IMAGE_MAX_HEIGHT = 260;

async function innerRender(
  input: RenderPdfInput,
  theme: ReportTheme,
  resolvedImages?: Array<Buffer | null | undefined>,
  embedded?: boolean[],
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    try {
      const info: PDFKit.DocumentInfo = { Title: input.title };
      if (input.title_metadata?.author) info.Author = input.title_metadata.author;
      if (input.title_metadata?.subject) info.Subject = input.title_metadata.subject;
      const doc = new PDFDocument({
        size: "LETTER",
        margin: PAGE_MARGIN,
        info,
        bufferPages: true,
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      doc.on("error", (e: Error) => reject(e));

      const TITLE_TOP = 38;
      const TITLE_BOTTOM_PAD = 16;
      const TITLE_FONT_MAX = 21;
      const TITLE_FONT_MIN = 15;
      const TITLE_MAX_LINES = 2;
      let titleFs = TITLE_FONT_MAX;
      doc.font("Helvetica-Bold").fontSize(titleFs);
      let titleH = doc.heightOfString(input.title, { width: USABLE_WIDTH });
      while (
        titleFs > TITLE_FONT_MIN &&
        titleH > doc.currentLineHeight() * TITLE_MAX_LINES + 0.5
      ) {
        titleFs -= 1;
        doc.fontSize(titleFs);
        titleH = doc.heightOfString(input.title, { width: USABLE_WIDTH });
      }
      const titleBoxH = Math.min(
        titleH,
        doc.currentLineHeight() * TITLE_MAX_LINES,
      );
      const bandHeight = Math.max(
        BAND_HEIGHT,
        TITLE_TOP + titleBoxH + TITLE_BOTTOM_PAD,
      );

      doc.save().rect(0, 0, PAGE_WIDTH, bandHeight).fill(theme.ink).restore();
      doc
        .font("Helvetica-Bold")
        .fontSize(titleFs)
        .fillColor(theme.paper)
        .text(input.title, PAGE_MARGIN, TITLE_TOP, {
          width: USABLE_WIDTH,
          align: "left",
          height: titleBoxH + 2,
          ellipsis: true,
          lineBreak: true,
        });
      doc
        .save()
        .rect(0, bandHeight - 3, PAGE_WIDTH, 3)
        .fill(theme.bandRule)
        .restore();

      doc.fillColor(theme.ink);
      doc.x = PAGE_MARGIN;
      doc.y = bandHeight + 24;

      for (let i = 0; i < input.sections.length; i++) {
        const s = input.sections[i];
        if (i > 0) doc.moveDown(0.7);
        if (doc.y > PAGE_HEIGHT - PAGE_MARGIN - 60) doc.addPage();
        doc
          .font("Helvetica-Bold")
          .fontSize(13)
          .fillColor(theme.ink)
          .text(s.heading, PAGE_MARGIN, doc.y, { width: USABLE_WIDTH });
        doc
          .save()
          .strokeColor(theme.accentRule)
          .lineWidth(2)
          .moveTo(PAGE_MARGIN, doc.y + 2)
          .lineTo(PAGE_MARGIN + 40, doc.y + 2)
          .stroke()
          .restore();
        doc.moveDown(0.5);
        doc.fillColor(theme.ink);

        const blocks = parseBlocks(s.body_markdown);
        for (const block of blocks) {
          if (block.kind === "paragraph") {
            renderInlineTokens(doc, block.tokens, { bullet: false }, theme);
            doc.moveDown(0.35);
          } else {
            renderInlineTokens(doc, block.tokens, { bullet: true }, theme);
          }
        }

        if (s.preformatted) {
          doc.moveDown(0.45);
          drawPreformatted(doc, s.preformatted, theme);
        }

        const img = resolvedImages?.[i];
        if (img && img.byteLength > 0) {
          try {
            if (doc.y + IMAGE_MAX_HEIGHT > PAGE_HEIGHT - PAGE_MARGIN) {
              doc.addPage();
            } else {
              doc.moveDown(0.55);
            }
            doc.image(img, PAGE_MARGIN, doc.y, {
              fit: [USABLE_WIDTH, IMAGE_MAX_HEIGHT],
              align: "center",
            });
            if (embedded) embedded[i] = true;
            doc.y += IMAGE_MAX_HEIGHT + 8;
            doc.x = PAGE_MARGIN;
          } catch {
          }
        }

        if (s.table) {
          doc.moveDown(0.55);
          drawTable(doc, s.table.columns, s.table.rows, theme);
        }
      }

      const range = doc.bufferedPageRange();
      const footerText = input.footer ?? "";
      const fy = PAGE_HEIGHT - FOOTER_BASELINE;
      for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc
          .save()
          .strokeColor(theme.mist)
          .lineWidth(0.5)
          .moveTo(PAGE_MARGIN, fy - 7)
          .lineTo(PAGE_MARGIN + USABLE_WIDTH, fy - 7)
          .stroke()
          .restore();
        doc.font("Helvetica").fontSize(8).fillColor(theme.slate);
        if (footerText) {
          doc.text(footerText, PAGE_MARGIN, fy, {
            width: USABLE_WIDTH * 0.7,
            align: "left",
            lineBreak: false,
            ellipsis: true,
          });
        }
        doc.text(
          `Page ${p - range.start + 1} of ${range.count}`,
          PAGE_MARGIN,
          fy,
          { width: USABLE_WIDTH, align: "right", lineBreak: false },
        );
        doc.page.margins.bottom = savedBottom;
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

function renderInlineTokens(
  doc: PDFKit.PDFDocument,
  tokens: InlineToken[],
  opts: { bullet: boolean },
  theme: ReportTheme,
): void {
  const bulletIndent = 16;
  doc.fontSize(BODY_FONT_SIZE).fillColor(theme.ink);
  const startX = opts.bullet ? PAGE_MARGIN + bulletIndent : PAGE_MARGIN;
  if (opts.bullet) {
    doc
      .font("Helvetica-Bold")
      .fillColor(theme.accentRule)
      .text("•  ", startX, doc.y, {
        continued: true,
        width: USABLE_WIDTH - bulletIndent,
      });
    doc.fillColor(theme.ink);
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    doc.font(t.bold ? "Helvetica-Bold" : "Helvetica").fillColor(theme.ink);
    const isLast = i === tokens.length - 1;
    if (opts.bullet) {
      doc.text(t.text, { continued: !isLast });
    } else {
      doc.text(t.text, isLast ? undefined : { continued: true });
    }
  }
  if (tokens.length === 0) {
    doc.text("");
  }
  doc.x = PAGE_MARGIN;
}

function drawPreformatted(doc: PDFKit.PDFDocument, text: string, theme: ReportTheme): void {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
  doc.font("Courier").fontSize(MONO_FONT_SIZE).fillColor(theme.ink);
  for (const line of lines) {
    if (doc.y + MONO_LINE_HEIGHT > PAGE_HEIGHT - PAGE_MARGIN) {
      doc.addPage();
      doc.font("Courier").fontSize(MONO_FONT_SIZE).fillColor(theme.ink);
    }
    doc.text(line.length === 0 ? " " : line, PAGE_MARGIN, doc.y, {
      width: USABLE_WIDTH,
      align: "left",
      lineBreak: false,
      lineGap: MONO_LINE_HEIGHT - doc.currentLineHeight(),
    });
  }
  doc.font("Helvetica").fontSize(BODY_FONT_SIZE).fillColor(theme.ink);
  doc.x = PAGE_MARGIN;
}

function drawTable(
  doc: PDFKit.PDFDocument,
  columns: string[],
  rows: string[][],
  theme: ReportTheme,
): void {
  const fs = TABLE_FONT_SIZE;
  const lineH = fs + 4;
  const padX = 6;
  const padY = 5;
  const maxTextH = lineH * TABLE_ROW_HEIGHT_LINES_CAP;

  const MIN_COL = 46;
  const allRows = [columns, ...rows];
  const damped = columns.map((_, ci) => {
    let maxLen = 1;
    for (const r of allRows) {
      const len = String(r[ci] ?? "").length;
      if (len > maxLen) maxLen = len;
    }
    return Math.sqrt(maxLen);
  });
  const dampSum = damped.reduce((a, b) => a + b, 0) || 1;
  let widths = damped.map((w) =>
    Math.max(MIN_COL, (w / dampSum) * USABLE_WIDTH),
  );
  const wSum = widths.reduce((a, b) => a + b, 0);
  widths = widths.map((w) => (w / wSum) * USABLE_WIDTH);
  const xOff: number[] = [];
  {
    let acc = 0;
    for (const w of widths) {
      xOff.push(acc);
      acc += w;
    }
  }

  const rowTextHeight = (cells: string[], font: string): number => {
    doc.font(font).fontSize(fs);
    let h = lineH;
    for (let ci = 0; ci < cells.length; ci++) {
      const ch = doc.heightOfString(String(cells[ci] ?? ""), {
        width: widths[ci] - padX * 2,
      });
      if (ch > h) h = ch;
    }
    return Math.min(h, maxTextH);
  };

  const drawRow = (cells: string[], header: boolean, bodyIdx: number): void => {
    const font = header ? "Helvetica-Bold" : "Helvetica";
    const rowH = rowTextHeight(cells, font) + padY * 2;
    if (doc.y + rowH > PAGE_HEIGHT - PAGE_MARGIN) {
      doc.addPage();
    }
    const top = doc.y;
    const fill = header ? theme.ink : bodyIdx % 2 === 1 ? theme.cloud : null;
    if (fill) {
      doc.save().rect(PAGE_MARGIN, top, USABLE_WIDTH, rowH).fill(fill).restore();
    }
    doc.font(font).fontSize(fs).fillColor(header ? theme.paper : theme.ink);
    cells.forEach((cell, i) => {
      doc.text(String(cell ?? ""), PAGE_MARGIN + xOff[i] + padX, top + padY, {
        width: widths[i] - padX * 2,
        height: maxTextH,
        ellipsis: true,
      });
    });
    if (!header) {
      doc
        .save()
        .strokeColor(theme.mist)
        .lineWidth(0.5)
        .moveTo(PAGE_MARGIN, top + rowH)
        .lineTo(PAGE_MARGIN + USABLE_WIDTH, top + rowH)
        .stroke()
        .restore();
    }
    doc.x = PAGE_MARGIN;
    doc.y = top + rowH;
  };

  drawRow(columns, true, 0);
  rows.forEach((row, i) => drawRow(row, false, i));
  doc.x = PAGE_MARGIN;
  doc.fillColor(theme.ink);
}

export class PdfRenderError extends Error {
  constructor(
    public readonly code: "pdf_render_failed" | "pdf_render_timeout",
    message: string,
  ) {
    super(message);
    this.name = "PdfRenderError";
  }
}

export async function renderPdf(
  input: RenderPdfInput,
  resolvedImages?: Array<Buffer | null | undefined>,
  embedded?: boolean[],
  theme: ReportTheme = DEFAULT_REPORT_THEME,
): Promise<Uint8Array> {
  const parsed = renderPdfInputSchema.parse(input);

  takePdfSanitizeDropCount();
  const validated = sanitizeRenderPdfInput(parsed);
  const sanitizeDrops = takePdfSanitizeDropCount();
  if (sanitizeDrops > 0) {
    console.warn(
      `[render-pdf] sanitized ${sanitizeDrops} unrenderable character(s) in "${parsed.filename}"`,
    );
  }

  const leaks = detectInternalMarkers(validated);
  if (leaks.length > 0) {
    console.warn(
      `[render-pdf] ${leaks.length} internal-marker hit(s) in "${parsed.filename}" — operator-only content may be in a customer-facing document: ` +
        leaks
          .map((h) => `${h.kind}@${h.location} ("${h.excerpt}")`)
          .join(" | "),
    );
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      innerRender(validated, theme, resolvedImages, embedded),
      new Promise<Uint8Array>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new PdfRenderError(
              "pdf_render_timeout",
              `pdf render exceeded ${RENDER_TIMEOUT_MS}ms (best-effort timeout)`,
            ),
          );
        }, RENDER_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    if (e instanceof PdfRenderError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new PdfRenderError(
      "pdf_render_failed",
      msg.slice(0, 300),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
