import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_DASHBOARDS,
  browserObservedNote,
  groundedRefusalText,
  unrecognizedPageText,
} from "./backend-copy";

const GROUNDING_SRC = join(
  process.cwd(),
  "../backend/src/services/agents/extension-grounding.ts",
);

const source = readFileSync(GROUNDING_SRC, "utf8");

const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

describe("backend-copy mirrors extension-grounding.ts", () => {
  it("found the backend file at all", () => {
    expect(source).toContain("export function unrecognizedPageText");
    expect(source).toContain("export function groundedRefusalText");
    expect(source).toContain("export function browserObservedNote");
    expect(source).toContain("export const SUPPORTED_DASHBOARDS");
  });

  it("every sentence of the unrecognized-page reply is verbatim in the backend", () => {
    const rendered = unrecognizedPageText(["Meta Ads Manager"]);
    for (const sentence of sentencesOf(rendered)) {
      const needle = sentence.startsWith("The dashboards I can read today:")
        ? "The dashboards I can read today:"
        : sentence;
      expect(source).toContain(needle);
    }
    expect(rendered).toContain("The dashboards I can read today: Meta Ads Manager.");
  });

  it("every sentence of the grounded refusal is verbatim in the backend", () => {
    for (const sentence of sentencesOf(groundedRefusalText())) {
      expect(source).toContain(sentence);
    }
  });

  it("the browser-observed note is verbatim in the backend", () => {
    expect(source).toContain(browserObservedNote());
  });

  it("the supported-dashboard list still matches", () => {
    for (const name of SUPPORTED_DASHBOARDS) {
      expect(source).toContain(`"${name}"`);
    }
    const declared = /export const SUPPORTED_DASHBOARDS = \[([^\]]*)\]/.exec(source);
    expect(declared).not.toBeNull();
    const count = (declared?.[1] ?? "").split(",").filter((s) => s.trim()).length;
    expect(count).toBe(SUPPORTED_DASHBOARDS.length);
  });

  it("no em-dashes in copy the operator reads (repo voice rule)", () => {
    for (const text of [
      unrecognizedPageText(),
      groundedRefusalText(),
      browserObservedNote(),
    ]) {
      expect(text).not.toContain("—");
    }
  });
});
