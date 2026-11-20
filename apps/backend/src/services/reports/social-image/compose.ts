
import sharp from "sharp";
import { typesetLine, wrapLines, measureLine } from "./typeset";
import { lightness, normalizeHex } from "@/services/brand/extract-brand-colors";

export const SOCIAL_LAYOUTS = ["block", "scrim", "dark"] as const;
export type SocialLayout = (typeof SOCIAL_LAYOUTS)[number];

export const SOCIAL_ASPECTS = ["1:1", "4:5", "9:16", "16:9", "2:3"] as const;
export type SocialAspect = (typeof SOCIAL_ASPECTS)[number];

const CANVAS: Record<SocialAspect, { w: number; h: number }> = {
  "1:1": { w: 1080, h: 1080 },
  "4:5": { w: 1080, h: 1350 },
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1280, h: 720 },
  "2:3": { w: 1000, h: 1500 },
};

export function plateAspectFor(aspect: SocialAspect): Exclude<SocialAspect, "2:3"> {
  return aspect === "2:3" ? "4:5" : aspect;
}

export type BrandTokens = {
  primary: string;
  accent?: string | null;
  bg?: string | null;
  text?: string | null;
};

export type SocialSlots = {
  eyebrow?: string | null;
  headline?: string | null;
  sub?: string | null;
  badge?: string | null;
  foot?: string | null;
};

export type ComposeResult = {
  png: Buffer;
  usedHexes: string[];
  textScale: number;
};

const INK = "#111111";
const PAPER = "#ffffff";

export function readableOn(bg: string): string {
  return lightness(bg) < 0.55 ? PAPER : INK;
}

type StackItem = {
  text: string;
  fontSize: number;
  weight: number;
  letterSpacing: number;
  fill: string;
  pill?: { fill: string; textFill: string };
  marginTop: number;
};

function buildStack(
  slots: SocialSlots,
  palette: { onBg: string; accentish: string; muted: string; pill: string },
): StackItem[] {
  const items: StackItem[] = [];
  if (slots.eyebrow?.trim()) {
    items.push({
      text: slots.eyebrow.trim().toUpperCase(),
      fontSize: 34,
      weight: 700,
      letterSpacing: 0.16,
      fill: palette.accentish,
      marginTop: 0,
    });
  }
  if (slots.headline?.trim()) {
    items.push({
      text: slots.headline.trim(),
      fontSize: 128,
      weight: 800,
      letterSpacing: -0.02,
      fill: palette.onBg,
      marginTop: items.length ? 28 : 0,
    });
  }
  if (slots.sub?.trim()) {
    items.push({
      text: slots.sub.trim(),
      fontSize: 46,
      weight: 500,
      letterSpacing: 0,
      fill: palette.onBg,
      marginTop: items.length ? 20 : 0,
    });
  }
  if (slots.badge?.trim()) {
    items.push({
      text: slots.badge.trim(),
      fontSize: 42,
      weight: 700,
      letterSpacing: 0.04,
      fill: palette.onBg,
      pill: { fill: palette.pill, textFill: readableOn(palette.pill) },
      marginTop: items.length ? 34 : 0,
    });
  }
  if (slots.foot?.trim()) {
    items.push({
      text: slots.foot.trim().toUpperCase(),
      fontSize: 28,
      weight: 600,
      letterSpacing: 0.1,
      fill: palette.muted,
      marginTop: items.length ? 24 : 0,
    });
  }
  return items;
}

type LaidOutLine = { item: StackItem; text: string; width: number };

function layoutLines(items: StackItem[], scale: number, maxWidth: number): LaidOutLine[] {
  const out: LaidOutLine[] = [];
  for (const item of items) {
    const fontSize = item.fontSize * scale;
    const opts = { fontSize, weight: item.weight, letterSpacing: item.letterSpacing };
    const forced = item.text.includes("|")
      ? item.text.split("|").map((s) => s.trim()).filter(Boolean)
      : wrapLines(item.text, { ...opts, maxWidth });
    forced.forEach((text, i) => {
      out.push({
        item: i === 0 ? item : { ...item, marginTop: Math.round(item.fontSize * 0.12) },
        text,
        width: measureLine(text, opts),
      });
    });
  }
  return out;
}

function stackHeight(lines: LaidOutLine[], scale: number): number {
  let h = 0;
  for (const l of lines) {
    h += l.item.marginTop * scale + l.item.fontSize * scale * 1.16;
    if (l.item.pill) h += l.item.fontSize * scale * 0.5;
  }
  return h;
}

