import { describe, it, expect } from "vitest";
import {
  ACTION_LIFECYCLE_AGENTS,
  loadAgentActionLifecycle,
  renderActionLifecycleBlock,
  isActionLifecycleContextEnabled,
  type AgentActionLifecycle,
} from "../action-lifecycle";

describe("ACTION_LIFECYCLE_AGENTS membership", () => {
  it("covers the proposing agents that emit slug-matching decisions", () => {
    for (const slug of [
      "growth-lead",
      "pm",
      "advisor",
      "operator",
      "qa",
      "dispute-response",
      "content-design",
    ]) {
      expect(ACTION_LIFECYCLE_AGENTS.has(slug)).toBe(true);
    }
  });

  it("excludes chief-of-staff (has its own richer continuity loader)", () => {
    expect(ACTION_LIFECYCLE_AGENTS.has("chief-of-staff")).toBe(false);
  });

  it("excludes agents whose decision_class prefix != slug, or non-generic path", () => {
    expect(ACTION_LIFECYCLE_AGENTS.has("performance-marketer")).toBe(false);
    expect(ACTION_LIFECYCLE_AGENTS.has("engineer")).toBe(false);
  });
});

function makeSb(opts: {
  decisions?: Array<{ decision_class: string; status: string; body: unknown }>;
  blob?: Record<string, unknown>;
  error?: boolean;
}) {
  let table = "";
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "like", "or", "gte", "order", "limit"]) {
    builder[m] = () => builder;
  }
  builder.from = (t: string) => {
    table = t;
    return builder;
  };
  builder.maybeSingle = () =>
    Promise.resolve({
      data: opts.error ? null : { blob: opts.blob ?? {} },
      error: opts.error ? { message: "boom" } : null,
    });
  (builder as { then: unknown }).then = (
    onF: (v: { data: unknown; error: unknown }) => unknown,
  ) =>
    onF({
      data: table === "decisions" ? (opts.decisions ?? []) : null,
      error: opts.error ? { message: "boom" } : null,
    });
  return () => builder as never;
}

describe("isActionLifecycleContextEnabled (default ON, opt-out kill switch)", () => {
  it("true when the flag is explicitly true", async () => {
    expect(
      await isActionLifecycleContextEnabled(
        makeSb({ blob: { action_lifecycle_context_enabled: true } })(),
      ),
    ).toBe(true);
  });
  it("true when flag absent (default on)", async () => {
    expect(
      await isActionLifecycleContextEnabled(makeSb({ blob: {} })()),
    ).toBe(true);
  });
  it("true on read error (default on)", async () => {
    expect(
      await isActionLifecycleContextEnabled(makeSb({ error: true })()),
    ).toBe(true);
  });
  it("false ONLY when explicitly set to false (kill switch)", async () => {
    expect(
      await isActionLifecycleContextEnabled(
        makeSb({ blob: { action_lifecycle_context_enabled: false } })(),
      ),
    ).toBe(false);
  });
});

describe("loadAgentActionLifecycle", () => {
  it("groups the agent's own decisions by lifecycle status", async () => {
    const sb = makeSb({
      decisions: [
        { decision_class: "growth-lead.social-draft", status: "proposed", body: { bet_claim: "post to NRI groups" } },
        { decision_class: "growth-lead.lifecycle-draft", status: "acted", body: { bet_claim: "welcome email" } },
        { decision_class: "growth-lead.social-draft", status: "rejected", body: { bet_claim: "paid promo" } },
        { decision_class: "growth-lead.reallocate-budget", status: "expired", body: { title: "shift $500" } },
        { decision_class: "growth-lead.social-draft", status: "superseded", body: {} },
      ],
    })();
    const lc = await loadAgentActionLifecycle("t1", "growth-lead", sb);
    expect(lc).not.toBeNull();
    expect(lc!.pending.map((x) => x.label)).toEqual(["post to NRI groups"]);
    expect(lc!.acted.map((x) => x.label)).toEqual(["welcome email"]);
    expect(lc!.rejected.map((x) => x.label)).toEqual(["paid promo"]);
    expect(lc!.expired.map((x) => x.label)).toEqual(["shift $500"]);
  });

  it("returns null when there are no decisions", async () => {
    expect(
      await loadAgentActionLifecycle("t1", "pm", makeSb({ decisions: [] })()),
    ).toBeNull();
  });

  it("returns null on read error (best-effort)", async () => {
    expect(
      await loadAgentActionLifecycle("t1", "pm", makeSb({ error: true })()),
    ).toBeNull();
  });

  it("content-design DUAL-READS old content-seo.* in-flight decisions", async () => {
    const sb = makeSb({
      decisions: [
        { decision_class: "content-seo.publish-content", status: "proposed", body: { title: "old in-flight post" } },
        { decision_class: "content-design.propose-change", status: "acted", body: { title: "new post" } },
      ],
    })();
    const lc = await loadAgentActionLifecycle("t1", "content-design", sb);
    expect(lc).not.toBeNull();
    expect(lc!.pending.map((x) => x.label)).toEqual(["old in-flight post"]);
    expect(lc!.acted.map((x) => x.label)).toEqual(["new post"]);
  });

  it("falls back to decision_class when body has no readable label", async () => {
    const sb = makeSb({
      decisions: [{ decision_class: "advisor.recommendation", status: "proposed", body: {} }],
    })();
    const lc = await loadAgentActionLifecycle("t1", "advisor", sb);
    expect(lc!.pending[0].label).toBe("advisor.recommendation");
  });
});

describe("renderActionLifecycleBlock", () => {
  it("renders only the non-empty sections", () => {
    const c: AgentActionLifecycle = {
      pending: [{ decision_class: "growth-lead.social-draft", status: "proposed", label: "post X" }],
      acted: [],
      rejected: [{ decision_class: "growth-lead.lifecycle-draft", status: "rejected", label: "promo Y" }],
      expired: [],
    };
    const block = renderActionLifecycleBlock(c);
    expect(block).toContain("Still awaiting the founder (1)");
    expect(block).toContain("post X");
    expect(block).toContain("Declined by the founder (1)");
    expect(block).toContain("promo Y");
    expect(block).not.toContain("Approved & acted");
    expect(block).not.toContain("Expired unacted");
  });

  it("returns empty string when nothing to reconcile", () => {
    expect(
      renderActionLifecycleBlock({ pending: [], acted: [], rejected: [], expired: [] }),
    ).toBe("");
  });
});
