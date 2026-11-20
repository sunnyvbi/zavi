
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

function listAgentMdFiles(): string[] {
  if (!fs.existsSync(AGENTS_ROOT)) return [];
  return fs
    .readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && d.name !== "lib")
    .map((d) => path.join(AGENTS_ROOT, d.name, "agent.md"))
    .filter((p) => fs.existsSync(p));
}

describe("agent-default-state-coverage (CI drift guard)", () => {
  it("every agent.md declares an explicit visibility.default_state", () => {
    const files = listAgentMdFiles();
    expect(files.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf-8");
      const fm = matter(raw).data as Record<string, unknown>;
      const meta = (fm.metadata as Record<string, unknown> | undefined) ?? {};
      const praxis = (meta.praxis as Record<string, unknown> | undefined) ?? {};
      const vis = praxis.visibility as Record<string, unknown> | undefined;
      const ds = vis?.default_state;
      if (typeof ds !== "string") {
        missing.push(path.relative(process.cwd(), file));
      }
    }

    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        "Agents missing explicit visibility.default_state:\n  " +
          missing.join("\n  "),
      );
    }
    expect(missing).toEqual([]);
  });

  it("each declared default_state is one of the allowed enum values", () => {
    const files = listAgentMdFiles();
    const allowed = new Set(["enabled", "disabled", "always_on"]);

    const invalid: { file: string; value: unknown }[] = [];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf-8");
      const fm = matter(raw).data as Record<string, unknown>;
      const meta = (fm.metadata as Record<string, unknown> | undefined) ?? {};
      const praxis = (meta.praxis as Record<string, unknown> | undefined) ?? {};
      const vis = praxis.visibility as Record<string, unknown> | undefined;
      const ds = vis?.default_state;
      if (typeof ds === "string" && !allowed.has(ds)) {
        invalid.push({ file: path.relative(process.cwd(), file), value: ds });
      }
    }
    expect(invalid).toEqual([]);
  });
});
