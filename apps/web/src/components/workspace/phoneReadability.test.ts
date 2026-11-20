import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (...parts: string[]) => readFileSync(join(__dirname, ...parts), "utf8");

const SCALE: Record<string, number> = { "3.5": 14, "4": 16, "5": 20, "7": 28, "8": 32, "10": 40 };

const px = (raw: string) => {
  const bracket = /^\[(\d+(?:\.\d+)?)px\]$/.exec(raw);
  if (bracket) return Number(bracket[1]);
  const step = SCALE[raw];
  expect(step, `unmapped spacing step ${raw}`).toBeTypeOf("number");
  return step;
};

const pairs = (line: string, prop: string) => {
  const base = [...line.matchAll(new RegExp(`(?<![\\w:-])${prop}-(\\[[^\\]]+\\]|[\\d.]+)`, "g"))];
  const phone = [...line.matchAll(new RegExp(`compact:${prop}-(\\[[^\\]]+\\]|[\\d.]+)`, "g"))];
  return { base: base.map((m) => px(m[1])), phone: phone.map((m) => px(m[1])) };
};

const biggerOnPhone = (line: string, prop: string) => {
  const { base, phone } = pairs(line, prop);
  expect(base.length, `no base ${prop} in: ${line.slice(0, 60)}`).toBeGreaterThan(0);
  expect(phone.length, `no compact ${prop} in: ${line.slice(0, 60)}`).toBe(base.length);
  base.forEach((value, i) => expect(phone[i]).toBeGreaterThan(value));
};

const lines = (source: string, match: (line: string) => boolean) =>
  source.split("\n").filter(match);

describe("the composer reads at arm's length on a phone", () => {
  const menu = read("ComposerPlusMenu.tsx");
  const composer = read("ModeComposer.tsx");
  const chip = read("Chip.tsx");

  it("grows every row, subtitle and mark in the plus menu", () => {
    const row = lines(menu, (l) => l.includes("hover:bg-creamDeep/60"))[0];
    biggerOnPhone(row, "text");

    const subtitles = lines(menu, (l) => l.includes("truncate text-[12px]"));
    expect(subtitles.length).toBe(2);
    for (const line of subtitles) biggerOnPhone(line, "text");

    const marks = lines(menu, (l) => /className="h-3\.5 w-3\.5 shrink-0/.test(l));
    expect(marks.length).toBeGreaterThanOrEqual(3);
    for (const line of marks) {
      biggerOnPhone(line, "h");
      biggerOnPhone(line, "w");
    }
  });

  it("grows the plus and send buttons past the 40px thumb target", () => {
    const buttons = lines(composer, (l) => /grid h-8 w-8 place-items-center/.test(l));
    expect(buttons.length).toBe(2);
    for (const line of buttons) {
      const { phone } = pairs(line, "h");
      expect(phone[0]).toBeGreaterThanOrEqual(40);
      biggerOnPhone(line, "h");
      biggerOnPhone(line, "w");
    }

    const glyphs = lines(composer, (l) => l.includes("h-4 w-4") && l.includes("compact:h-5"));
    expect(glyphs.length).toBe(2);
    for (const line of glyphs) biggerOnPhone(line, "h");
  });

  it("grows the suggestion and connect chips, which share one shape", () => {
    const pill = lines(chip, (l) => l.includes("snap-start"))[0];
    biggerOnPhone(pill, "text");
    const well = lines(chip, (l) => l.includes("rounded-full bg-creamDeep"))[0];
    biggerOnPhone(well, "h");
    biggerOnPhone(well, "w");
  });
});
