import type { SpokenWord } from "./types";

const round = (n: number): number => Math.round(n * 1000) / 1000;

type CharTiming = { characters?: unknown; character_start_times_seconds?: unknown; character_end_times_seconds?: unknown };

export function wordsFromCharTimings(raw: unknown): SpokenWord[] {
  const chunks: CharTiming[] = Array.isArray(raw) ? (raw as CharTiming[]) : raw && typeof raw === "object" ? [raw as CharTiming] : [];
  const words: SpokenWord[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  let inTag = false;
  const flush = () => {
    if (text) words.push([text, round(start), round(end)]);
    text = "";
  };
  for (const c of chunks) {
    const chars = c?.characters;
    const starts = c?.character_start_times_seconds;
    const ends = c?.character_end_times_seconds;
    if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return [];
    if (chars.length !== starts.length || chars.length !== ends.length) return [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const s = starts[i];
      const e = ends[i];
      if (typeof ch !== "string" || typeof s !== "number" || typeof e !== "number" || !Number.isFinite(s) || !Number.isFinite(e)) return [];
      if (ch === "[") {
        flush();
        inTag = true;
        continue;
      }
      if (inTag) {
        if (ch === "]") inTag = false;
        continue;
      }
      if (/\s/.test(ch)) {
        flush();
        continue;
      }
      if (!text) start = s;
      text += ch;
      end = e;
    }
  }
  flush();
  for (let i = 0; i < words.length; i++) {
    if (words[i][2] < words[i][1] || (i > 0 && words[i][1] < words[i - 1][1])) return [];
  }
  return words;
}
