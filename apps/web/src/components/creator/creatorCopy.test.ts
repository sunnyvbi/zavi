
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(__dirname);
const PAGES = join(__dirname, "..", "..", "app", "creator");
const LIB = join(__dirname, "..", "..", "lib", "creator");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const ALL = [...filesUnder(COMPONENTS), ...filesUnder(PAGES), ...filesUnder(LIB)];

describe("the creator area's source", () => {
  it("has files to check", () => {
    expect(ALL.length).toBeGreaterThan(8);
  });
});

describe("no dashes anywhere a creator can read", () => {
  it.each(ALL)("%s has no em dash, en dash or double hyphen", (file) => {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (/—|–/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
      if (/--/.test(line) && !/var\(--|-{2}[a-z-]+:/.test(line)) {
        offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("the web never computes a fee", () => {
  it.each(ALL)("%s has no fee arithmetic of its own", (file) => {
    const src = readFileSync(file, "utf8");
    const banned = [/\*\s*0?\.15\b/, /\*\s*0?\.85\b/, /\*\s*0?\.10?\b(?!0)/, /\bBPS\b/, /\/\s*10000\b/];
    const hits = banned.filter((re) => re.test(src)).map(String);
    expect(hits, `${file} looks like it computes a fee: ${hits.join(", ")}`).toEqual([]);
  });

  it("formats money by dividing by 100 and nothing else", async () => {
    const { money } = await import("@/lib/creator/api");
    expect(money(0)).toBe("$0");
    expect(money(15000)).toBe("$150");
    expect(money(12750)).toBe("$127.50");
    expect(money(99)).toBe("$0.99");
    expect(money(100000000)).toBe("$1,000,000");
  });

  it("parses a typed price back to integer cents, or refuses it", async () => {
    const { dollarsToCents } = await import("@/lib/creator/api");
    expect(dollarsToCents("150")).toBe(15000);
    expect(dollarsToCents("150.00")).toBe(15000);
    expect(dollarsToCents("150.5")).toBe(15050);
    expect(dollarsToCents("$1,500.25")).toBe(150025);
    expect(dollarsToCents("150.999")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents("-5")).toBeNull();
  });
});
