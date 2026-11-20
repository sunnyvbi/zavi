import { describe, it, expect } from "vitest";
import {
  isExecuteVerbFollowUp,
  shouldHidePriorRunBodies,
  shouldDropForFreshWork,
  NEUTRAL_RUN_STATUS,
  ARTIFACT_PRODUCER_SLUGS,
  isArtifactProducer,
} from "../slack-fresh-work-gate";

describe("slack-fresh-work-gate — execute-verb detection", () => {
  it("matches EXECUTE-verb follow-ups", () => {
    for (const t of [
      "run it again",
      "Run that again please",
      "redo it",
      "re-run it",
      "regenerate the report",
      "do it again",
      "that wasn't successful",
      "this wasn't successful, try again",
      "the build failed again",
    ]) {
      expect(isExecuteVerbFollowUp(t), t).toBe(true);
    }
  });

  it("does NOT match RECALL verbs (surface the existing result)", () => {
    for (const t of [
      "share the PDF again",
      "show me that report again",
      "where is it again?",
      "send me the link again",
      "paste the output again",
      "what was the result again?",
      "resend the file",
    ]) {
      expect(isExecuteVerbFollowUp(t), t).toBe(false);
    }
  });

  it("recall wins ties (a STRONG recall verb present → not execute)", () => {
    expect(isExecuteVerbFollowUp("show me the run-it-again output")).toBe(false);
  });

  it("P2-A — a bare interrogative does NOT swallow execute intent", () => {
    expect(isExecuteVerbFollowUp("what failed, run it again")).toBe(true);
    expect(isExecuteVerbFollowUp("where did it fail, try again")).toBe(true);
    expect(isExecuteVerbFollowUp("which step broke? redo it")).toBe(true);
  });

  it("P2-A — interrogative + result-noun is still recall", () => {
    expect(isExecuteVerbFollowUp("what was in the report again?")).toBe(false);
    expect(isExecuteVerbFollowUp("where is the pdf?")).toBe(false);
    expect(isExecuteVerbFollowUp("share the pdf again")).toBe(false);
  });

  it("empty / unrelated text is not execute", () => {
    expect(isExecuteVerbFollowUp("")).toBe(false);
    expect(isExecuteVerbFollowUp(null)).toBe(false);
    expect(isExecuteVerbFollowUp("how are you today")).toBe(false);
  });
});

describe("slack-fresh-work-gate — hide prior-run bodies (P0#1 + operator web chat)", () => {
  it("hides on operator slack and operator web-chat turns", () => {
    expect(shouldHidePriorRunBodies({ trigger: "slack", agentSlug: "operator" })).toBe(true);
    expect(shouldHidePriorRunBodies({ trigger: "chat", agentSlug: "operator" })).toBe(true);
    expect(NEUTRAL_RUN_STATUS).toBe("not available");
  });

  it("does NOT hide for other triggers or non-operator agents", () => {
    expect(shouldHidePriorRunBodies({ trigger: "cron", agentSlug: "operator" })).toBe(false);
    expect(shouldHidePriorRunBodies({ trigger: "teams", agentSlug: "operator" })).toBe(false);
    expect(shouldHidePriorRunBodies({ trigger: "channel_recipe", agentSlug: "operator" })).toBe(false);
    expect(shouldHidePriorRunBodies({ trigger: undefined, agentSlug: "operator" })).toBe(false);
    expect(shouldHidePriorRunBodies({ trigger: "slack", agentSlug: "research" })).toBe(false);
    for (const slug of ["pm", "advisor", "chief-of-staff"]) {
      expect(shouldHidePriorRunBodies({ trigger: "chat", agentSlug: slug })).toBe(false);
    }
  });

  it("the row DROP stays Slack-only (web chat never drops a row)", () => {
    expect(
      shouldDropForFreshWork({
        trigger: "chat",
        agentSlug: "operator",
        currentText: "run it again",
        rowAgentSlug: "research",
      }),
    ).toBe(false);
  });
});

describe("slack-fresh-work-gate — row drop (P0#3)", () => {
  const base = { trigger: "slack", agentSlug: "operator" };

  it("drops an artifact-producer row on a slack execute-verb turn", () => {
    expect(
      shouldDropForFreshWork({
        ...base,
        currentText: "run it again",
        rowAgentSlug: "research",
      }),
    ).toBe(true);
  });

  it("does NOT drop on a recall ask", () => {
    expect(
      shouldDropForFreshWork({
        ...base,
        currentText: "share the PDF again",
        rowAgentSlug: "research",
      }),
    ).toBe(false);
  });

  it("P2-A — drops on 'what failed, run it again' (interrogative does not block execute)", () => {
    expect(
      shouldDropForFreshWork({
        ...base,
        currentText: "what failed, run it again",
        rowAgentSlug: "research",
      }),
    ).toBe(true);
  });

  it("does NOT drop a non-artifact-producer row", () => {
    expect(
      shouldDropForFreshWork({
        ...base,
        currentText: "run it again",
        rowAgentSlug: "engineer",
      }),
    ).toBe(false);
    expect(ARTIFACT_PRODUCER_SLUGS.has("engineer")).toBe(false);
  });

  it("does NOT drop on a non-slack run", () => {
    expect(
      shouldDropForFreshWork({
        trigger: "chat",
        agentSlug: "operator",
        currentText: "run it again",
        rowAgentSlug: "research",
      }),
    ).toBe(false);
  });

  it("does NOT drop for a non-operator agent", () => {
    expect(
      shouldDropForFreshWork({
        trigger: "slack",
        agentSlug: "pm",
        currentText: "run it again",
        rowAgentSlug: "research",
      }),
    ).toBe(false);
  });

  it("DROPS a content-design row (capabilities.emits_artifact — the #11 regression)", () => {
    expect(
      shouldDropForFreshWork({
        ...base,
        currentText: "redo the blog post",
        rowAgentSlug: "content-design",
      }),
    ).toBe(true);
  });
});

describe("slack-fresh-work-gate — isArtifactProducer (capability-derived)", () => {
  it("recognizes every explicit + capability-flagged producer", () => {
    for (const slug of [
      "research",
      "performance-marketer",
      "growth-lead",
      "dispute-response",
      "pm",
      "content-design",
    ]) {
      expect(isArtifactProducer(slug), slug).toBe(true);
    }
    expect(ARTIFACT_PRODUCER_SLUGS.has("content-design")).toBe(true);
  });

  it("does NOT flag a non-artifact agent (engineer emits no artifact, not in set)", () => {
    expect(isArtifactProducer("engineer")).toBe(false);
    expect(isArtifactProducer("does-not-exist-agent")).toBe(false);
  });
});

describe("slack-fresh-work-gate — hidden bodies stay recallable", () => {
  it("every agent whose prior-run bodies are hidden declares the recall tools", async () => {
    const { listGlobalAgentSlugs, loadGlobalAgentDefinition } = await import("../registry");
    const hidden = listGlobalAgentSlugs().filter((slug) =>
      ["slack", "chat"].some((trigger) => shouldHidePriorRunBodies({ trigger, agentSlug: slug })),
    );
    expect(hidden).toContain("operator");
    for (const slug of hidden) {
      const tools = loadGlobalAgentDefinition(slug)?.metadata_praxis.tools ?? [];
      expect(tools).toContain("praxis_corpus__query_recent_runs");
      expect(tools).toContain("praxis_corpus__read_run_output");
    }
  });
});
