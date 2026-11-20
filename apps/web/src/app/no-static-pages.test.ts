
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = __dirname;

function segmentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "api") continue;
      out.push(...segmentFiles(p));
    } else if (/^(page|layout|template|default|not-found)\.(t|j)sx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("no statically cached page under middleware", () => {
  it("the root layout forces every page dynamic", () => {
    const src = readFileSync(join(APP, "layout.tsx"), "utf8");
    expect(src).toMatch(/^export const dynamic = "force-dynamic";$/m);
  });

  it("no page, layout or template switches that off", () => {
    const offenders: string[] = [];
    for (const f of segmentFiles(APP)) {
      const src = readFileSync(f, "utf8");
      const rel = relative(APP, f);
      for (const m of src.matchAll(/export\s+const\s+dynamic\s*=\s*["'`]([^"'`]+)["'`]/g)) {
        if (m[1] !== "force-dynamic") offenders.push(`${rel}: dynamic = "${m[1]}"`);
      }
      if (/export\s+const\s+revalidate\s*=/.test(src)) offenders.push(`${rel}: exports revalidate`);
    }
    expect(offenders).toEqual([]);
  });
});
