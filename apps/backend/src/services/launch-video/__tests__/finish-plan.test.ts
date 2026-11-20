import { describe, it, expect } from "vitest";
import { assText, buildAss, buildFilterGraph, parseSilences, plainPlan, planFinish, type Word } from "../finish-plan";
import { wordsFromCharTimings } from "@/services/media-router/word-timings";

function charTimings(spec: Array<[string, number, number]>, chunkAt = 9) {
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  spec.forEach(([word, start, end], wi) => {
    const per = (end - start) / word.length;
    [...word].forEach((ch, i) => {
      characters.push(ch);
      starts.push(start + i * per);
      ends.push(start + (i + 1) * per);
    });
    if (wi < spec.length - 1) {
      characters.push(" ");
      starts.push(end);
      ends.push(spec[wi + 1][1]);
    }
  });
  const chunks = [];
  for (let i = 0; i < characters.length; i += chunkAt) {
    chunks.push({
      characters: characters.slice(i, i + chunkAt),
      character_start_times_seconds: starts.slice(i, i + chunkAt),
      character_end_times_seconds: ends.slice(i, i + chunkAt),
    });
  }
  return chunks;
}

const READ: Array<[string, number, number]> = [
  ["I", 0.1, 0.2], ["used", 0.22, 0.45], ["to", 0.47, 0.55], ["drive", 0.57, 0.9], ["forty", 0.92, 1.3], ["minutes", 1.32, 1.8], ["for", 1.82, 1.95], ["good", 1.97, 2.2], ["sourdough.", 2.22, 2.53],
  ["Then", 3.04, 3.3], ["Maple", 3.32, 3.7], ["Street", 3.72, 4.1], ["Bakery", 4.12, 4.6], ["opened", 4.62, 5.0], ["nearby.", 5.02, 5.6],
  ["Go", 6.12, 6.3], ["try", 6.32, 6.6], ["it.", 6.62, 6.9],
];
const WORDS: Word[] = READ.map(([t, a, b]) => [t, a, b]);

describe("wordsFromCharTimings", () => {
  it("groups characters into words across chunk boundaries", () => {
    const words = wordsFromCharTimings(charTimings(READ));
    expect(words.map((w) => w[0])).toEqual(READ.map((r) => r[0]));
    expect(words[0][1]).toBeCloseTo(0.1, 2);
    expect(words[words.length - 1][2]).toBeCloseTo(6.9, 2);
  });

  it("leaves a delivery tag out of the words", () => {
    const words = wordsFromCharTimings(charTimings([["[sighs]", 0, 0.5], ["Okay", 0.6, 0.9], ["[laughs", 1.0, 1.2], ["harder]", 1.2, 1.5], ["so", 1.6, 1.8]]));
    expect(words.map((w) => w[0])).toEqual(["Okay", "so"]);
  });

  it("returns nothing for a shape it does not recognise, rather than guessing", () => {
    expect(wordsFromCharTimings(undefined)).toEqual([]);
    expect(wordsFromCharTimings("nope")).toEqual([]);
    expect(wordsFromCharTimings([{ characters: ["a"], character_start_times_seconds: [], character_end_times_seconds: [0.1] }])).toEqual([]);
    expect(wordsFromCharTimings([{ characters: ["a", "b"], character_start_times_seconds: [0, "x"], character_end_times_seconds: [0.1, 0.2] }])).toEqual([]);
    expect(wordsFromCharTimings(charTimings([["one", 2, 2.2], ["two", 1, 1.2]]))).toEqual([]);
  });
});

