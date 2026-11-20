import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = __dirname;

const SURFACES = {
  "the Integrations/Skills tab row": join(HERE, "ToolkitTab.tsx"),
  "the Skills panel": join(HERE, "ToolkitSkills.tsx"),
  "the Integrations panel": join(HERE, "../SettingsTab.tsx"),
};

function contentColumn(file: string): { maxWidth: string; pad: string; compactPad: string } {
  const source = readFileSync(file, "utf8");
  const match = source
    .match(/"[^"]*"|`[^`]*`/gs)
    ?.find((literal) => literal.includes("mx-auto") && literal.includes("max-w-"));
  if (!match) throw new Error(`${file} has no centred content column`);
  const token = (re: RegExp, last = false) => {
    const hits = [...match.matchAll(new RegExp(re.source, "g"))];
    const hit = last ? hits.at(-1) : hits[0];
    if (!hit) throw new Error(`${file} column is missing ${re}`);
    return hit[0];
  };
  return {
    maxWidth: token(/max-w-\[?[\w.\-]+\]?/, true),
    pad: token(/(?<!compact:)px-\d+/),
    compactPad: token(/compact:px-\d+/),
  };
}

describe("toolkit content column", () => {
  it("starts the tab row on the same left edge as the panel it labels", () => {
    const [reference, ...rest] = Object.entries(SURFACES).map(
      ([name, file]) => [name, contentColumn(file)] as const,
    );
    for (const [name, column] of rest) {
      expect(
        column,
        `${name} sits on a different column from ${reference[0]} — the heading and the tab above it will not line up`,
      ).toEqual(reference[1]);
    }
  });
});
