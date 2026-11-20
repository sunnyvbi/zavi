
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const AGENTS_ROOT = path.join(process.cwd(), "src", "agents");

export const OUTPUT_BAR_MARKER_RE = /^##\s+Output bar \/ Done criteria\s*$/im;

const NEGATIVE_EXAMPLE_RE = /does NOT count as done/i;

function listAgentSlugs(): string[] {
  return readdirSync(AGENTS_ROOT)
    .filter((entry) => {
      if (entry.startsWith("_") || entry.startsWith(".")) return false;
      const full = path.join(AGENTS_ROOT, entry);
      if (!statSync(full).isDirectory()) return false;
      return existsSync(path.join(full, "agent.md"));
    })
    .sort();
}

function readAgentRaw(slug: string): string {
  return readFileSync(path.join(AGENTS_ROOT, slug, "agent.md"), "utf-8");
}

export function isVisibleAgent(raw: string): boolean {
  const fm = matter(raw).data as Record<string, unknown>;
  const praxis = (fm.metadata as Record<string, unknown> | undefined)?.praxis as
    | Record<string, unknown>
    | undefined;
  const visibility = praxis?.visibility as Record<string, unknown> | undefined;
  const state = visibility?.default_state;
  return state !== "disabled";
}

function hasOutputBarSection(raw: string): boolean {
  const body = matter(raw).content;
  return OUTPUT_BAR_MARKER_RE.test(body);
}

describe("agent-output-bar-lint (Move 6)", () => {
  const slugs = listAgentSlugs();
  const visibleSlugs = slugs.filter((s) => isVisibleAgent(readAgentRaw(s)));

  it("finds the agent fleet on disk (sanity check)", () => {
    expect(slugs.length).toBeGreaterThan(10);
    for (const canonical of ["engineer", "cgo", "pm", "qa", "operator"]) {
      expect(slugs).toContain(canonical);
      expect(visibleSlugs).toContain(canonical);
    }
    expect(visibleSlugs.length).toBeGreaterThanOrEqual(10);
  });

  it("every VISIBLE agent.md carries the standardized Output bar / Done criteria section", () => {
    const missing: string[] = [];
    for (const slug of visibleSlugs) {
      if (!hasOutputBarSection(readAgentRaw(slug))) {
        missing.push(slug);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Move 6 finish-line lint: these VISIBLE agents are missing the ` +
          `"## Output bar / Done criteria" section (what a good finished result ` +
          `looks like + what does NOT count as done, with a concrete negative ` +
          `example):\n  - ${missing.join("\n  - ")}\n` +
          `Add the section to each agent.md before merging.`,
      );
    }
  });

  it("every Output bar section includes a concrete negative example", () => {
    const noNegative: string[] = [];
    for (const slug of visibleSlugs) {
      const raw = readAgentRaw(slug);
      if (!hasOutputBarSection(raw)) continue;
      if (!NEGATIVE_EXAMPLE_RE.test(matter(raw).content)) {
        noNegative.push(slug);
      }
    }
    if (noNegative.length > 0) {
      throw new Error(
        `Move 6 finish-line lint: these agents have the Output bar heading but ` +
          `no concrete negative example (missing the "does NOT count as done" ` +
          `case):\n  - ${noNegative.join("\n  - ")}`,
      );
    }
  });

  it("negative control: the marker predicate fires only on the real heading", () => {
    const good = [
      "# some agent",
      "",
      "## Output bar / Done criteria",
      "",
      "**Done means:** a real, grounded result.",
      "",
      '**NOT done:** hand-waving. Concrete example that does NOT count as done: "empty output".',
      "",
    ].join("\n");
    expect(OUTPUT_BAR_MARKER_RE.test(good)).toBe(true);
    expect(NEGATIVE_EXAMPLE_RE.test(good)).toBe(true);

    const looksLike = [
      "# some agent",
      "",
      "Our output bar is high and we hold a done criteria in our heads.",
      "",
    ].join("\n");
    expect(OUTPUT_BAR_MARKER_RE.test(looksLike)).toBe(false);

    const missing = [
      "# some agent",
      "",
      "## Role",
      "Does a thing.",
      "",
      "## Output envelope",
      "Wrap output in tags.",
      "",
    ].join("\n");
    expect(OUTPUT_BAR_MARKER_RE.test(missing)).toBe(false);
  });

  it("negative control: a heading without a negative example fails the second gate", () => {
    const headingOnly = [
      "## Output bar / Done criteria",
      "",
      "**Done means:** a good result. And that's it — no failing case stated.",
      "",
    ].join("\n");
    expect(OUTPUT_BAR_MARKER_RE.test(headingOnly)).toBe(true);
    expect(NEGATIVE_EXAMPLE_RE.test(headingOnly)).toBe(false);
  });

  it("negative control: isVisibleAgent tracks the default_state field", () => {
    const enabled = `---
name: x
metadata:
  praxis:
    visibility:
      default_state: enabled
---
body`;
    const alwaysOn = `---
name: x
metadata:
  praxis:
    visibility:
      default_state: always_on
---
body`;
    const disabled = `---
name: x
metadata:
  praxis:
    visibility:
      default_state: disabled
---
body`;
    const noField = `---
name: x
metadata:
  praxis: {}
---
body`;
    expect(isVisibleAgent(enabled)).toBe(true);
    expect(isVisibleAgent(alwaysOn)).toBe(true);
    expect(isVisibleAgent(disabled)).toBe(false);
    expect(isVisibleAgent(noField)).toBe(true);
  });
});
