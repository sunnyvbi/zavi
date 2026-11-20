import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const src = readFileSync(join(__dirname, "../brainstorm.ts"), "utf8");

const promptText = src.replace(/^\s*\/\/.*$/gm, "");

describe("BUG 4 — the pre-signup surface calls the product Zavi", () => {
  it("no prompt string carries the repo name", () => {
    expect(promptText).not.toMatch(/Praxis/);
  });

  it("both system prompts name Zavi", () => {
    expect(promptText).toMatch(/brainstorming partner for Zavi/);
    expect(promptText).toMatch(/product brainstorming partner for Zavi/);
  });

  it("keeps the note explaining why, so it does not regress quietly", () => {
    expect(src).toMatch(/The product is Zavi\. Never write the\n\/\/ repo name into a customer-visible prompt\./);
  });
});
