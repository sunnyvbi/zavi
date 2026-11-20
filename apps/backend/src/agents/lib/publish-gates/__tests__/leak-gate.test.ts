import { describe, it, expect, vi } from "vitest";

const logEvent = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent }));

import { applyLeakGateToStep, cleanText, hardLeaks, toolNamespaces, usableFounderName } from "../leak-gate";
import { applyLeakGate, cleanNoActionReport, writeBackGatedEnvelope } from "../index";
import { pickDisplayName } from "@/email/sendAuthEmail";

function step(extra: Record<string, unknown> = {}) {
  return { title: "Post this", body: "Why it works.", ...extra } as {
    title: string;
    body: string;
    deliverable?: { kind: string; label: string; content: string };
  };
}

describe("cleanText: safe rewrites", () => {
  it("turns run references into plain time words", () => {
    const cases: Array<[string, string]> = [
      ["Prices confirmed from the pricing page read this run.", "Prices confirmed from the pricing page read today."],
      ["This run read the bio and found two links.", "Today's check read the bio and found two links."],
      ["The footer was truncated in this run's read.", "The footer was truncated in today's read."],
      ["Nothing was spent by this run.", "Nothing was spent by today's check."],
      ["Connect it to see live numbers on the next run.", "Connect it to see live numbers on the next check."],
    ];
    for (const [before, after] of cases) expect(cleanText(before, { prose: true }).text).toBe(after);
  });

  it("removes the writer's self-check sentences and keeps the rest byte-identical", () => {
    const before = "118 chars, under the 160-char limit. No em-dash.";
    expect(cleanText(before, { prose: true }).text).toBe("118 chars, under the 160-char limit.");
    const two = "Both cards are counted and within limits. No em-dashes. Bid stays blank until you confirm it.";
    expect(cleanText(two, { prose: true }).text).toBe("Bid stays blank until you confirm it.");
    const kit = "Kit shape: Receipt (Shape 1). The first line fits the mobile fold.";
    expect(cleanText(kit, { prose: true }).text).toBe("The first line fits the mobile fold.");
    const swap = "No link. Passes the swap test: the claim is ours alone. Two hashtags.";
    expect(cleanText(swap, { prose: true }).text).toBe("No link. Two hashtags.");
  });

  it("drops a whole 'Swap test:' paragraph from paste-ready copy", () => {
    const before = "Shoot four variations.\n\nSwap test: Replace the brand with a rival. It breaks. That is why it goes first.";
    expect(cleanText(before, { prose: false }).text).toBe("Shoot four variations.");
  });

  it("rewrites internal status words and status codes", () => {
    expect(cleanText("Step #1 was marked acted but the link was not replaced.", { prose: true }).text).toBe(
      "Step #1 was marked done but the link was not replaced.",
    );
    expect(cleanText("A Sep 8 context note found a clash.", { prose: true }).text).toBe("A Sep 8 note found a clash.");
    expect(cleanText("Confirmed from search (ds=yt, Sep 21).", { prose: true }).text).toBe("Confirmed from search (Sep 21).");
    const url = "Open https://example.com/search?q=cars&ds=yt to check.";
    expect(cleanText(url, { prose: true }).text).toBe(url);
    expect(cleanText("The handle returned 404 this run.", { prose: true }).text).toBe(
      "The handle returned a not-found response today.",
    );
    expect(cleanText("The origin server returned a 503.", { prose: true }).text).toBe(
      "The origin server returned a server-error response.",
    );
    expect(cleanText("The page returned 403.", { prose: true }).text).toBe("The page returned an access-blocked response.");
  });

  it("speaks to the founder, not about them, only where the grammar survives", () => {
    expect(cleanText("Confirm the max bid with the founder", { prose: true }).text).toBe("Confirm the max bid");
    expect(cleanText("Hold both answers until the founder clears all five checks.", { prose: true }).text).toBe(
      "Hold both answers until you clear all five checks.",
    );
    const n = { prose: true, founderName: "Dana Reyes" };
    expect(cleanText("Ask Dana Reyes if she will sponsor a post", n).text).toBe("Decide if you will sponsor a post");
    expect(cleanText("About 2 hours if Dana Reyes says yes.", n).text).toBe("About 2 hours if you say yes.");
    expect(cleanText("Ready the moment Dana Reyes approves it.", n).text).toBe("Ready the moment you approve it.");
    expect(cleanText("One post for Dana Reyes to adapt.", n).text).toBe("One post for you to adapt.");
    expect(cleanText("Dana Reyes's profile gets 75 reactions.", n).text).toBe("Your profile gets 75 reactions.");
  });

  it("never rewrites a bare first name: it may be a different person", () => {
    const n = { prose: true, founderName: "Alex Smith" };
    expect(cleanText("Ask Alex Johnson if he will sponsor a post", n).text).toBe("Ask Alex Johnson if he will sponsor a post");
    expect(cleanText("Ask Alex if he will sponsor a post", n).text).toBe("Ask Alex if he will sponsor a post");
    expect(cleanText("Ready the moment Alex approves it.", n).text).toBe("Ready the moment Alex approves it.");
  });

  it("leaves a name alone outside those shapes, and never touches it in a deliverable", () => {
    const n = { prose: true, founderName: "Dana Reyes" };
    expect(cleanText('The social card shows "Dana Reyes - Acme | LinkedIn."', n).text).toBe(
      'The social card shows "Dana Reyes - Acme | LinkedIn."',
    );
    expect(cleanText("Dana Reyes's story, in her words.", { prose: false, founderName: "Dana Reyes" }).text).toBe(
      "Dana Reyes's story, in her words.",
    );
  });

  it("does not touch ordinary copy", () => {
    const copy = "Rent from local owners. Delivered to your door from $30/day. See acme.com for details.";
    const r = cleanText(copy, { prose: true, founderName: "Dana Reyes" });
    expect(r.text).toBe(copy);
    expect(r.rules).toEqual([]);
  });

  it("never rewrites inside inline code or a fenced block", () => {
    const text = "Read this run. Set `ds=yt` and keep:\n```\n// returned 404 this run\n```";
    expect(cleanText(text, { prose: true }).text).toBe(
      "Read today. Set `ds=yt` and keep:\n```\n// returned 404 this run\n```",
    );
  });
});

