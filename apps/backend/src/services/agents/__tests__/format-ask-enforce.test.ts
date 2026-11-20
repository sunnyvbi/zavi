import { describe, it, expect } from "vitest";
import {
  detectFormatConstraint,
  enforceFormatAsk,
} from "../format-ask-enforce";

describe("detectFormatConstraint", () => {
  it("detects explicit asks (tightest wins)", () => {
    expect(detectFormatConstraint("Give me a one-paragraph status update. One paragraph only.")).toBe("one_paragraph");
    expect(detectFormatConstraint("In one sentence, what is the single most important metric?")).toBe("one_sentence");
    expect(detectFormatConstraint("Write a 120-word note. Prose only, no headings.")).toBe("no_headings");
    expect(detectFormatConstraint("tl;dr please")).toBe("one_line");
    expect(detectFormatConstraint("summarize in one line")).toBe("one_line");
  });

  it("returns null when no explicit constraint is present", () => {
    expect(detectFormatConstraint("what's the status?")).toBeNull();
    expect(detectFormatConstraint("walk me through the funnel in detail")).toBeNull();
    expect(detectFormatConstraint("")).toBeNull();
    expect(detectFormatConstraint(null)).toBeNull();
    expect(detectFormatConstraint(undefined)).toBeNull();
  });
});

