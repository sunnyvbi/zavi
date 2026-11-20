
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");
const ALLOWED = new Set(["leadership", "product", "growth", "others"]);

function listAgentMdFiles(): string[] {
  if (!fs.existsSync(AGENTS_ROOT)) return [];
  return fs
    .readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "lib")
    .map((d) => path.join(AGENTS_ROOT, d.name, "agent.md"))
    .filter((p) => fs.existsSync(p));
}

function readDepartment(file: string): unknown {
  const raw = fs.readFileSync(file, "utf-8");
  const fm = matter(raw).data as Record<string, unknown>;
  const meta = (fm.metadata as Record<string, unknown> | undefined) ?? {};
  const praxis = (meta.praxis as Record<string, unknown> | undefined) ?? {};
  return praxis.department;
}

describe("agent-department-coverage (CI drift guard)", () => {
  it("every agent.md declares an explicit metadata.praxis.department", () => {
    const files = listAgentMdFiles();
    expect(files.length).toBeGreaterThan(0);

    const missing = files
      .filter((f) => typeof readDepartment(f) !== "string")
      .map((f) => path.relative(process.cwd(), f));

    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.error("Agents missing metadata.praxis.department:\n  " + missing.join("\n  "));
    }
    expect(missing).toEqual([]);
  });

  it("each declared department is one of the allowed buckets", () => {
    const files = listAgentMdFiles();
    const invalid = files
      .map((f) => ({ file: path.relative(process.cwd(), f), value: readDepartment(f) }))
      .filter((r) => typeof r.value === "string" && !ALLOWED.has(r.value as string));
    expect(invalid).toEqual([]);
  });
});