function fitScale(items: StackItem[], box: { w: number; h: number }): { scale: number; lines: LaidOutLine[] } {
  let scale = 1;
  for (let i = 0; i < 24; i++) {
    const lines = layoutLines(items, scale, box.w);
    const h = stackHeight(lines, scale);
    const widest = Math.max(0, ...lines.map((l) => l.width));
    if (h <= box.h && widest <= box.w) return { scale, lines };
    const byH = box.h / h;
    const byW = widest > 0 ? box.w / widest : 1;
    const next = scale * Math.min(byH, byW) * 0.97;
    if (next < 0.42) {
      const floored = layoutLines(items, 0.42, box.w);
      return { scale: 0.42, lines: floored };
    }
    scale = next;
  }
  return { scale, lines: layoutLines(items, scale, box.w) };
}

function renderStackSvg(
  lines: LaidOutLine[],
  scale: number,
  box: { x: number; y: number; w: number; h: number },
  align: "center" | "left",
): string {
  const parts: string[] = [];
  let cursorY = box.y;
  for (const l of lines) {
    const fontSize = l.item.fontSize * scale;
    cursorY += l.item.marginTop * scale;
    const ts = typesetLine(l.text, {
      fontSize,
      weight: l.item.weight,
      letterSpacing: l.item.letterSpacing,
    });
    const x = align === "center" ? box.x + (box.w - ts.width) / 2 : box.x;
    const baseline = cursorY + fontSize * 0.86;
    if (l.item.pill) {
      const padX = fontSize * 0.55;
      const padY = fontSize * 0.34;
      const pillX = x - padX;
      const pillY = cursorY - padY * 0.25;
      const pillW = ts.width + padX * 2;
      const pillH = fontSize * 1.12 + padY;
      parts.push(
        `<rect x="${pillX.toFixed(1)}" y="${pillY.toFixed(1)}" width="${pillW.toFixed(1)}" height="${pillH.toFixed(1)}" rx="${(pillH / 2).toFixed(1)}" fill="${l.item.pill.fill}"/>`,
      );
      parts.push(
        `<path transform="translate(${x.toFixed(1)},${(baseline + padY * 0.3).toFixed(1)})" d="${ts.d}" fill="${l.item.pill.textFill}"/>`,
      );
      cursorY += pillH + padY * 0.2;
      continue;
    }
    parts.push(
      `<path transform="translate(${x.toFixed(1)},${baseline.toFixed(1)})" d="${ts.d}" fill="${l.item.fill}"/>`,
    );
    cursorY += fontSize * 1.16;
  }
  return parts.join("\n");
}

function requireHex(raw: string | null | undefined, fallback: string): string {
  return normalizeHex(raw ?? "") ?? fallback;
}

export type PanelCounter = { index: number; total: number };

function renderCounterSvg(
  counter: PanelCounter,
  canvas: { w: number; h: number },
  margin: number,
  fill: string,
  textFill: string,
): string {
  const fontSize = Math.round(canvas.w * 0.028);
  const ts = typesetLine(`${counter.index}/${counter.total}`, {
    fontSize,
    weight: 700,
    letterSpacing: 0.04,
  });
  const padX = fontSize * 0.62;
  const padY = fontSize * 0.42;
  const pillW = ts.width + padX * 2;
  const pillH = fontSize * 1.1 + padY * 1.2;
  const pillX = canvas.w - margin - pillW;
  const pillY = margin;
  return (
    `<rect x="${pillX.toFixed(1)}" y="${pillY.toFixed(1)}" width="${pillW.toFixed(1)}" ` +
    `height="${pillH.toFixed(1)}" rx="${(pillH / 2).toFixed(1)}" fill="${fill}"/>` +
    `<path transform="translate(${(pillX + padX).toFixed(1)},${(pillY + padY + fontSize * 0.82).toFixed(1)})" ` +
    `d="${ts.d}" fill="${textFill}"/>`
  );
}

