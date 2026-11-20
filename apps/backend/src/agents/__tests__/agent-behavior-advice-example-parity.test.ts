
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { outputSchemas } from "@/agents/index";

const ADVICE_AGENTS = ["advisor", "seo-geo"] as const;

function agentMd(slug: string): string {
  return readFileSync(path.join(process.cwd(), "src", "agents", slug, "agent.md"), "utf-8");
}

function envelopeExamples(md: string): unknown[] {
  const out: unknown[] = [];
  for (const m of md.matchAll(/```json\n([\s\S]*?)```/g)) {
    const body = m[1];
    if (!body.includes("clarifications_needed") || !body.includes("recommendations")) continue;
    try {
      out.push(JSON.parse(body));
    } catch (e) {
      throw new Error(`agent.md JSON example does not parse: ${(e as Error).message}\n${body.slice(0, 400)}`);
    }
  }
  return out;
}

function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let node: unknown = root;
  for (const seg of path) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<PropertyKey, unknown>)[seg];
  }
  return node;
}

function isPlaceholder(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return v === "..." || /^<.+>$/.test(v.trim()) || v.includes(" | ");
}

function realIssues(schema: z.ZodTypeAny, example: unknown): z.ZodIssue[] {
  const r = schema.safeParse(example);
  if (r.success) return [];
  return r.error.issues.filter(
    (issue) => issue.code === "invalid_type" || !isPlaceholder(valueAtPath(example, issue.path)),
  );
}

type EnumField = { path: string[]; members: string[] };

function enumFields(schema: unknown, path: string[] = [], seen = new Set<unknown>()): EnumField[] {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return [];
  seen.add(schema);
  const def = (schema as { _def?: Record<string, unknown> })._def;
  if (!def) return [];

  if (def.type === "enum" && def.entries && typeof def.entries === "object") {
    return [{ path, members: Object.keys(def.entries as Record<string, unknown>) }];
  }

  const out: EnumField[] = [];
  if (def.type === "object") {
    const shape = typeof def.shape === "function"
      ? (def.shape as () => Record<string, unknown>)()
      : (def.shape as Record<string, unknown> | undefined);
    for (const [key, v] of Object.entries(shape ?? {})) out.push(...enumFields(v, [...path, key], seen));
  }
  if (def.type === "array") out.push(...enumFields(def.element, [...path, "[]"], seen));
  for (const key of ["innerType", "in", "out", "valueType", "schema"]) {
    out.push(...enumFields(def[key], path, seen));
  }
  for (const key of ["options", "items"]) {
    if (Array.isArray(def[key])) for (const c of def[key] as unknown[]) out.push(...enumFields(c, path, seen));
  }
  return out;
}

function populated(example: unknown, path: string[]): boolean {
  if (path.length === 0) return example !== undefined;
  const [head, ...rest] = path;
  if (head === "[]") {
    return Array.isArray(example) && example.some((el) => populated(el, rest));
  }
  if (!example || typeof example !== "object") return false;
  return populated((example as Record<string, unknown>)[head], rest);
}

describe.each(ADVICE_AGENTS)("%s — agent.md teaches the schema it is validated by", (slug) => {
  const md = agentMd(slug);
  const schema = outputSchemas[slug];

  it("registers a schema (without one there is no validation at all)", () => {
    expect(schema).toBeDefined();
  });

  it("ships at least one full envelope example — the model copies it", () => {
    expect(envelopeExamples(md).length).toBeGreaterThan(0);
  });

  it("every envelope example in agent.md VALIDATES against this agent's own schema", () => {
    for (const [i, example] of envelopeExamples(md).entries()) {
      const issues = realIssues(schema, example);
      const why = issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ");
      expect(issues, `example #${i} in ${slug}/agent.md fails its own schema — ${why}`).toEqual([]);
    }
  });

  it("the enum walker actually finds enums (a vacuous check reports bugs as fixed)", () => {
    const fields = enumFields(schema);
    const byPath = new Map(fields.map((f) => [f.path.join("."), f.members]));
    expect(byPath.get("recommendations.decide_today.[].confidence")).toEqual([
      "evidence_grounded",
      "inference",
      "low_confidence_speculation",
    ]);
    expect(byPath.get("diagnosis.stage")).toContain("growth");
  });

  it("names EVERY member of every enum its own example populates", () => {
    const examples = envelopeExamples(md);
    const gaps: string[] = [];
    for (const f of enumFields(schema)) {
      if (!examples.some((e) => populated(e, f.path))) continue;
      const missing = f.members.filter((m) => !md.includes(m));
      if (missing.length > 0) gaps.push(`${f.path.join(".")}: missing ${missing.join(", ")}`);
    }
    expect(gaps, `${slug}/agent.md populates these enums but never names all their values:\n  ${gaps.join("\n  ")}`).toEqual([]);
  });
});

describe("seo-geo — the exact prod parse_failed regression (runs 4998161e / 54348677)", () => {
  const md = agentMd("seo-geo");

  it("shows watch_for as an OBJECT, never an empty array the model must guess at", () => {
    const examples = envelopeExamples(md) as Array<{ recommendations?: { watch_for?: unknown[] } }>;
    const shown = examples.flatMap((e) => e.recommendations?.watch_for ?? []);
    expect(shown.length, "watch_for is empty in every example — this is what broke prod").toBeGreaterThan(0);
    for (const w of shown) {
      expect(typeof w).toBe("object");
      expect(w).toHaveProperty("trigger");
      expect(w).toHaveProperty("what_to_do");
    }
  });

  it("shows a next_30d item carrying confidence", () => {
    const examples = envelopeExamples(md) as Array<{ recommendations?: { next_30d?: Array<{ confidence?: string }> } }>;
    const shown = examples.flatMap((e) => e.recommendations?.next_30d ?? []);
    expect(shown.length).toBeGreaterThan(0);
    for (const item of shown) expect(item.confidence).toBeTruthy();
  });

  it("rejects the two shapes prod actually emitted", () => {
    const schema = outputSchemas["seo-geo"];
    const base = {
      diagnosis: { stage: "growth", goal_restated: "Audit example.com", key_signals: [] },
      research_findings: [],
      dispatch_proposals: [],
      clarifications_needed: false,
      rendered_markdown: "# Audit",
    };
    const item = {
      title: "t",
      rationale: "r",
      evidence_refs: [],
      estimated_impact: "",
      confidence: "evidence_grounded",
    };

    expect(
      schema.safeParse({
        ...base,
        recommendations: { lead_priority: "x", decide_today: [], next_30d: [], watch_for: ["a caveat"] },
      }).success,
    ).toBe(false);

    for (const bad of ["hypothesis", "hypothesis_needs_test"]) {
      expect(
        schema.safeParse({
          ...base,
          recommendations: {
            lead_priority: "x",
            decide_today: [],
            next_30d: [{ ...item, confidence: bad }],
            watch_for: [],
          },
        }).success,
        `${bad} must stay invalid — confidence is a calibration signal, never coerced`,
      ).toBe(false);
    }
  });
});