const NS = toolNamespaces(["growth__propose_creative_brief", "meta_ads__daily_series", "mcp__server__reddit__thread_read"]);

describe("toolNamespaces", () => {
  it("takes the server segment of declared and called tool names, wrapped or not", () => {
    expect([...NS].sort()).toEqual(["growth", "meta_ads", "reddit"]);
  });
});

describe("hardLeaks: cards that cannot ship", () => {
  it("drops a card naming one of the run's tools anywhere a founder reads", () => {
    expect(hardLeaks(step({ body: "Issue the link via growth__propose_creative_brief once both clear." }), NS)).toEqual([
      "internal_tool_name",
    ]);
    expect(
      hardLeaks(step({ deliverable: { kind: "ad", label: "Ad", content: "utm_campaign=[issue via growth__propose_creative_brief]" } }), NS),
    ).toEqual(["internal_tool_name"]);
    expect(hardLeaks(step({ title: "Rerun reddit__thread_read" }), NS)).toEqual(["internal_tool_name"]);
  });

  it("keeps any double-underscore identifier that is not one of the run's namespaces", () => {
    expect(hardLeaks(step({ body: "Link /offers/spring__sale in the post." }), NS)).toEqual([]);
    const pin = toolNamespaces(["pinterest__site_readiness"]);
    expect(hardLeaks(step({ body: "Add the `.pinterest__save-button` class." }), pin)).toEqual([]);
    expect(hardLeaks(step({ body: "Rerun pinterest__site_readiness." }), pin)).toEqual(["internal_tool_name"]);
    expect(hardLeaks(step({ body: "Style the .card__title element." }), NS)).toEqual([]);
    expect(hardLeaks(step({ body: "via growth__propose_creative_brief" }))).toEqual([]);
  });

  it("drops a source path inside paste-ready copy", () => {
    expect(
      hardLeaks(step({ deliverable: { kind: "post", label: "Post", content: "Edit apps/web/src/app/layout.tsx first." } }), NS),
    ).toEqual(["code_path"]);
  });

  it("lets a code deliverable carry paths and class names", () => {
    const code = { kind: "code", label: "Add to src/app/layout.tsx", content: "// In apps/web/src/app/layout.tsx\n.card__title {}" };
    expect(hardLeaks(step({ deliverable: code }), NS)).toEqual([]);
  });

  it("ignores ordinary snake_case and domains", () => {
    expect(hardLeaks(step({ body: "Set utm_campaign=spring_sale and link acme.com/pricing." }), NS)).toEqual([]);
  });
});