describe("planFinish", () => {
  const plan = planFinish(WORDS, 7.4)!;

  it("tightens each pause and trims dead air at both ends, cutting video and audio together", () => {
    expect(plan.duration).toBeLessThan(7.4 - 0.5);
    expect(plan.duration).toBeGreaterThan(6.0);
    expect(plan.shots[0].from).toBeLessThanOrEqual(0.05);
    expect(plan.shots[plan.shots.length - 1].to).toBeCloseTo(7.25, 2);
    plan.shots.forEach((s, i) => {
      expect(s.to).toBeGreaterThan(s.from);
      if (i) expect(s.from).toBeGreaterThanOrEqual(plan.shots[i - 1].to);
    });
    expect(plan.shots.reduce((n, s) => n + (s.to - s.from), 0)).toBeCloseTo(plan.duration, 2);
  });

  it("changes the framing at every cut, and inside a long phrase too", () => {
    expect(plan.shots.length).toBeGreaterThanOrEqual(3);
    plan.shots.forEach((s, i) => {
      if (i) expect(s.zoom).not.toBe(plan.shots[i - 1].zoom);
      expect([1, 1.12]).toContain(s.zoom);
    });
  });

  it("captions are 1-3 words, never cross a pause, and stay in order on the output timeline", () => {
    for (const p of plan.pages) {
      expect(p.words.length).toBeGreaterThanOrEqual(1);
      expect(p.words.length).toBeLessThanOrEqual(3);
      expect(p.end).toBeGreaterThan(p.start);
      expect(p.end).toBeLessThanOrEqual(plan.duration + 1e-6);
    }
    plan.pages.forEach((p, i) => {
      if (i) expect(p.start).toBeGreaterThanOrEqual(plan.pages[i - 1].end - 1e-6);
    });
    const texts = plan.pages.map((p) => p.words.map((w) => w.text).join(" "));
    expect(texts.join(" ")).toBe("I USED TO DRIVE FORTY MINUTES FOR GOOD SOURDOUGH THEN MAPLE STREET BAKERY OPENED NEARBY GO TRY IT");
    expect(texts.some((t) => t.includes("SOURDOUGH THEN"))).toBe(false);
    expect(texts.some((t) => t.includes("NEARBY GO"))).toBe(false);
  });

  it("a single unbroken sentence still gets shots and captions (a comma-joined script has no pauses)", () => {
    const flat: Word[] = Array.from({ length: 30 }, (_, i) => [`word${i}`, i * 0.3, i * 0.3 + 0.27] as Word);
    const p = planFinish(flat, 9.2)!;
    expect(p.shots.length).toBeGreaterThan(2);
    expect(p.pages.length).toBeGreaterThanOrEqual(10);
    expect(p.duration).toBeCloseTo(9.2, 2);
  });

  it("a caption page ends at the end of a clause, so it never reads across a comma or a full stop", () => {
    const run: Word[] = [["Come", 0, 0.2], ["see", 0.22, 0.4], ["for", 0.42, 0.55], ["yourself,", 0.57, 1.0], ["we", 1.02, 1.15], ["open", 1.17, 1.4], ["at", 1.42, 1.5], ["eight.", 1.52, 1.9]];
    const texts = planFinish(run, 2.2)!.pages.map((p) => p.words.map((w) => w.text).join(" "));
    expect(texts).toEqual(["COME SEE FOR", "YOURSELF", "WE OPEN AT", "EIGHT"]);
  });

  it("uses the pauses measured in the audio when they are given, and ignores ones outside the speech", () => {
    const stretched: Word[] = [["One", 0, 0.5], ["two", 0.5, 1.0], ["three.", 1.0, 2.0], ["Four", 2.0, 2.5], ["five", 2.5, 3.0], ["six.", 3.0, 3.5]];
    const noCuts = planFinish(stretched, 3.6)!;
    const heard = planFinish(stretched, 3.6, [[1.4, 2.0], [3.55, 3.6], [0.6, 0.75]])!;
    expect(heard.duration).toBeCloseTo(noCuts.duration - (0.6 - 0.24), 2);
    expect(heard.shots.some((s) => Math.abs(s.to - 1.52) < 0.001)).toBe(true);
    expect(heard.shots.some((s) => Math.abs(s.from - 1.88) < 0.001)).toBe(true);
    const four = heard.pages.flatMap((p) => p.words).find((w) => w.text === "FOUR")!;
    expect(four.start).toBeCloseTo(2.0 - 0.36, 2);
  });

  it("refuses timings it cannot trust against the video", () => {
    expect(planFinish([], 7)).toBeNull();
    expect(planFinish(WORDS.slice(0, 2), 7)).toBeNull();
    expect(planFinish(WORDS, 3)).toBeNull();
    expect(planFinish(WORDS, Number.NaN)).toBeNull();
  });
});

describe("plainPlan", () => {
  it("is the whole clip as one shot with no captions, and refuses a clip it has no length for", () => {
    expect(plainPlan(12.27)).toEqual({ shots: [{ from: 0, to: 12.27, zoom: 1 }], pages: [], duration: 12.27 });
    expect(plainPlan(0)).toBeNull();
    expect(plainPlan(Number.NaN)).toBeNull();
    const ass = buildAss(plainPlan(5)!, { font: "DejaVu Sans" });
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:"))).toHaveLength(0);
  });
});

