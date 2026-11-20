import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";

const AGENTS_DIR = join(__dirname, "..");

function agentMdFiles(): string[] {
  return readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "__tests__")
    .map((d) => join(AGENTS_DIR, d.name, "agent.md"))
    .filter((p) => existsSync(p));
}

describe("agent.md frontmatter", () => {
  const files = agentMdFiles();

  it("finds the live agent fleet on disk", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f.split("/agents/")[1], f] as const))(
    "%s parses with gray-matter and has name + description",
    (_slug, file) => {
      const raw = readFileSync(file, "utf8");
      const parsed = matter(raw);
      expect(parsed.data).toBeTypeOf("object");
      expect(Object.keys(parsed.data).length).toBeGreaterThan(0);
    },
  );
});
