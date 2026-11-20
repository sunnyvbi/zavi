
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("the two human-trust signals travel together", () => {
  it("every site forwarding untrusted_context also forwards captured_page_context", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/^\s*untrusted_context:\s*ctx\.untrusted_context,\s*$/.test(line)) return;
        const near = lines.slice(i, i + 3).join("\n");
        if (!/captured_page_context:\s*ctx\.captured_page_context,/.test(near)) {
          offenders.push(`${relative(SRC, file)}:${i + 1}`);
        }
      });
    }

    expect(
      offenders,
      "These hops forward the extension taint but DROP the screenshot signal, so " +
        "isHumanAuthoredChat sees undefined downstream and the brain-write and " +
        "spend gates silently stay open for a screenshot turn. Add " +
        "`captured_page_context: ctx.captured_page_context,` beside each.",
    ).toEqual([]);
  });

  it("finds the hops it is meant to be policing", () => {
    let hops = 0;
    for (const file of walk(SRC)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (/^\s*untrusted_context:\s*ctx\.untrusted_context,\s*$/.test(line)) hops += 1;
      }
    }
    expect(hops).toBeGreaterThanOrEqual(7);
  });
});