describe("applyLeakGateToStep", () => {
  it("reports untouched, cleaned and drop, and keeps a field that was only a note", () => {
    expect(applyLeakGateToStep(step()).action).toBe("untouched");
    const cleaned = applyLeakGateToStep(step({ body: "No em-dash.", title: "Post this, read this run" }));
    expect(cleaned.action).toBe("cleaned");
    expect(cleaned.step.body).toBe("No em-dash.");
    expect(cleaned.step.title).toBe("Post this, read today");
    expect(applyLeakGateToStep(step({ title: "Run meta_ads__daily_series" }), { namespaces: NS }).action).toBe("drop");
  });

  it("never rewrites a code deliverable's content or label", () => {
    const code = { kind: "code", label: "Fix the 404 read this run", content: "fetch(u); // returned 404 this run\nconst q = 'ds=yt';" };
    const r = applyLeakGateToStep(step({ body: "Paste into the layout, checked this run.", deliverable: code }), { namespaces: NS });
    expect(r.step.deliverable).toEqual(code);
    expect(r.step.body).toBe("Paste into the layout, checked today.");
  });
});

describe("usableFounderName", () => {
  it("returns the full display name only, never a bare first name or the brand", () => {
    expect(usableFounderName("Dana  Reyes", ["Acme", "acme.com"])).toBe("Dana Reyes");
    expect(usableFounderName("Dana", [])).toBeNull();
    expect(usableFounderName("dana reyes", [])).toBeNull();
    expect(usableFounderName("Dana Reyes", ["Dana Reyes Studio", "danareyes.com"])).toBeNull();
    expect(usableFounderName(null, [])).toBeNull();
  });
});

describe("applyLeakGate on an envelope", () => {
  const ctx = { tenant_id: "t1", runId: "r1", agent: { slug: "x_organic" } } as never;
  const deps = {
    enabled: () => true,
    companyNames: async () => ["Acme"],
    founderName: async () => "Dana Reyes",
  };
  const tools = ["meta_ads__list_campaigns", "web_fetch__fetch"];
  const ev = ["read the site"];

  it("cleans, drops with a logged reason, and the report keeps nothing a card lost", async () => {
    logEvent.mockClear();
    const envelope = {
      rendered_markdown:
        "# Report\n\n## Post A\nAsk Dana Reyes if she will post it\n\nPost A, read this run\n\n" +
        "## Tag the campaign with the tracked link\nWe could not verify it.\n\nutm via meta_ads__list_campaigns\n\n" +
        "Also see meta_ads__list_campaigns for the source.",
      steps: [
        { title: "Post A", body: "Ask Dana Reyes if she will post it", blocking: false, effort: "minutes", evidence: ev,
          deliverable: { kind: "post", label: "Post", content: "Post A, read this run" } },
        { title: "Tag the campaign with the tracked link", body: "We could not verify it.", blocking: false, effort: "minutes", evidence: ev,
          deliverable: { kind: "post", label: "Post", content: "utm via meta_ads__list_campaigns" } },
        { title: "Post C", body: "Fine as is.", blocking: false, effort: "minutes", evidence: ev },
      ],
    };
    const out = (await applyLeakGate(envelope, ctx, tools, deps)).envelope as typeof envelope;
    expect(out.steps.map((s) => s.title)).toEqual(["Post A", "Post C"]);
    expect(out.steps[0].body).toBe("Decide if you will post it");
    expect(out.steps[0].deliverable?.content).toBe("Post A, read today");
    expect(out.rendered_markdown).toContain("Decide if you will post it");
    expect(out.rendered_markdown).toContain("Post A, read today");
    expect(out.rendered_markdown).not.toContain("meta_ads__list_campaigns");
    expect(out.rendered_markdown).not.toContain("We could not verify it.");
    expect(out.rendered_markdown).not.toContain("Tag the campaign with the tracked link");
    const codes = logEvent.mock.calls.map((c) => (c as unknown as [{ code: string; meta: Record<string, unknown> }])[0]);
    expect(codes.find((c) => c.code === "publish_gate.leak_drop")?.meta).toEqual({
      agent_slug: "x_organic", gate_rule: "internal_tool_name", gate_action: "drop", step_index: 1,
    });
  });

  it("cleans the report's own run wording even when every card is clean", async () => {
    const envelope = { rendered_markdown: "# r\n\nThe footer was read this run.", steps: [{ title: "A", body: "B.", blocking: false, effort: "minutes", evidence: ev }] };
    const out = (await applyLeakGate(envelope, ctx, tools, deps)).envelope as typeof envelope;
    expect(out.rendered_markdown).toBe("# r\n\nThe footer was read today.");
  });

  it("returns the same envelope object when nothing fires, and does nothing when switched off", async () => {
    const envelope = { rendered_markdown: "# r", steps: [{ title: "A", body: "B.", blocking: false, effort: "minutes", evidence: ev }] };
    expect((await applyLeakGate(envelope, ctx, tools, deps)).envelope).toBe(envelope);
    const leaky = { rendered_markdown: "# r", steps: [{ title: "A", body: "Read this run.", blocking: false, effort: "minutes", evidence: ev }] };
    expect((await applyLeakGate(leaky, ctx, tools, { ...deps, enabled: () => false })).envelope).toBe(leaky);
  });

  it("skips only the name check when the owner name cannot be read", async () => {
    const envelope = { rendered_markdown: "# r", steps: [{ title: "A", body: "Ask Dana Reyes if she will post it, read this run.", blocking: false, effort: "minutes", evidence: ev }] };
    const out = (await applyLeakGate(envelope, ctx, tools, { ...deps, founderName: async () => { throw new Error("down"); } }))
      .envelope as typeof envelope;
    expect(out.steps[0].body).toBe("Ask Dana Reyes if she will post it, read today.");
  });
});

