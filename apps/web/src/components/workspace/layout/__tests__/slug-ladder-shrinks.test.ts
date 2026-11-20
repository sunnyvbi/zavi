
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LAYOUT_DIR = fileURLToPath(new URL("..", import.meta.url));

const PAGE_LADDER: string[] = [];

const ICON_ONLY: string[] = [];

const LADDER = [...PAGE_LADDER, ...ICON_ONLY];

const SLUG_COMPARE = /channel\.slug\s*[!=]==\s*"([a-z_]+)"/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function laddered(dir: string = LAYOUT_DIR): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(dir)) {
    for (const m of readFileSync(file, "utf8").matchAll(SLUG_COMPARE)) found.add(m[1]);
  }
  return [...found].sort();
}

describe("the channel slug ladder in layout/ only shrinks", () => {
  const found = laddered();

  it("reads no slug that is not on the ladder", () => {
    const added = found.filter((s) => !LADDER.includes(s));
    expect(
      added,
      "A new channel must be a row in actions/platforms.ts, not a branch here. See ChannelPanel.",
    ).toEqual([]);
  });

  it("stays honest: an entry that no longer appears must come OFF the list", () => {
    const stale = LADDER.filter((s) => !found.includes(s));
    expect(stale, "This channel reduced to a row — delete it from LADDER so the guard cannot grow back").toEqual([]);
  });

  it("is not blind: the scanner still finds a read that is really there", () => {
    const planted = mkdtempSync(join(tmpdir(), "slug-ladder-"));
    try {
      writeFileSync(
        join(planted, "Planted.tsx"),
        'const x = channel.slug === "planted_channel" ? 1 : 2;\n',
      );
      expect(laddered(planted)).toEqual(["planted_channel"]);
    } finally {
      rmSync(planted, { recursive: true, force: true });
    }
  });

  it("holds the PAGE ladder at exactly the slugs above, which is what the later slices reduce", () => {
    expect(found.filter((s) => PAGE_LADDER.includes(s)).sort()).toEqual([...PAGE_LADDER].sort());
  });
});
