
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  readToolEvidence,
  findUnsourcedFigures,
  cutSentencesWithFigures,
  patchArtifactText,
  artifactBelongsToTenant,
  groundChannelDeliverables,
  type GroundingDeps,
} from "@/agents/lib/ground-channel-deliverables";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { recordFigures, recordUrls, clearFigures } from "@/services/agents/engine/figure-ledger";

const ctx = { runId: "run-1", tenant_id: "t-1" } as unknown as AgentContext;
const result = {} as DispatcherResult;

const post =
  "Your first session is free. Browse India-based tutors and message them directly.";

const envelope = {
  rendered_markdown: "## Week",
  steps: [
    {
      title: "Post this on Tuesday",
      body: "Why.",
      blocking: false,
      effort: "minutes",
      evidence: ["fetched https://acme.test/pricing"],
      deliverable: { kind: "post", label: "Tuesday post", content: post },
    },
    {
      title: "Connect your account",
      body: "Why.",
      blocking: false,
      effort: "minutes",
      evidence: ["no account linked"],
    },
  ],
};

function deps(over: Partial<GroundingDeps> = {}): GroundingDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    enabled: () => true,
    resyncArtifacts: async () => ({ patched: 0, unpatchable: 0 }),
    pages: () => [{ url: "https://acme.test/pricing", text: "Trials are offered where a tutor chooses to." }],
    facts: async () => [{ key: "domain", value: "acme.test" }],
    log: () => {},
    ...over,
  };
}

const firstContent = (out: { envelope: unknown }) =>
  (out.envelope as typeof envelope).steps[0].deliverable?.content;

describe("groundChannelDeliverables", () => {
  it("does nothing when disabled or when no step carries a deliverable", async () => {
    const off = await groundChannelDeliverables(envelope, ctx, {}, result, deps({ enabled: () => false }));
    expect(off.envelope).toBe(envelope);
    const none = { ...envelope, steps: [envelope.steps[1]] };
    const skipped = await groundChannelDeliverables(none, ctx, {}, result, deps());
    expect(skipped.envelope).toBe(none);
  });

  it("does not guess when the run read no page, even with stored facts", async () => {
    const out = await groundChannelDeliverables(
      envelope, ctx, {}, result,
      deps({ pages: () => [] }),
    );
    expect(out.envelope).toBe(envelope);
  });

});

describe("groundChannelDeliverables guards", () => {
  it("survives a throwing evidence read without losing the run", async () => {
    const out = await groundChannelDeliverables(
      envelope, ctx, {}, result,
      deps({ pages: () => { throw new Error("ledger gone"); } }),
    );
    expect(firstContent(out)).toBe(post);
  });

});

describe("groundChannelDeliverables — the audit copy is scrubbed too", () => {
  const withAudit = {
    ...envelope,
    rendered_markdown: `## Week\n\nTuesday post:\n\n${post}\n\nThat is the plan.`,
  };

  it("leaves the audit alone when the copy is not quoted in it", async () => {
    const out = await groundChannelDeliverables(envelope, ctx, {}, result, deps());
    expect((out.envelope as typeof envelope).rendered_markdown).toBe("## Week");
  });

  it("leaves the audit alone when nothing in the copy fails a check", async () => {
    const out = await groundChannelDeliverables(withAudit, ctx, {}, result, deps());
    expect((out.envelope as typeof withAudit).rendered_markdown).toContain("first session is free");
  });
});

describe("grounding evidence includes the run's own read-tool results (2026-09-17)", () => {
  const searchResult = {
    tool_calls: [
      {
        name: "mcp__server__web_search__search",
        status: "ok",
        input_preview: "{}",
        output_preview: '{"results":[{"title":"Acme","snippet":"Acme now serves 17,000 paying teams"}]}',
        ms: 1,
      },
      { name: "mcp__server__social__propose_post", status: "ok", input_preview: "{}", output_preview: "staged", ms: 1 },
      { name: "mcp__server__web_search__search", status: "tool_error", input_preview: "{}", output_preview: "boom", ms: 1 },
    ],
  } as unknown as DispatcherResult;

  it("reads ok search results and skips write tools and errors", () => {
    const ev = readToolEvidence(searchResult);
    expect(ev).toHaveLength(1);
    expect(ev[0].name).toBe("web_search__search");
  });

});

