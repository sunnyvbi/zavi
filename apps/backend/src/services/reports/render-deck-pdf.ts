
import PDFDocument from "pdfkit";
import {
  renderDeckInputSchema,
  resolveLayout,
  type RenderDeckInput,
  type DeckSlide,
} from "./deck-schema";
import { safePdfProseText } from "./sanitize-pdf-text";
import { DEFAULT_DECK_THEME, type DeckTheme } from "./brand-theme";

const SLIDE_W = 960;
const SLIDE_H = 540;
const MARGIN_X = 68;
const MARGIN_TOP = 56;
const MARGIN_BOTTOM = 52;
const CONTENT_W = SLIDE_W - MARGIN_X * 2;
const RENDER_TIMEOUT_MS = 15_000;

export class DeckRenderError extends Error {
  constructor(
    public readonly code: "deck_render_failed" | "deck_render_timeout",
    message: string,
  ) {
    super(message);
    this.name = "DeckRenderError";
  }
}

type Doc = PDFKit.PDFDocument;

function fitFontSize(
  doc: Doc,
  text: string,
  font: string,
  width: number,
  maxSize: number,
  minSize: number,
  maxLines: number,
): number {
  for (let s = maxSize; s > minSize; s -= 1) {
    doc.font(font).fontSize(s);
    const h = doc.heightOfString(text, { width, lineGap: 0 });
    if (h <= doc.currentLineHeight(true) * maxLines + 0.5) return s;
  }
  doc.font(font).fontSize(minSize);
  return minSize;
}

const BULLET_DOT_R = 4;
const BULLET_INDENT = 20;

function measureBullets(doc: Doc, items: string[], width: number, size: number): number {
  doc.font("Helvetica").fontSize(size);
  let h = 0;
  for (const raw of items) {
    h +=
      doc.heightOfString(safePdfProseText(raw), { width: width - BULLET_INDENT, lineGap: 1 }) +
      Math.max(9, size * 0.6);
  }
  return h;
}

function drawBullets(doc: Doc, items: string[], x: number, y: number, width: number, size: number, theme: DeckTheme): number {
  let cy = y;
  for (const raw of items) {
    const text = safePdfProseText(raw);
    doc.font("Helvetica").fontSize(size).fillColor(theme.ink);
    const h = doc.heightOfString(text, { width: width - BULLET_INDENT, lineGap: 1 });
    doc.circle(x + BULLET_DOT_R, cy + size * 0.52, BULLET_DOT_R).fill(theme.accent);
    doc
      .fillColor(theme.ink)
      .text(text, x + BULLET_INDENT, cy, { width: width - BULLET_INDENT, lineGap: 1 });
    cy += h + Math.max(9, size * 0.6);
  }
  return cy;
}

const MAX_BLOCK_DROP = 60;
export function blockTop(top: number, available: number, blockH: number): number {
  return top + Math.min(MAX_BLOCK_DROP, Math.max(0, (available - blockH) * 0.42));
}

