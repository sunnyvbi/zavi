
import type { SpokenWord } from "@/services/media-router/types";

export type Word = SpokenWord;

export type CaptionWord = { text: string; start: number; end: number };
export type CaptionPage = { start: number; end: number; words: CaptionWord[] };
export type Shot = { from: number; to: number; zoom: number };

export type FinishPlan = {
  shots: Shot[];
  pages: CaptionPage[];
  duration: number;
};

export const OUT_W = 1080;
export const OUT_H = 1920;
export const OUT_FPS = 30;

const PAUSE_OVER_S = 0.3;
const PAUSE_KEEP_S = 0.24;
const LEAD_IN_S = 0.08;
const TAIL_S = 0.35;
const MIN_SHOT_S = 2.2;
const PUNCH_IN = 1.12;
const WORDS_PER_PAGE = 3;
const PAGE_MAX_CHARS = 22;

const round = (n: number): number => Math.round(n * 1000) / 1000;

const shown = (w: string): string => w.replace(/^["'“‘(]+/, "").replace(/[.,!?;:…"'”’)]+$/, "").toUpperCase();

export type Silence = [start: number, end: number];

const endsClause = (w: string): boolean => /[.,!?;:…]["'”’)]*$/.test(w);

export function planFinish(words: Word[], videoSeconds: number, silences?: Silence[]): FinishPlan | null {
  const spoken = words.filter((w) => shown(w[0]).length > 0);
  if (spoken.length < 3 || !Number.isFinite(videoSeconds) || videoSeconds <= 0) return null;
  const firstStart = spoken[0][1];
  const lastEnd = spoken[spoken.length - 1][2];
  if (lastEnd > videoSeconds + 0.5) return null;

  const half = PAUSE_KEEP_S / 2;
  const pauses: Silence[] = silences
    ? silences.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b - a > PAUSE_OVER_S && a > firstStart && b < lastEnd)
    : spoken.slice(1).flatMap((w, i): Silence[] => (w[1] - spoken[i][2] > PAUSE_OVER_S ? [[spoken[i][2], w[1]]] : []));
  const removed: Silence[] = [];
  if (firstStart - LEAD_IN_S > 0.05) removed.push([0, firstStart - LEAD_IN_S]);
  for (const [a, b] of pauses) removed.push([a + half, b - half]);
  const tailFrom = Math.min(videoSeconds, lastEnd + TAIL_S);
  if (videoSeconds - tailFrom > 0.05) removed.push([tailFrom, videoSeconds]);
  removed.sort((x, y) => x[0] - y[0]);

  const kept: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (const [a, b] of removed) {
    if (a - cursor > 0.05) kept.push({ from: cursor, to: a });
    cursor = Math.max(cursor, b);
  }
  if (videoSeconds - cursor > 0.05) kept.push({ from: cursor, to: videoSeconds });
  if (!kept.length) return null;
  const keptIndex = (t: number): number => {
    for (let i = 0; i < kept.length; i++) if (t < kept[i].to) return i;
    return kept.length - 1;
  };

  type SrcPage = { words: Word[]; kept: number };
  const srcPages: SrcPage[] = [];
  const chars = (ws: Word[]) => ws.map((w) => shown(w[0])).join(" ").length;
  let page: Word[] = [];
  const close = () => {
    if (page.length) srcPages.push({ words: page, kept: keptIndex(page[0][1]) });
    page = [];
  };
  for (const w of spoken) {
    if (page.length && (keptIndex(w[1]) !== keptIndex(page[0][1]) || chars([...page, w]) > PAGE_MAX_CHARS)) close();
    page.push(w);
    if (page.length >= WORDS_PER_PAGE || endsClause(w[0])) close();
  }
  close();

  const shots: Shot[] = [];
  let zoomed = false;
  kept.forEach((k, ki) => {
    const pagesHere = srcPages.filter((p) => p.kept === ki);
    let from = k.from;
    for (let i = 1; i < pagesHere.length; i++) {
      const boundary = pagesHere[i].words[0][1];
      if (boundary - from >= MIN_SHOT_S && k.to - boundary >= MIN_SHOT_S / 2) {
        shots.push({ from: round(from), to: round(boundary), zoom: zoomed ? PUNCH_IN : 1 });
        zoomed = !zoomed;
        from = boundary;
      }
    }
    shots.push({ from: round(from), to: round(k.to), zoom: zoomed ? PUNCH_IN : 1 });
    zoomed = !zoomed;
  });
  const real = shots.filter((s) => s.to - s.from > 0.05);
  if (!real.length) return null;

  const offsets: number[] = [];
  let acc = 0;
  for (const s of real) {
    offsets.push(acc - s.from);
    acc += s.to - s.from;
  }
  const toOut = (t: number): number => {
    for (let i = 0; i < real.length; i++) {
      if (t <= real[i].to + 1e-6) return Math.max(0, Math.min(acc, Math.max(t, real[i].from) + offsets[i]));
    }
    return acc;
  };
  const pages: CaptionPage[] = srcPages.map((p) => {
    const ws = p.words.map((w) => ({ text: shown(w[0]), start: round(toOut(w[1])), end: round(toOut(w[2])) }));
    return { start: ws[0].start, end: ws[ws.length - 1].end, words: ws };
  });
  pages.forEach((p, i) => {
    const next = pages[i + 1];
    p.end = round(next ? Math.max(p.end, Math.min(next.start, p.end + 0.6)) : Math.min(acc, p.end + 0.3));
  });
  return { shots: real, pages, duration: round(acc) };
}

export function plainPlan(videoSeconds: number): FinishPlan | null {
  if (!Number.isFinite(videoSeconds) || videoSeconds <= 0.5) return null;
  return { shots: [{ from: 0, to: round(videoSeconds), zoom: 1 }], pages: [], duration: round(videoSeconds) };
}

export function parseSilences(log: string): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const m of log.matchAll(/silence_(start|end):\s*(-?[0-9.]+)/g)) {
    const t = Number(m[2]);
    if (!Number.isFinite(t)) continue;
    if (m[1] === "start") start = Math.max(0, t);
    else if (start !== null) {
      if (t > start) out.push([round(start), round(t)]);
      start = null;
    }
  }
  return out;
}