describe("the artifact follows the card (2026-09-17)", () => {
  const RUN = "run-1";
  beforeEach(() => {
    clearFigures(RUN);
    recordUrls(RUN, JSON.stringify({ final_url: "https://acme.test/services/" }));
  });
  afterEach(() => clearFigures(RUN));

  it("passes every accepted edit to the artifact resync and logs the counts", async () => {
    const original = "Step one. Confirmed on site this run at https://acme.test/blog/rule/. Book a slot today.";
    const seen: Array<{ tenant_id: string; run_id: string; edits: Array<{ from: string; to: string }> }> = [];
    const logs: Array<Record<string, unknown>> = [];
    await groundChannelDeliverables(({
      rendered_markdown: original,
      steps: [{ title: "Post this", body: "Why.", blocking: false, effort: "minutes", evidence: ["fetched https://example.test/"], deliverable: { kind: "post", label: "Post", content: original } }],
    }), ctx, {}, result, deps({
      resyncArtifacts: async (tenant_id, run_id, edits) => {
        seen.push({ tenant_id, run_id, edits });
        return { patched: 1, unpatchable: 2 };
      },
      log: (_code, meta) => logs.push(meta),
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0].run_id).toBe("run-1");
    expect(seen[0].tenant_id).toBe("t-1");
    expect(seen[0].edits[0].from).toBe(original);
    expect(seen[0].edits[0].to).not.toContain("acme.test/blog/rule");
    expect(logs.at(-1)).toMatchObject({ artifacts_patched: 1, artifacts_unpatchable: 2 });
  });

  it("does not touch artifacts when nothing was rewritten", async () => {
    let called = 0;
    await groundChannelDeliverables(envelope, ctx, {}, result, deps({
      resyncArtifacts: async () => { called += 1; return { patched: 0, unpatchable: 0 }; },
    }));
    expect(called).toBe(0);
  });

  it("keeps the grounded cards when the artifact resync throws", async () => {
    const original = "Step one. Confirmed on site this run at https://acme.test/blog/rule/. Book a slot today.";
    const out = await groundChannelDeliverables(({
      rendered_markdown: original,
      steps: [{ title: "Post this", body: "Why.", blocking: false, effort: "minutes", evidence: ["fetched https://example.test/"], deliverable: { kind: "post", label: "Post", content: original } }],
    }), ctx, {}, result, deps({
      resyncArtifacts: async () => {
        throw new Error("storage down");
      },
    }));
    const step0 = (out.envelope as { steps: Array<{ deliverable: { content: string } }> }).steps[0];
    expect(step0.deliverable.content).not.toContain("acme.test/blog/rule");
    expect(step0.deliverable.content).toContain("Book a slot today.");
  });
});

describe("a figure attributed to an outside source must exist in what the run read (2026-09-17)", () => {
  const evidence = [
    'TOOL RESULT apify__scrape_reddit',
    '{"communities":[{"name":"SomeTown","subscribers":270219}],"posts":[{"title":"a post","score":4832,"comments":332}]}',
  ].join("\n");

  it("catches a fabricated thread and subscriber count", () => {
    const copy =
      "Built from: the r/HomeThings tankless discussion, 998 score, 1,414 comments. That community has 4,832,820 subscribers.";
    expect(findUnsourcedFigures(copy, evidence).sort()).toEqual(["1,414", "4,832,820", "998"]);
  });

  it("leaves figures that really are in the evidence alone", () => {
    const copy = "r/SomeTown has 270,219 subscribers and the post scored 4,832.";
    expect(findUnsourcedFigures(copy, evidence)).toEqual([]);
  });

  it("does not touch money, budgets, dates or arithmetic the model did itself", () => {
    for (const copy of [
      "Start at $5/day for 14 days, then review.",
      "Cap the test at $250 and stop if cost per lead passes $85.",
      "Launch on 2026-10-01 and read it back after 28 days.",
      "Headline is 57 characters, inside the 80 limit.",
      "Three ad groups, two creatives each.",
    ]) {
      expect([copy, findUnsourcedFigures(copy, evidence)]).toEqual([copy, []]);
    }
  });

  it("only looks at sentences that point somewhere outside the company", () => {
    const copy = "We booked 4,318 jobs last quarter.";
    expect(findUnsourcedFigures(copy, evidence)).toEqual([]);
  });

  it("cuts the whole sentence carrying the figure and leaves the rest readable", () => {
    const copy =
      "Run this in the local community. That community has 4,832,820 subscribers. Post at 8am.";
    const out = cutSentencesWithFigures(copy, ["4,832,820"]);
    expect(out).toBe("Run this in the local community. Post at 8am.");
  });

  it("cuts a fabricated figure the verifier failed to remove, and tells the artifact", async () => {
    const copy =
      "Ad group three targets that community. Built from a thread with 998 score and 1,414 comments. Budget stays at $5/day.";
    const envelope = {
      rendered_markdown: copy,
      steps: [{ title: "Paste sheet", body: "Why.", blocking: false, effort: "minutes", evidence: ["scraped this run"], deliverable: { kind: "ad_variants", label: "Sheet", content: copy } }],
    };
    const seen: Array<{ from: string; to: string }> = [];
    const logs: Array<Record<string, unknown>> = [];
    const out = await groundChannelDeliverables(envelope, ctx, {}, result, deps({
      pages: () => [{ url: "https://acme.test/", text: "Local plumbing services." }],
      resyncArtifacts: async (_tenant, _run, edits) => { seen.push(...edits); return { patched: 1, unpatchable: 0 }; },
      log: (_code, meta) => logs.push(meta),
    }));
    const content = firstContent(out) as string;
    expect(content).not.toContain("998");
    expect(content).not.toContain("1,414");
    expect(content).toContain("Budget stays at $5/day.");
    expect(seen).toHaveLength(1);
    expect(logs.at(-1)).toMatchObject({ figures_cut: 2, artifacts_patched: 1 });
  });

  it("keeps the copy when cutting the figures would gut it", async () => {
    const copy = "That community has 4,832,820 subscribers.";
    const envelope = {
      rendered_markdown: copy,
      steps: [{ title: "Paste sheet", body: "Why.", blocking: false, effort: "minutes", evidence: ["scraped this run"], deliverable: { kind: "ad_variants", label: "Sheet", content: copy } }],
    };
    const out = await groundChannelDeliverables(envelope, ctx, {}, result, deps({
      pages: () => [{ url: "https://acme.test/", text: "Local plumbing services." }],
    }));
    expect(firstContent(out)).toBe(copy);
  });
});

describe("artifact resync internals (2026-09-17)", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  it("only writes objects under this tenant's own prefix", () => {
    expect(artifactBelongsToTenant("t-1/run-9/file.html", "t-1")).toBe(true);
    expect(artifactBelongsToTenant("t-2/run-9/file.html", "t-1")).toBe(false);
    expect(artifactBelongsToTenant("file.html", "t-1")).toBe(false);
    expect(artifactBelongsToTenant("t-1/run-9/file.html", "")).toBe(false);
  });

  it("applies the cut in both raw and escaped spellings", () => {
    const edits = [{ from: `We charge 0% — it's "free".`, to: "" }];
    const raw = `<p>We charge 0% — it's "free". Book today.</p>`;
    const escaped = `<p>${esc(`We charge 0% — it's "free".`)} Book today.</p>`;
    expect(patchArtifactText(raw, edits, esc)).toBe("<p> Book today.</p>");
    expect(patchArtifactText(escaped, edits, esc)).toBe("<p> Book today.</p>");
  });

  it("leaves a file that does not contain the copy untouched", () => {
    const before = "<p>Unrelated content.</p>";
    expect(patchArtifactText(before, [{ from: "something else", to: "x" }], esc)).toBe(before);
  });
});