export function drawSlide(
  doc: Doc,
  slide: DeckSlide,
  index: number,
  total: number,
  footer: string | undefined,
  theme: DeckTheme = DEFAULT_DECK_THEME,
): void {
  const layout = resolveLayout(slide, index);
  const heading = safePdfProseText(slide.heading);
  const sub = slide.subheading ? safePdfProseText(slide.subheading) : "";
  const body = slide.body ? safePdfProseText(slide.body) : "";

  doc.rect(0, 0, SLIDE_W, SLIDE_H).fill(theme.cream);

  if (layout === "title" || layout === "statement") {
    const isTitle = layout === "title";
    const w = CONTENT_W * 0.86;
    const x = (SLIDE_W - w) / 2;
    const hSize = fitFontSize(doc, heading, "Helvetica-Bold", w, isTitle ? 46 : 38, 22, 3);
    const hH = doc.font("Helvetica-Bold").fontSize(hSize).heightOfString(heading, { width: w });
    const subH = sub
      ? doc.font("Helvetica").fontSize(17).heightOfString(sub, { width: w }) + 16
      : 0;
    const bodyH = body
      ? doc.font("Helvetica").fontSize(14).heightOfString(body, { width: w, lineGap: 2 }) + 14
      : 0;
    const rule = isTitle ? 34 : 0;
    let y = Math.max(MARGIN_TOP, (SLIDE_H - (hH + subH + bodyH + rule)) / 2);
    if (isTitle) {
      doc.roundedRect(SLIDE_W / 2 - 32, y, 64, 5, 2.5).fill(theme.gold);
      y += rule;
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(hSize)
      .fillColor(theme.ink)
      .text(heading, x, y, { width: w, align: "center" });
    y += hH;
    if (sub) {
      y += 16;
      doc
        .font("Helvetica")
        .fontSize(17)
        .fillColor(theme.inkMuted)
        .text(sub, x, y, { width: w, align: "center" });
      y += subH - 16;
    }
    if (body) {
      y += 14;
      doc
        .font("Helvetica")
        .fontSize(14)
        .fillColor(theme.ink)
        .text(body, x, y, { width: w, lineGap: 2, align: "center" });
    }
  } else {
    let y = MARGIN_TOP;
    const hSize = fitFontSize(doc, heading, "Helvetica-Bold", CONTENT_W, 32, 20, 2);
    doc
      .font("Helvetica-Bold")
      .fontSize(hSize)
      .fillColor(theme.ink)
      .text(heading, MARGIN_X, y, { width: CONTENT_W });
    y += doc.heightOfString(heading, { width: CONTENT_W }) + 10;
    doc.rect(MARGIN_X, y, CONTENT_W, 2).fill(theme.accent);
    y += 22;
    if (sub) {
      doc.font("Helvetica").fontSize(15).fillColor(theme.inkMuted).text(sub, MARGIN_X, y, { width: CONTENT_W });
      y += doc.heightOfString(sub, { width: CONTENT_W }) + 12;
    }
    if (body) {
      doc.font("Helvetica").fontSize(13.5).fillColor(theme.ink).text(body, MARGIN_X, y, {
        width: CONTENT_W,
        lineGap: 2,
      });
      y += doc.heightOfString(body, { width: CONTENT_W, lineGap: 2 }) + 14;
    }

    const contentTop = y + 6;
    const available = SLIDE_H - MARGIN_BOTTOM - 18 - contentTop;

    if (layout === "bullets" && slide.bullets?.length) {
      const size = slide.bullets.length >= 7 ? 13 : slide.bullets.length >= 5 ? 14.5 : 16;
      const blockH = measureBullets(doc, slide.bullets, CONTENT_W, size);
      drawBullets(doc, slide.bullets, MARGIN_X, blockTop(contentTop, available, blockH), CONTENT_W, size, theme);
    } else if (layout === "two_column" && slide.columns?.length === 2) {
      const gap = 44;
      const colW = (CONTENT_W - gap) / 2;
      const sizes = slide.columns.map((c) => (c.bullets.length >= 5 ? 12.5 : 14));
      const headH = 11.5 * 1.35 + 12;
      const blockH =
        headH +
        Math.max(...slide.columns.map((c, ci) => measureBullets(doc, c.bullets, colW, sizes[ci])));
      const top = blockTop(contentTop, available, blockH);
      slide.columns.forEach((c, ci) => {
        const cx = MARGIN_X + ci * (colW + gap);
        const ch = safePdfProseText(c.heading).toUpperCase();
        doc.font("Helvetica-Bold").fontSize(11.5).fillColor(theme.accent).text(ch, cx, top, {
          width: colW,
          characterSpacing: 0.6,
        });
        const chH = doc.heightOfString(ch, { width: colW, characterSpacing: 0.6 });
        drawBullets(doc, c.bullets, cx, top + chH + 12, colW, sizes[ci], theme);
      });
    } else if (layout === "metrics" && slide.metrics?.length) {
      const n = slide.metrics.length;
      const gap = 22;
      const cardW = (CONTENT_W - gap * (n - 1)) / n;
      const cardH = 118;
      const cy = blockTop(contentTop, available, cardH);
      slide.metrics.forEach((m, mi) => {
        const cx = MARGIN_X + mi * (cardW + gap);
        doc.roundedRect(cx, cy, cardW, cardH, 12).fillAndStroke(theme.creamDeep, theme.rule);
        const val = safePdfProseText(m.value);
        const vSize = fitFontSize(doc, val, "Helvetica-Bold", cardW - 28, 38, 18, 1);
        doc
          .font("Helvetica-Bold")
          .fontSize(vSize)
          .fillColor(theme.ink)
          .text(val, cx + 14, cy + 24, { width: cardW - 28 });
        doc
          .font("Helvetica")
          .fontSize(11)
          .fillColor(theme.inkMuted)
          .text(safePdfProseText(m.label), cx + 14, cy + 24 + vSize + 14, {
            width: cardW - 28,
            lineGap: 1,
            height: cardH - (24 + vSize + 14) - 12,
            ellipsis: true,
          });
      });
    } else if (slide.bullets?.length) {
      const blockH = measureBullets(doc, slide.bullets, CONTENT_W, 15);
      drawBullets(doc, slide.bullets, MARGIN_X, blockTop(contentTop, available, blockH), CONTENT_W, 15, theme);
    }
  }

  const fy = SLIDE_H - MARGIN_BOTTOM + 14;
  doc.rect(MARGIN_X, fy - 14, CONTENT_W, 1).fill(theme.rule);
  if (footer) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(theme.inkMuted)
      .text(safePdfProseText(footer), MARGIN_X, fy, { width: CONTENT_W * 0.7, lineBreak: false });
  }
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(theme.inkMuted)
    .text(`${index + 1} / ${total}`, MARGIN_X, fy, { width: CONTENT_W, align: "right" });
}

function innerRender(input: RenderDeckInput, theme: DeckTheme): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [SLIDE_W, SLIDE_H],
        margin: 0,
        info: { Title: input.title },
        autoFirstPage: false,
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      doc.on("error", (e: Error) => reject(e));

      input.slides.forEach((slide, i) => {
        doc.addPage({ size: [SLIDE_W, SLIDE_H], margin: 0 });
        drawSlide(doc, slide, i, input.slides.length, input.footer, theme);
      });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

export async function renderDeckPdf(
  rawInput: unknown,
  theme: DeckTheme = DEFAULT_DECK_THEME,
): Promise<Uint8Array> {
  const input = renderDeckInputSchema.parse(rawInput);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      innerRender(input, theme),
      new Promise<Uint8Array>((_, rej) => {
        timer = setTimeout(
          () =>
            rej(
              new DeckRenderError(
                "deck_render_timeout",
                `deck pdf render exceeded ${RENDER_TIMEOUT_MS}ms (best-effort timeout)`,
              ),
            ),
          RENDER_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (e) {
    if (e instanceof DeckRenderError) throw e;
    if (e && typeof e === "object" && "issues" in e) throw e;
    throw new DeckRenderError(
      "deck_render_failed",
      (e instanceof Error ? e.message : String(e)).slice(0, 300),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