export function assText(s: string): string {
  return s.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();
}

const assTime = (t: number): string => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

const CAPTION_Y = 1170;
const HOOK_Y = 1010;
const CAPTION_MAX_PX = 940;
const CAPTION_SIZE = 78;
const GLYPH = 0.72;
const HOOK_SECONDS = 2.6;
const HOOK_SIZE = 58;
const HOOK_LINE_PX = 70;
const HOOK_MAX_CHARS = 60;
const HOOK_LINE_CHARS = 20;
const ACTIVE = "&H0000E6FF&";
const WHITE = "&H00FFFFFF&";

function hookLines(hook: string): string[] | null {
  const text = assText(hook).replace(/[.!?…]+$/, "").toUpperCase();
  if (!text || text.length > HOOK_MAX_CHARS) return null;
  const lines: string[] = [];
  for (const w of text.split(" ")) {
    const cur = lines[lines.length - 1];
    if (cur !== undefined && `${cur} ${w}`.length <= HOOK_LINE_CHARS) lines[lines.length - 1] = `${cur} ${w}`;
    else lines.push(w);
  }
  return lines.length <= 3 ? lines : null;
}

export function buildAss(plan: FinishPlan, opts: { hook?: string; font: string }): string {
  const font = assText(opts.font);
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${OUT_W}`,
    `PlayResY: ${OUT_H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${font},${CAPTION_SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,7,2,5,40,40,40,1`,
    `Style: Hook,${font},${HOOK_SIZE},&H00111111,&H00111111,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,1,0,0,5,40,40,40,1`,
    `Style: Box,${font},20,&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const ev: string[] = [];
  const line = (layer: number, a: number, b: number, style: string, text: string) =>
    ev.push(`Dialogue: ${layer},${assTime(a)},${assTime(b)},${style},,0,0,0,,${text}`);

  const hook = opts.hook ? hookLines(opts.hook) : null;
  const hookEnd = Math.min(HOOK_SECONDS, plan.duration);
  if (hook && hookEnd > 0.5) {
    const w = Math.min(OUT_W - 80, Math.round(Math.max(...hook.map((l) => l.length)) * HOOK_SIZE * GLYPH) + 72);
    const h = hook.length * HOOK_LINE_PX + 44;
    const x = Math.round((OUT_W - w) / 2);
    const y = Math.round(HOOK_Y - h / 2);
    line(1, 0, hookEnd, "Box", `{\\an7\\pos(${x},${y})\\fad(120,160)\\p1}m 0 0 l ${w} 0 ${w} ${h} 0 ${h}{\\p0}`);
    line(2, 0, hookEnd, "Hook", `{\\an5\\pos(${OUT_W / 2},${HOOK_Y})\\fad(120,160)}${hook.join("\\N")}`);
  }

  for (const p of plan.pages) {
    const chars = p.words.map((w) => w.text).join(" ").length;
    const size = Math.min(CAPTION_SIZE, Math.floor(CAPTION_MAX_PX / (chars * GLYPH)));
    const at = `{\\an5\\pos(${OUT_W / 2},${CAPTION_Y})\\fs${size}}`;
    p.words.forEach((w, i) => {
      const from = i === 0 ? p.start : w.start;
      const to = i === p.words.length - 1 ? p.end : p.words[i + 1].start;
      if (to - from < 0.01) return;
      const text = p.words.map((x, j) => (j === i ? `{\\c${ACTIVE}}${assText(x.text)}{\\c${WHITE}}` : assText(x.text))).join(" ");
      line(0, from, to, "Cap", at + text);
    });
  }
  return [...head, ...ev, ""].join("\n");
}

const even = (n: number): number => 2 * Math.ceil(n / 2);

export function buildFilterGraph(plan: FinishPlan, assFile = "captions.ass", fontsDir = "fonts"): string {
  const parts: string[] = [];
  const labels: string[] = [];
  plan.shots.forEach((s, i) => {
    const w = even(OUT_W * s.zoom);
    const h = even(OUT_H * s.zoom);
    parts.push(
      `[0:v]trim=start=${s.from}:end=${s.to},setpts=PTS-STARTPTS,` +
        `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${OUT_W}:${OUT_H}:(iw-${OUT_W})/2:(ih-${OUT_H})*0.28,setsar=1[v${i}]`,
    );
    parts.push(`[0:a]atrim=start=${s.from}:end=${s.to},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${plan.shots.length}:v=1:a=1[vc][ac]`);
  parts.push(`[vc]fps=${OUT_FPS},noise=alls=5:allf=t,eq=saturation=0.95,subtitles=f=${assFile}:fontsdir=${fontsDir}[v]`);
  parts.push(
    `[ac]highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=80:makeup=2,loudnorm=I=-14:TP=-1.5:LRA=11,apad=whole_dur=${plan.duration}[a]`,
  );
  return parts.join(";");
}