describe("enforceFormatAsk — prod bug repros", () => {
  it("one paragraph: strips the leaked `## status update` heading + sections, collapses to one paragraph", () => {
    const body = [
      "## status update",
      "",
      "Bookings are up 12% week over week.",
      "",
      "## next steps",
      "",
      "Fix host onboarding stall.",
    ].join("\n");
    const { text, applied } = enforceFormatAsk({
      userMessage: "Give me a one-paragraph status update. One paragraph only.",
      body,
    });
    expect(applied).toBe("one_paragraph");
    expect(text).not.toMatch(/#/);
    expect(text).not.toContain("\n");
    expect(text).toBe(
      "Bookings are up 12% week over week. Fix host onboarding stall.",
    );
  });

  it("one sentence: strips `## marketplace metric answer` heading, returns first sentence only", () => {
    const body = [
      "## marketplace metric answer",
      "",
      "GMV is the single most important metric. It compounds supply and demand.",
    ].join("\n");
    const { text, applied } = enforceFormatAsk({
      userMessage: "In one sentence, what is the single most important metric?",
      body,
    });
    expect(applied).toBe("one_sentence");
    expect(text).not.toMatch(/#/);
    expect(text).toBe("GMV is the single most important metric.");
  });

  it("prose only / no headings: strips the leading bold pseudo-heading, keeps prose", () => {
    const body = [
      "**Why fast feedback loops matter**",
      "",
      "Fast feedback loops let you ship, learn, and correct before mistakes compound.",
    ].join("\n");
    const { text, applied } = enforceFormatAsk({
      userMessage: "Write a 120-word note on feedback loops. Prose only, no headings.",
      body,
    });
    expect(applied).toBe("no_headings");
    expect(text).not.toContain("**");
    expect(text).toBe(
      "Fast feedback loops let you ship, learn, and correct before mistakes compound.",
    );
  });
});

describe("enforceFormatAsk — no-regression control cases", () => {
  it("CONTROL: no explicit constraint → body is byte-identical, headings preserved", () => {
    const body = [
      "## Status",
      "",
      "Bookings are up 12%.",
      "",
      "### Detail",
      "More context here.",
    ].join("\n");
    const { text, applied } = enforceFormatAsk({
      userMessage: "what's the status of the marketplace?",
      body,
    });
    expect(applied).toBeNull();
    expect(text).toBe(body);
    expect(text).toContain("## Status");
    expect(text).toContain("### Detail");
  });

  it("CONTROL: fenced code block is never mangled even under a constraint", () => {
    const body = [
      "## How to run it",
      "",
      "Use this command:",
      "",
      "```bash",
      "## not a heading — inside code",
      "npm run dev",
      "```",
    ].join("\n");
    const { text } = enforceFormatAsk({
      userMessage: "one paragraph please",
      body,
    });
    expect(text).not.toMatch(/^## How to run it/m);
    expect(text).toContain("```bash");
    expect(text).toContain("## not a heading — inside code");
    expect(text).toContain("npm run dev");
  });

  it("CONTROL: a bold span mid-prose (not a standalone heading) is preserved", () => {
    const body = "**Note:** bookings are up 12% this week and rising.";
    const { text } = enforceFormatAsk({
      userMessage: "in one sentence, how are bookings?",
      body,
    });
    expect(text).toContain("**Note:**");
    expect(text).toBe(body);
  });

  it("does not flatten a list under one-paragraph (structure preserved, heading still stripped)", () => {
    const body = [
      "## Top risks",
      "",
      "- onboarding stall",
      "- payout delay",
    ].join("\n");
    const { text } = enforceFormatAsk({
      userMessage: "give me the top risks in one paragraph",
      body,
    });
    expect(text).not.toContain("## Top risks");
    expect(text).toContain("- onboarding stall");
    expect(text).toContain("- payout delay");
  });
});

describe("enforceFormatAsk — hedge banners survive a format ask", () => {
  const CAP_BANNER = [
    "> ⚠️ **Unverified cap/policy** — this reply states a spending cap or policy ($50/week) that no tool result from this run supports.",
    "> Treat that figure as **unconfirmed** — it may be a misremembered or invented constraint.",
  ].join("\n");

  it("keeps a TRAILING banner when collapsing to one sentence", () => {
    const body = `Host campaigns are capped at $50/week. Raise it in Ads Manager.\n\n${CAP_BANNER}`;
    const { text, applied } = enforceFormatAsk({
      userMessage: "in one sentence, what's my cap?",
      body,
    });
    expect(applied).toBe("one_sentence");
    expect(text).toContain("Unverified cap/policy");
    expect(text.split("\n")[0]).toBe("Host campaigns are capped at $50/week.");
    expect(text).not.toContain("Raise it in Ads Manager");
  });

  it("keeps a LEADING banner (plus its idempotence marker) on a one-line ask", () => {
    const body = [
      "> ⚠️ **Unverified** — I hit the file-read budget with at least one file unopened.",
      "> Ask me to re-check a specific file.",
      "<!--unverified-absence-hedge-->",
      "",
      "No Stripe webhook is configured. I checked the connector table.",
    ].join("\n");
    const { text } = enforceFormatAsk({ userMessage: "tl;dr", body });
    expect(text).toContain("<!--unverified-absence-hedge-->");
    expect(text).toContain("> ⚠️ **Unverified**");
    expect(text).toContain("No Stripe webhook is configured.");
    expect(text).not.toContain("I checked the connector table");
  });

  it("keeps the banner when a list blocks the collapse", () => {
    const body = `## Risks\n\n- onboarding stall\n- payout delay\n\n${CAP_BANNER}`;
    const { text } = enforceFormatAsk({
      userMessage: "one paragraph please",
      body,
    });
    expect(text).not.toContain("## Risks");
    expect(text).toContain("- payout delay");
    expect(text).toContain("Unverified cap/policy");
  });

  it("is a no-op when the body is nothing but a banner", () => {
    const { text, applied } = enforceFormatAsk({
      userMessage: "in one sentence",
      body: CAP_BANNER,
    });
    expect(text).toBe(CAP_BANNER);
    expect(applied).toBeNull();
  });

  it("leaves banner-free bodies byte-identical to the pre-fix behavior", () => {
    const body = "## Status\n\nWe shipped the fix. It is live. Metrics look flat.";
    const { text } = enforceFormatAsk({
      userMessage: "in one sentence",
      body,
    });
    expect(text).toBe("We shipped the fix.");
  });
});