export async function composeSocialImage(opts: {
  plate: Buffer | null;
  layout: SocialLayout;
  aspect: SocialAspect;
  tokens: BrandTokens;
  slots: SocialSlots;
  counter?: PanelCounter | null;
}): Promise<ComposeResult> {
  const { w, h } = CANVAS[opts.aspect];
  const primary = requireHex(opts.tokens.primary, "#027bff");
  const accent = normalizeHex(opts.tokens.accent ?? "") ?? primary;
  const ink = requireHex(opts.tokens.text, INK);
  const usedHexes = new Set<string>();

  let base: sharp.Sharp;
  let textBox: { x: number; y: number; w: number; h: number };
  let align: "center" | "left" = "center";
  let palette: { onBg: string; accentish: string; muted: string; pill: string };
  const overlays: sharp.OverlayOptions[] = [];
  const bgSvgParts: string[] = [];

  const margin = Math.round(w * 0.09);

  if (opts.layout === "block") {
    const photoH = Math.round(h * 0.6);
    base = sharp({
      create: { width: w, height: h, channels: 4, background: primary },
    });
    usedHexes.add(primary);
    if (opts.plate) {
      const photo = await sharp(opts.plate).resize(w, photoH, { fit: "cover" }).png().toBuffer();
      overlays.push({ input: photo, top: 0, left: 0 });
    }
    palette = {
      onBg: readableOn(primary),
      accentish: readableOn(primary),
      muted: readableOn(primary),
      pill: readableOn(primary),
    };
    usedHexes.add(palette.onBg);
    textBox = { x: margin, y: photoH + Math.round(h * 0.045), w: w - margin * 2, h: h - photoH - Math.round(h * 0.09) };
  } else if (opts.layout === "scrim") {
    base = opts.plate
      ? sharp(opts.plate).resize(w, h, { fit: "cover" })
      : sharp({ create: { width: w, height: h, channels: 4, background: ink } });
    if (!opts.plate) usedHexes.add(ink);
    bgSvgParts.push(
      `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0.35" stop-color="${ink}" stop-opacity="0"/>` +
        `<stop offset="1" stop-color="${ink}" stop-opacity="0.9"/></linearGradient></defs>` +
        `<rect x="0" y="0" width="${w}" height="${h}" fill="url(#scrim)"/>`,
    );
    align = "left";
    palette = { onBg: PAPER, accentish: primary, muted: PAPER, pill: accent };
    if (opts.slots.eyebrow?.trim()) usedHexes.add(primary);
    if (opts.slots.badge?.trim()) usedHexes.add(accent);
    usedHexes.add(PAPER);
    textBox = { x: margin, y: Math.round(h * 0.52), w: w - margin * 2, h: Math.round(h * 0.4) };
  } else {
    base = sharp({ create: { width: w, height: h, channels: 4, background: ink } });
    usedHexes.add(ink);
    if (opts.plate) {
      const bandH = Math.round(h * 0.34);
      const band = await sharp(opts.plate).resize(w, bandH, { fit: "cover" }).png().toBuffer();
      overlays.push({ input: band, top: Math.round(h * 0.33), left: 0 });
    }
    palette = { onBg: PAPER, accentish: primary, muted: PAPER, pill: accent };
    if (opts.slots.eyebrow?.trim()) {
      usedHexes.add(primary);
      const ruleY = Math.round(h * 0.7) - Math.round(h * 0.035);
      const ruleW = Math.round(w * 0.14);
      const ruleH = Math.max(5, Math.round(h * 0.008));
      bgSvgParts.push(
        `<rect x="${margin}" y="${ruleY}" width="${ruleW}" height="${ruleH}" rx="${(ruleH / 2).toFixed(1)}" fill="${primary}"/>`,
      );
    }
    if (opts.slots.badge?.trim()) usedHexes.add(accent);
    usedHexes.add(PAPER);
    textBox = { x: margin, y: Math.round(h * 0.7), w: w - margin * 2, h: Math.round(h * 0.24) };
  }

  const plateless = !opts.plate;
  if (plateless) {
    textBox = { x: margin, y: margin * 2, w: w - margin * 2, h: h - margin * 4 };
    align = "left";
  }

  const items = buildStack(opts.slots, palette);
  const { scale, lines } = fitScale(items, { w: textBox.w, h: textBox.h });
  if (plateless && lines.length) {
    const used = stackHeight(lines, scale);
    textBox = { ...textBox, y: textBox.y + Math.max(0, (textBox.h - used) / 2) };
  }
  const stackSvg = lines.length ? renderStackSvg(lines, scale, textBox, align) : "";

  let counterSvg = "";
  if (opts.counter && opts.counter.total > 1) {
    const pillFill = opts.layout === "block" ? readableOn(primary) : primary;
    counterSvg = renderCounterSvg(opts.counter, { w, h }, margin, pillFill, readableOn(pillFill));
    usedHexes.add(pillFill);
    usedHexes.add(readableOn(pillFill));
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bgSvgParts.join("")}${stackSvg}${counterSvg}</svg>`;
  overlays.push({ input: Buffer.from(svg), top: 0, left: 0 });

  const png = await base.composite(overlays).png({ compressionLevel: 9 }).toBuffer();
  return { png, usedHexes: [...usedHexes], textScale: scale };
}