describe("the card gets the same deterministic checks as the file", () => {
  const RUN = "run-1";
  beforeEach(() => {
    clearFigures(RUN);
    recordUrls(RUN, JSON.stringify({ final_url: "https://acme.test/services/" }));
    recordFigures(RUN, JSON.stringify({ subscribers: 270219 }));
  });
  afterEach(() => clearFigures(RUN));

  const envelopeWith = (content: string) => ({
    rendered_markdown: content,
    steps: [{ title: "Paste this", body: "Why.", blocking: false, effort: "minutes", evidence: ["read this run"], deliverable: { kind: "ad_variants", label: "Ads", content } }],
  });
  const passThrough: Partial<GroundingDeps> = {};

  it("cuts a bare regulatory claim from the card the verifier left alone", async () => {
    const copy = "Hook line here. The county banned these units from 2027. Book a free estimate today.";
    const out = await groundChannelDeliverables(envelopeWith(copy), ctx, {}, result, deps(passThrough));
    expect(firstContent(out)).not.toContain("banned");
    expect(firstContent(out)).toContain("Book a free estimate today.");
  });

  it("cuts a source the run never read but the card says it did", async () => {
    const copy = "Opening line. Confirmed on site this run at https://acme.test/blog/rule/. Call today.";
    const out = await groundChannelDeliverables(envelopeWith(copy), ctx, {}, result, deps(passThrough));
    const step0 = (out.envelope as { steps: Array<{ deliverable: { content: string } }> }).steps[0];
    expect(step0.deliverable.content).not.toContain("acme.test/blog/rule");
    expect(firstContent(out)).toContain("Call today.");
  });

  it("leaves a card whose claims all check out", async () => {
    const copy = "r/SomeTown has 270,219 subscribers. We read https://acme.test/services/ this run. Book today.";
    const out = await groundChannelDeliverables(envelopeWith(copy), ctx, {}, result, deps(passThrough));
    expect(firstContent(out)).toBe(copy);
  });

  it("drops the parts when it cuts the content, so the cut claim is not shown in a part", async () => {
    const copy = "Hook line here. The county banned these units from 2027. Book a free estimate today.";
    const env = envelopeWith(copy);
    (env.steps[0].deliverable as Record<string, unknown>).parts = [{ label: "A", content: "The county banned these units from 2027." }];
    const out = await groundChannelDeliverables(env, ctx, {}, result, deps(passThrough));
    const d = (out.envelope as { steps: Array<{ deliverable: { content: string; parts?: unknown } }> }).steps[0].deliverable;
    expect(d.content).not.toContain("banned");
    expect(d.parts).toBeUndefined();
  });

  it("keeps the copy when cutting would gut it, and counts that it kept it", async () => {
    const copy = "The county banned these units from 2027.";
    const logs: Array<Record<string, unknown>> = [];
    const out = await groundChannelDeliverables(envelopeWith(copy), ctx, {}, result, deps({ ...passThrough, log: (_c, m) => logs.push(m) }));
    expect(firstContent(out)).toBe(copy);
    expect(logs.at(-1)).toMatchObject({ figures_kept: 1 });
  });
});

