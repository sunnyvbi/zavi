
import { describe, expect, it } from "vitest";
import * as zod from "zod";
import { outputSchemas } from "@/agents";
import { __DISPLAY_CAPS, coerceEnvelope } from "@/services/agents/envelope-coerce";
import { prProposalModelOutputSchema, prProposalSchema } from "@/agents/engineer/output-schema";

type Capped = { path: string; cap: number; kind: "string" | "array"; clamped: boolean };

function core(schema: unknown): any {
  let node: any = schema;
  for (let i = 0; i < 12; i++) {
    const def = node?._zod?.def;
    if (!def) break;
    if (
      ["optional", "default", "nullable", "nonoptional", "prefault", "readonly", "catch"].includes(
        def.type,
      )
    ) {
      node = def.innerType ?? def.in;
      continue;
    }
    break;
  }
  return node;
}

const maxCheck = (node: any): number | null => {
  const c = (node?._zod?.def?.checks || []).find(
    (k: any) => k?._zod?.def?.check === "max_length",
  );
  return c ? c._zod.def.maximum : null;
};

const hasOverwrite = (node: any): boolean =>
  (node?._zod?.def?.checks || []).some((k: any) => k?._zod?.def?.check === "overwrite");

const isPreprocessPipe = (node: any): boolean =>
  node?._zod?.def?.type === "pipe" && node?._zod?.def?.in?._zod?.def?.type === "transform";

function walk(schema: unknown, path: string, out: Capped[], depth = 0): void {
  if (depth > 14) return;
  const node = core(schema);
  const def = node?._zod?.def;
  if (!def) return;

  if (def.type === "pipe") {
    if (isPreprocessPipe(node)) {
      const inner: Capped[] = [];
      walk(def.out, path, inner, depth + 1);
      inner.forEach((f) => out.push({ ...f, clamped: true }));
      return;
    }
    const outIsTransform = def.out?._zod?.def?.type === "transform";
    walk(outIsTransform ? def.in : def.out, path, out, depth + 1);
    return;
  }

  if (def.type === "string") {
    const cap = maxCheck(node);
    if (cap != null) out.push({ path, cap, kind: "string", clamped: hasOverwrite(node) });
    return;
  }

  if (def.type === "array") {
    const cap = maxCheck(node);
    if (cap != null) out.push({ path, cap, kind: "array", clamped: false });
    walk(def.element, `${path}[]`, out, depth + 1);
    return;
  }

  if (def.type === "object") {
    for (const [key, child] of Object.entries(def.shape || {})) {
      walk(child, path ? `${path}.${key}` : key, out, depth + 1);
    }
    return;
  }

  if (def.type === "union") {
    for (const option of def.options || []) walk(option, path, out, depth + 1);
    return;
  }

  if (def.type === "record") {
    walk(def.valueType, `${path}{}`, out, depth + 1);
    return;
  }
}

export const __walkForBaseline = (schema: unknown): Capped[] => dedupe(collect(schema));

const collect = (schema: unknown): Capped[] => {
  const out: Capped[] = [];
  walk(schema, "", out);
  return out;
};

const dedupe = (found: Capped[]): Capped[] => {
  const byPath = new Map<string, Capped>();
  for (const f of found) {
    const prior = byPath.get(f.path);
    if (!prior) byPath.set(f.path, f);
    else if (f.clamped && !prior.clamped) byPath.set(f.path, f);
  }
  return [...byPath.values()];
};

const capNumber = (c: unknown): number =>
  typeof c === "number" ? c : (c as any).maxItems ?? (c as any).max;