describe("parseSilences", () => {
  it("reads ffmpeg's silencedetect lines and drops anything unpaired or backwards", () => {
    const log = [
      "[silencedetect @ 0x55] silence_start: 5.965782",
      "[silencedetect @ 0x55] silence_end: 6.308322 | silence_duration: 0.34254",
      "[silencedetect @ 0x55] silence_end: 7.0 | silence_duration: 0.1",
      "[silencedetect @ 0x55] silence_start: -0.01",
      "[silencedetect @ 0x55] silence_end: 0.4 | silence_duration: 0.41",
      "[silencedetect @ 0x55] silence_start: 11.9",
    ].join("\n");
    expect(parseSilences(log)).toEqual([[5.966, 6.308], [0, 0.4]]);
    expect(parseSilences("")).toEqual([]);
  });
});

describe("buildAss", () => {
  const plan = planFinish(WORDS, 7.4)!;

  it("writes the hook at the start and one event per spoken word, with no AI-generated label", () => {
    const ass = buildAss(plan, { hook: "I drove 40 minutes for bread.", font: "DejaVu Sans" });
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(ass).not.toContain("Label");
    expect(ass).not.toMatch(/AI-generated/i);
    expect(events).toHaveLength(2 + WORDS.length);
    const hook = events.filter((l) => l.includes(",Hook,"));
    expect(hook).toHaveLength(1);
    expect(hook[0]).toContain("I DROVE 40 MINUTES\\NFOR BREAD");
    const box = events.filter((l) => l.includes(",Box,"));
    expect(box).toHaveLength(1);
    const w = Number(box[0].match(/m 0 0 l (\d+) 0/)![1]);
    expect(w).toBeGreaterThan(18 * 58 * 0.72);
    expect(w).toBeLessThanOrEqual(1000);
    expect(events.filter((l) => l.includes(",Cap,"))).toHaveLength(WORDS.length);
    for (const l of events.filter((x) => x.includes(",Cap,"))) expect(l.match(/\\c&H0000E6FF&/g)).toHaveLength(1);
  });

  it("leaves the hook title out when it is too long to read, and keeps the captions", () => {
    const ass = buildAss(plan, { hook: "This is the part nobody ever tells you about running a small bakery on a quiet street", font: "DejaVu Sans" });
    expect(ass).not.toContain(",Hook,,");
    expect(ass).toContain(",Cap,,");
  });

  it("customer text cannot open an override block or a tag", () => {
    expect(assText("{\\pos(0,0)}hi\\N there")).toBe("pos(0,0)hiN there");
    const evil: Word[] = [["{\\fs200}BIG", 0, 0.4], ["normal", 0.45, 0.8], ["words", 0.85, 1.2]];
    const ass = buildAss(planFinish(evil, 2)!, { hook: "{\\an1}top", font: "DejaVu Sans" });
    expect(ass).not.toContain("\\fs200");
    expect(ass).not.toContain("\\an1}");
  });

  it("shrinks a long caption so it fits the frame", () => {
    const long: Word[] = [["Supercalifragilisticexpialidocious", 0, 0.9], ["is", 0.92, 1.0], ["ok", 1.02, 1.2]];
    const ass = buildAss(planFinish(long, 2)!, { font: "DejaVu Sans" });
    const sizes = [...ass.matchAll(/\\fs(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...sizes)).toBeLessThan(78);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(78);
  });
});

describe("buildFilterGraph", () => {
  it("trims video and audio at the same timestamps for every shot, and contains no customer text", () => {
    const plan = planFinish(WORDS, 7.4)!;
    const g = buildFilterGraph(plan);
    for (const s of plan.shots) {
      expect(g).toContain(`trim=start=${s.from}:end=${s.to},setpts`);
      expect(g).toContain(`atrim=start=${s.from}:end=${s.to},asetpts`);
    }
    expect(g).toContain(`concat=n=${plan.shots.length}:v=1:a=1`);
    expect(g).toContain("subtitles=f=captions.ass:fontsdir=fonts[v]");
    expect(g.match(/fps=30/g)).toHaveLength(1);
    expect(g.indexOf("fps=30")).toBeGreaterThan(g.indexOf("concat="));
    expect(g).toContain(`apad=whole_dur=${plan.duration}[a]`);
    expect(g).toContain("loudnorm=I=-14");
    expect(g).not.toMatch(/['"`$\\]/);
    expect(g).not.toMatch(/SOURDOUGH|sourdough/);
    expect(g).toContain("scale=1210:2152");
    expect(g).toContain("scale=1080:1920");
  });
});