describe("a post the copy says exists must exist in what the run read", () => {
  const RUN = "run-1";
  beforeEach(() => {
    clearFigures(RUN);
    recordUrls(RUN, JSON.stringify({ final_url: "https://acme.test/" }));
  });
  afterEach(() => clearFigures(RUN));

  const envelopeWith = (content: string) => ({
    rendered_markdown: content,
    steps: [{ title: "Use this", body: "Why.", blocking: false, effort: "minutes", evidence: ["read this run"], deliverable: { kind: "creative_brief", label: "Brief", content } }],
  });
  const noRevisions: Partial<GroundingDeps> = {};

  it("cuts a titled post that appears in no read", async () => {
    const copy = 'Lead concept here. They already published "The Big Local Rule Change Explained" on their blog. Film it this week.';
    const out = await groundChannelDeliverables(envelopeWith(copy), ctx, {}, result, deps(noRevisions));
    expect(firstContent(out)).not.toContain("The Big Local Rule Change Explained");
    expect(firstContent(out)).toContain("Film it this week.");
  });

  it("keeps a titled post the run actually read", async () => {
    const copy = 'Lead concept. They published "Trials are offered where a tutor chooses to" last week. Film it.';
    const out = await groundChannelDeliverables(envelopeWith(copy), ctx, {}, result, deps(noRevisions));
    expect(firstContent(out)).toContain("Trials are offered where a tutor chooses to");
  });

  it("ignores a quote that makes no publication claim", async () => {
    const copy = 'Open with the line "we answer in ninety minutes" on screen. Then the phone number.';
    const out = await groundChannelDeliverables(envelopeWith(copy), ctx, {}, result, deps(noRevisions));
    expect(firstContent(out)).toContain("we answer in ninety minutes");
  });
});

describe("the publication guard does not eat ordinary copy", () => {
  const RUN = "run-1";
  beforeEach(() => { clearFigures(RUN); recordUrls(RUN, JSON.stringify({ final_url: "https://acme.test/" })); });
  afterEach(() => clearFigures(RUN));
  const env = (content: string) => ({
    rendered_markdown: content,
    steps: [{ title: "Plan", body: "Why.", blocking: false, effort: "minutes", evidence: ["read this run"], deliverable: { kind: "creative_brief", label: "Plan", content } }],
  });
  const noRev: Partial<GroundingDeps> = {};

  it("keeps a plan that RECOMMENDS publishing something", async () => {
    const copy = 'Week 1 plan. Publish an article titled "How To Choose An Emergency Plumber" next week. Keep the number on screen.';
    const out = await groundChannelDeliverables(env(copy), ctx, {}, result, deps(noRev));
    expect(firstContent(out)).toBe(copy);
  });

  it("keeps copy whose apostrophes are not quote marks", async () => {
    const copy = "We haven't posted since June, and the owner's brother's van is still in the header photo.";
    const out = await groundChannelDeliverables(env(copy), ctx, {}, result, deps(noRev));
    expect(firstContent(out)).toBe(copy);
  });

  it("still cuts a claim that a titled post already exists", async () => {
    const copy = 'Lead concept. They already published "The Big Local Rule Change Explained" last week. Film it.';
    const out = await groundChannelDeliverables(env(copy), ctx, {}, result, deps(noRev));
    expect(firstContent(out)).not.toContain("The Big Local Rule Change Explained");
  });
});