const STRICT_BY_DESIGN: Record<string, Record<string, number>> = {
  "seo-geo": {
    close_recommendations: 10,
    "close_recommendations[].reason": 200,
    dispatch_proposals: 5,
    "dispatch_proposals[].agent_slug": 64,
    "research_findings[].evidence": 5,
    "research_findings[].evidence[].ref": 600,
    "recommendations.decide_today[].evidence_refs": 5,
    "recommendations.decide_today[].evidence_refs[]": 300,
    "recommendations.next_30d[].evidence_refs": 5,
    "recommendations.next_30d[].evidence_refs[]": 300,
  },
  "advisor": {
    "close_recommendations": 10,
    "dispatch_proposals": 5,
    "dispatch_proposals[].agent_slug": 64,
  },
  "chief-of-staff": {
    "tier1[].suggested_dispatch.intent": 2000,
  },
  "dispute-response": {
    "evidence_packet.evidence_due_by": 40,
    "evidence_packet.evidence_fields.customer_communication": 20000,
    "evidence_packet.evidence_fields.customer_purchase_ip": 64,
    "evidence_packet.evidence_fields.receipt": 20000,
    "evidence_packet.evidence_fields.service_documentation": 20000,
    "evidence_packet.evidence_fields.shipping_documentation": 20000,
    "evidence_packet.evidence_fields.uncategorized_text": 20000,
    "evidence_packet.field_sources{}": 300,
    "evidence_packet.omitted_fields": 20,
    "evidence_packet.omitted_fields[]": 120,
  },
  "engineer": {
    "app_verify_result.path": 512,
    "base_branch": 120,
    "base_branches": 5,
    "base_branches[]": 120,
    "carried_constant_notes[].name": 200,
    "carried_constant_notes[].source_path": 512,
    "diagnosis.root_cause_symbol": 200,
    "head_branch": 120,
    "preview_path": 300,
  },
  "fundraising": {
    "advice.meeting_prep.objections[].key": 120,
    "advice.meeting_prep.objections[].source_ref": 400,
    "advice.objection_answer.key": 120,
    "advice.objection_answer.source_ref": 400,
    "advice.readiness[].key": 120,
    "advice.readiness[].source_ref": 400,
    "advice.round_design.ask": 200,
    "advice.round_design.cap": 200,
    "advice.round_design.dilution_pct": 40,
    "advice.round_design.runway_months": 40,
    "advice.round_design.source_ref": 400,
    "investors": 300,
    "investors[].firm": 300,
    "investors[].name": 200,
    "investors[].source_url": 600,
    "deep.firm": 300,
    "deep.identity_key": 400,
    "deep.name": 200,
    "deep.sources": 40,
    "deep.sources[].url": 600,
  },
  "pm": {
    "artifact_label": 120,
    "snapshot_run_id": 120,
  },
  "qa": {
    "tier1[].suggested_dispatch.intent": 2000,
  },
};

const GRANDFATHERED: Record<string, Record<string, number>> = {
  "advisor": {
    "close_recommendations[].reason": 200,
    "diagnosis.key_signals": 8,
    "recommendations.decide_today[].evidence_refs": 5,
    "recommendations.decide_today[].evidence_refs[]": 300,
    "recommendations.next_30d": 8,
    "recommendations.next_30d[].evidence_refs": 5,
    "recommendations.next_30d[].evidence_refs[]": 300,
    "recommendations.watch_for": 5,
    "research_findings": 8,
    "research_findings[].evidence": 5,
    "research_findings[].evidence[].ref": 600,
  },
  "dispute-response": {
    "rendered_markdown": 20000,
  },
  "engineer": {
    "carried_constant_notes": 20,
    "carried_constant_notes[].why_it_holds": 1000,
  },
  "fundraising": {
    "advice.donts": 8,
    "advice.donts[]": 400,
    "advice.dos": 8,
    "advice.dos[]": 400,
    "advice.meeting_prep.objections": 6,
    "advice.meeting_prep.objections[].verdict": 2000,
    "advice.meeting_prep.partner": 200,
    "advice.meeting_prep.questions": 6,
    "advice.meeting_prep.questions[]": 400,
    "advice.meeting_prep.thesis": 2000,
    "advice.objection_answer.verdict": 2000,
    "advice.readiness": 12,
    "advice.readiness[].verdict": 2000,
    "advice.round_design.verdict": 2000,
    "cadence": 1000,
    "investors[].check_size": 200,
    "investors[].contact_hint": 600,
    "investors[].copy_variants.cold_email.body": 8000,
    "investors[].copy_variants.cold_email.subject": 200,
    "investors[].copy_variants.followup_1": 2000,
    "investors[].copy_variants.followup_2": 2000,
    "investors[].copy_variants.linkedin_dm": 1500,
    "investors[].copy_variants.warm_intro_blurb": 1500,
    "investors[].focus": 600,
    "investors[].stage_focus": 300,
    "investors[].suggested_message": 1500,
    "rendered_markdown": 40000,
    "rollout_plan": 4000,
    "stage": 60,
    "stage_rationale": 600,
  },
  "pm": {
    "status_reason": 500,
    "strategy.clarifications_needed.questions": 5,
    "strategy.clarifications_needed.questions[]": 400,
    "strategy.premise_check": 1200,
    "strategy.reframe_options": 7,
    "strategy.reframe_options[].metrics[]": 200,
    "strategy.reframe_options[].rationale": 1200,
    "strategy.reframe_options[].title": 200,
    "strategy.research_findings": 8,
    "strategy.research_findings[].source": 300,
    "strategy.research_findings[].summary": 800,
    "summary.top_theme": 200,
  },
};

