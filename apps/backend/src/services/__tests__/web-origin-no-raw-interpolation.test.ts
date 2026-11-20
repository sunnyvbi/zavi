
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const RAW_INTERPOLATION = /\$\{[^}]*process\.env\.(?:PRAXIS_)?WEB_ORIGIN[^}]*\}/g;

describe("WEB_ORIGIN is never interpolated raw into a URL", () => {
  it("has no `${process.env.WEB_ORIGIN}` without a comma split", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel === "services/web-base.ts" || rel.includes("__tests__")) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.match(RAW_INTERPOLATION) ?? []) {
        if (m.includes("split(")) continue;
        offenders.push(`${rel}: ${m}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