describe("writeBackGatedEnvelope: the run record keeps only the gated report", () => {
  it("replaces parsed and the report inside output_text", () => {
    const result = { parsed: { rendered_markdown: "old report" }, output_text: "old report" } as never as {
      parsed: unknown;
      output_text: string;
    };
    writeBackGatedEnvelope(result as never, { rendered_markdown: "new report", steps: [] });
    expect(result.parsed).toEqual({ rendered_markdown: "new report", steps: [] });
    expect(result.output_text).toBe("new report");
  });

  it("uses the gated report when the visible text cannot be patched in place", () => {
    const result = { parsed: { rendered_markdown: "old <cite/> report" }, output_text: "old report" };
    writeBackGatedEnvelope(result as never, { rendered_markdown: "new report" });
    expect(result.output_text).toBe("new report");
  });

  it("strips citation markup from the replacement, as the dispatcher did for the original", () => {
    const result = {
      parsed: { rendered_markdown: 'Read this run <cite kind="memory" slug="company"/>.' },
      output_text: "Read this run .",
    };
    writeBackGatedEnvelope(result as never, { rendered_markdown: 'Read today <cite kind="memory" slug="company"/>.' });
    expect(result.output_text).not.toContain("<cite");
    expect(result.output_text).toContain("Read today");
  });

  it("leaves output_text alone when the report did not change", () => {
    const result = { parsed: { rendered_markdown: "same" }, output_text: "chat reply" };
    writeBackGatedEnvelope(result as never, { rendered_markdown: "same", steps: [] });
    expect(result.output_text).toBe("chat reply");
  });
});

describe("final-round fixes", () => {
  const ctx = { tenant_id: "t1", runId: "r1", agent: { slug: "x_organic" } } as never;
  const deps = { enabled: () => true, companyNames: async () => ["Acme"], founderName: async () => null };
  const ev = ["read the site"];

  it("withdraws the leaking field from the report even when it is short", async () => {
    const envelope = {
      rendered_markdown: "# r\n\nUse growth__brief\n\nKeep this.",
      steps: [
        { title: "A", body: "Use growth__brief", blocking: false, effort: "minutes", evidence: ev },
        { title: "B", body: "Keep this.", blocking: false, effort: "minutes", evidence: ev },
      ],
    };
    const out = (await applyLeakGate(envelope, ctx, ["growth__brief"], deps)).envelope as typeof envelope;
    expect(out.steps.map((s) => s.title)).toEqual(["B"]);
    expect(out.rendered_markdown).toBe("# r\n\n[withdrawn by the publish checks]\n\nKeep this.");
  });

  it("cleans the report of a run with no actions", async () => {
    const envelope = { rendered_markdown: "Nothing to do; the site was read this run.", steps: [] as unknown[] };
    const out = (await applyLeakGate(envelope, ctx, [], deps)).envelope as typeof envelope;
    expect(out.rendered_markdown).toBe("Nothing to do; the site was read today.");
  });

  it("cleanNoActionReport rewrites the stored report of a zero-step run", () => {
    const result = { parsed: { rendered_markdown: "Read this run.", steps: [] }, output_text: "Read this run." };
    cleanNoActionReport(result as never);
    expect(result.output_text).toBe("Read today.");
    expect((result.parsed as { rendered_markdown: string }).rendered_markdown).toBe("Read today.");
    const clean = { parsed: { rendered_markdown: "All good.", steps: [] }, output_text: "All good." };
    cleanNoActionReport(clean as never);
    expect(clean.output_text).toBe("All good.");
  });

  it("owner name falls back to `name` when full_name is blank", () => {
    expect(pickDisplayName({ full_name: "  ", name: "Dana Reyes" })).toBe("Dana Reyes");
    expect(pickDisplayName({ full_name: "Dana Reyes", name: "dr" })).toBe("Dana Reyes");
    expect(pickDisplayName({ name: "" })).toBeNull();
    expect(pickDisplayName(null)).toBeNull();
  });
});