function unprotected(
  slug: string,
  schema: unknown,
  registered: Record<string, unknown>,
): Capped[] {
  const strict = STRICT_BY_DESIGN[slug] ?? {};
  const baseline = GRANDFATHERED[slug] ?? {};
  return dedupe(collect(schema)).filter(
    (f) =>
      !f.clamped &&
      !(f.path in registered) &&
      strict[f.path] !== f.cap &&
      baseline[f.path] !== f.cap,
  );
}

describe("output-cap coverage ratchet", () => {
  const agents = Object.entries(outputSchemas);

  it("registers every agent that has a model-output schema", () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  it("has no NEW unprotected capped field (ratchet: baseline may shrink, never grow)", () => {
    const offenders: string[] = [];

    for (const [slug, schema] of agents) {
      const found = dedupe(collect(schema));

      const registered = (__DISPLAY_CAPS as Record<string, Record<string, unknown>>)[slug] ?? {};
      const baseline = GRANDFATHERED[slug] ?? {};
      const strict = STRICT_BY_DESIGN[slug] ?? {};

      for (const field of found) {
        if (field.clamped) continue;
        if (field.path in registered) continue;
        if (strict[field.path] === field.cap) continue;
        if (baseline[field.path] === field.cap) continue;
        offenders.push(
          `${slug}: ${field.path} (${field.kind} cap ${field.cap}) is capped but has ` +
            `no coercion. If it is display prose, register it in DISPLAY_CAPS. If ` +
            `truncating it would corrupt an identifier, a count, evidence, or a ` +
            `verified substring, add it to STRICT_BY_DESIGN with a reason. Do NOT ` +
            `add it to GRANDFATHERED — that list is frozen.`,
        );
      }
    }

    if (offenders.length) console.log("\nUNPROTECTED CAPPED FIELDS:\n" + offenders.join("\n"));
    expect(offenders).toEqual([]);
  });

  it("keeps every DISPLAY_CAPS entry pointing at a real field with an EQUAL cap (no drift, no phantoms)", () => {
    const problems: string[] = [];

    for (const [slug, schema] of agents) {
      const registered = (__DISPLAY_CAPS as Record<string, Record<string, unknown>>)[slug];
      if (!registered) continue;

      const byPath = new Map(dedupe(collect(schema)).map((f) => [f.path, f]));

      for (const [path, cap] of Object.entries(registered)) {
        const actual = byPath.get(path);
        if (!actual) {
          problems.push(`${slug}: DISPLAY_CAPS path '${path}' matches no capped field in the schema`);
          continue;
        }
        if (capNumber(cap) !== actual.cap) {
          problems.push(
            `${slug}: DISPLAY_CAPS '${path}' = ${capNumber(cap)} but the schema says ` +
              `${actual.cap} — a coercer that truncates to the WRONG bound either ` +
              `mangles good output or fails to save the envelope.`,
          );
        }
      }
    }

    if (problems.length) console.log("\nDISPLAY_CAPS DRIFT / PHANTOMS:\n" + problems.join("\n"));
    expect(problems).toEqual([]);
  });
});

describe("ratchet has teeth (synthetic schemas)", () => {
  const z = zod;

  it("FLAGS a newly added unregistered capped prose field", () => {
    const schema = z.object({ shiny_new_summary: z.string().max(300).optional() });
    const found = unprotected("engineer", schema, {});
    expect(found.map((f) => f.path)).toEqual(["shiny_new_summary"]);
  });

  it("FLAGS a capped field nested behind .optional() inside an object — the be3bf4af shape", () => {
    const schema = z.object({
      diagnosis: z.object({ some_new_reason: z.string().max(500).optional() }).optional(),
    });
    expect(unprotected("engineer", schema, {}).map((f) => f.path)).toEqual([
      "diagnosis.some_new_reason",
    ]);
  });

  it("FLAGS a new array COUNT cap (the advisor/pm failure mode)", () => {
    const schema = z.object({ picks: z.array(z.string()).max(4).default([]) });
    const found = unprotected("advisor", schema, {});
    expect(found).toEqual([{ path: "picks", cap: 4, kind: "array", clamped: false }]);
  });

  it("does NOT flag a field that is registered in DISPLAY_CAPS", () => {
    const schema = z.object({ blurb: z.string().max(300) });
    expect(unprotected("engineer", schema, { blurb: 300 })).toEqual([]);
  });

  it("does NOT flag a field the schema already clamps itself (preprocess / overwrite)", () => {
    const viaPreprocess = z.object({
      a: z.preprocess((v) => v, z.string().max(300)),
    });
    const viaOverwrite = z.object({
      b: z.string().overwrite((v) => v).max(300),
    });
    expect(unprotected("engineer", viaPreprocess, {})).toEqual([]);
    expect(unprotected("engineer", viaOverwrite, {})).toEqual([]);
  });

  it("SEES capped fields behind .transform() (the false-negative that hid 134 fields)", () => {
    const schema = z.object({
      wrapped: z
        .object({ inner_note: z.string().max(600) })
        .nullish()
        .transform((v) => v ?? undefined),
    });
    expect(unprotected("engineer", schema, {}).map((f) => f.path)).toEqual([
      "wrapped.inner_note",
    ]);
  });
});

describe("be3bf4af incident replay", () => {
  const envelope = () => ({
    repo: "acme/widgets",
    base_branch: "main",
    head_branch: "engineer/abc123",
    title: "Cancel pending trips when a user is auto-rejected",
    body: "Auto-reject flipped userVerificationStatus but never cancelled bookings.",
    risk_class: "medium" as const,
    typecheck_ok: true,
    test_results: { passed: 5, failed: 0, output_tail: "5 passed" },
    diagnosis: {
      root_cause_symbol: "userController.ts",
      reproduced: false,
      not_reproduced_reason: "R".repeat(579),
    },
  });

  it("BEFORE coercion the envelope is rejected — this is what discarded the run", () => {
    const r = prProposalModelOutputSchema.safeParse(envelope());
    expect(r.success).toBe(false);
    const issue = r.success ? null : r.error.issues[0];
    expect(issue?.path.join(".")).toBe("diagnosis.not_reproduced_reason");
  });

  it("AFTER coercion it parses, and the coercion is reported", () => {
    const c = coerceEnvelope("engineer", envelope());
    expect(prProposalModelOutputSchema.safeParse(c.value).success).toBe(true);
    expect(c.notes.join(" ")).toContain("not_reproduced_reason");
  });

  it("the reproduce-first escape hatch survives truncation (still non-empty)", () => {
    const c = coerceEnvelope("engineer", envelope()) as { value: any };
    const reason = c.value.diagnosis.not_reproduced_reason as string;
    expect(reason.trim().length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(500);
  });

  it("root_cause_symbol is NEVER truncated (anti-mock gate integrity)", () => {
    const long = "@scope/package/deeply/nested/subpath".padEnd(260, "x");
    const c = coerceEnvelope("engineer", {
      ...envelope(),
      diagnosis: { ...envelope().diagnosis, root_cause_symbol: long },
    }) as { value: any };
    expect(c.value.diagnosis.root_cause_symbol).toBe(long);
  });

  it("the DISPATCH schema is unaffected — an oversized server body still REJECTS", () => {
    const r = prProposalSchema.safeParse({ ...envelope(), files: [] });
    expect(r.success).toBe(false);
  });

  it("output_tail truncation keeps the TAIL — the failing assertion, not the banner", () => {
    const log = "boilerplate ".repeat(600) + "FAILED: expected 1 to be 2";
    const c = coerceEnvelope("engineer", {
      ...envelope(),
      test_results: { passed: 0, failed: 1, output_tail: log },
    }) as { value: any };
    expect(c.value.test_results.output_tail).toContain("FAILED: expected 1 to be 2");
  });
});

const EMPTY_BY_DESIGN: Record<string, string[]> = {
  fundraising: ["investors[].evidence_text", "investors[].evidence_span"],
};

describe("caps whose direction is load-bearing keep that direction", () => {
  it("never truncates a re-verified evidence field to a plausible prefix", () => {
    const caps = __DISPLAY_CAPS as Record<string, Record<string, unknown>>;
    for (const [slug, paths] of Object.entries(EMPTY_BY_DESIGN)) {
      for (const path of paths) {
        const cap = caps[slug]?.[path];
        expect(
          cap,
          `${slug}: '${path}' must stay registered in DISPLAY_CAPS`,
        ).toBeDefined();
        expect(
          (cap as { direction?: string }).direction,
          `${slug}: '${path}' must use direction "empty" — truncating a verbatim ` +
            `evidence substring can turn a span the grounding gate would REJECT ` +
            `into a prefix it accepts.`,
        ).toBe("empty");
      }
    }
  });
});
