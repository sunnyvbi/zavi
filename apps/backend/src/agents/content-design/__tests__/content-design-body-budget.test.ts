
import { describe, it, expect } from "vitest";
import {
  checkBodyBudget,
  recommendationToParsed,
  MAX_BODY_CHARS,
  MAX_BODY_WORDS,
} from "../post-run";

const finished = "# Title\n\nThis is a complete, shippable post about the topic. It ends cleanly.";

describe("checkBodyBudget", () => {
  it("passes a finished, in-budget body", () => {
    expect(checkBodyBudget(finished)).toBeNull();
  });

  it("passes a body that ends on a closing code fence", () => {
    expect(checkBodyBudget("Intro paragraph.\n\n```\nconst x = 1;\n```")).toBeNull();
  });

  it("passes a body that ends on a heading line (valid short stub close)", () => {
    expect(checkBodyBudget("Body text here.\n\n## Next steps")).toBeNull();
  });

  it("drops an over-char-budget body", () => {
    const huge = "word ".repeat(50).trim() + " " + "x".repeat(MAX_BODY_CHARS + 100);
    expect(checkBodyBudget(huge)).toBe("body_over_budget");
  });

  it("drops an over-word-budget body", () => {
    const wordy = Array.from({ length: MAX_BODY_WORDS + 50 }, () => "w").join(" ") + ".";
    expect(checkBodyBudget(wordy)).toBe("body_over_budget");
  });

  it("detects a mid-sentence clip (no terminal punctuation)", () => {
    expect(checkBodyBudget("This sentence was cut off right in the mid")).toBe("body_truncated");
  });

  it("detects an unbalanced (clipped) code fence", () => {
    expect(checkBodyBudget("Here is code:\n\n```\nconst y = 2;\nmore lines that never close")).toBe(
      "body_truncated",
    );
  });

  it("passes a body ending on a complete bullet (punctuation)", () => {
    expect(checkBodyBudget("Intro.\n\n## Next steps\n\n- Start with one channel.")).toBeNull();
  });

  it("passes a body ending on a single-word bullet (short CTA)", () => {
    expect(checkBodyBudget("Pick one and go.\n\n- Ship")).toBeNull();
  });

  it("passes a body ending on a numbered list item with terminal punctuation", () => {
    expect(checkBodyBudget("Steps:\n\n1. Connect your repo.")).toBeNull();
  });

  it("STILL flags a clipped bullet (no terminal punctuation, multi-word)", () => {
    expect(checkBodyBudget("Tips:\n\n- this bullet was cut off in the")).toBe("body_truncated");
  });

  it("passes a complete task-list item ending", () => {
    expect(checkBodyBudget("Checklist:\n\n- [x] Ship")).toBeNull();
    expect(checkBodyBudget("Checklist:\n\n- [ ] Connect your repo first.")).toBeNull();
  });

  it("flags a marker-only clipped ending (`-` / `1.` with no content)", () => {
    expect(checkBodyBudget("Tips:\n\n-")).toBe("body_truncated");
    expect(checkBodyBudget("Steps:\n\n1.")).toBe("body_truncated");
  });

  it("flags a checkbox-only clipped ending (`- [x]` with no task text)", () => {
    expect(checkBodyBudget("Checklist:\n\n- [x]")).toBe("body_truncated");
    expect(checkBodyBudget("Checklist:\n\n- [ ]")).toBe("body_truncated");
  });
});

describe("recommendationToParsed body-budget integration", () => {
  const base = {
    change_type: "new_page" as const,
    slug: "good-slug",
    title: "Title",
    meta_description: "Meta description here.",
    target_keyword: "keyword",
  };

  it("accepts an in-budget finished body unchanged", () => {
    const out = recommendationToParsed({ ...base, body: finished } as never);
    expect("error" in out).toBe(false);
    if (!("error" in out)) expect(out.body).toBe(finished.trim());
  });

  it("drops a truncated body with the right reason", () => {
    const out = recommendationToParsed({
      ...base,
      body: "This body got clipped mid-sen",
    } as never);
    expect(out).toEqual({ error: "body_truncated" });
  });

  it("drops an over-budget body with the right reason", () => {
    const out = recommendationToParsed({
      ...base,
      body: "x".repeat(MAX_BODY_CHARS + 10) + ".",
    } as never);
    expect(out).toEqual({ error: "body_over_budget" });
  });
});
