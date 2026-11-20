import { describe, expect, it } from "vitest";
import {
  answeredIn,
  companyLines,
  evidenceBlocks,
  fetchedUrls,
  gist,
  LABELLERS,
  labellerId,
  peopleProgress,
  pickTechnical,
  queueItems,
  rightGoalApplies,
  siteUrl,
  stepsKind,
  stratifiedSample,
  type Candidate,
  type Item,
  type Snapshot,
} from "../card-labels";

const c = (id: string, tenant: string, channel: string, day: number): Candidate => ({
  id,
  tenant_id: tenant,
  channel_slug: channel,
  proposed_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`,
});

describe("stratifiedSample", () => {
  it("round-robins tenant x channel groups, newest first, so one group cannot fill the batch", () => {
    const rows = [c("a1", "A", "seo", 1), c("a2", "A", "seo", 2), c("a3", "A", "seo", 3), c("b1", "B", "x", 1), c("a4", "A", "blog", 5)];
    expect(stratifiedSample(rows, 3).map((r) => r.id)).toEqual(["a4", "a3", "b1"]);
  });
  it("stops at n and at the end of the rows", () => {
    expect(stratifiedSample([c("a", "A", "seo", 1)], 5)).toHaveLength(1);
  });
});

describe("stepsKind", () => {
  it("tells template-only steps from real ones and from none", () => {
    expect(stepsKind(["Open Reddit Ads and make the change this card describes.", "Check that it worked, then press Done."])).toBe("generic");
    expect(stepsKind(["Open Google Ads and make the change this card describes.", "Check that it worked, then press I changed it."])).toBe("generic");
    expect(stepsKind(["Press Copy post.", "Open LinkedIn and start a new post."])).toBe("real");
    expect(stepsKind(["Press Copy new text.", "Open X and make the change this card describes."])).toBe("real");
    expect(stepsKind([])).toBe("none");
    expect(stepsKind(null)).toBe("none");
  });
});

describe("rightGoalApplies", () => {
  it("applies when the card judges results, not when it creates something", () => {
    expect(rightGoalApplies({ title: "Pause the awareness campaign", body: "It spent $598 with 0 conversions." })).toBe(true);
    expect(rightGoalApplies({ title: "Add a blog section to your site", body: "No blog section was found." })).toBe(false);
    expect(rightGoalApplies({ title: "Rewrite the landing page", body: "This page got no sign-ups; rewrite it to drive purchases." })).toBe(true);
    expect(rightGoalApplies({ title: "Post this on LinkedIn", body: "A post about Indian-made quality." })).toBe(false);
  });
});

const snap = (body: string): Snapshot => ({ title: "t", step: { body }, how_to: [], proposed_at: "", tenant_id: "T", channel_slug: "x", run_id: null });

describe("pickTechnical", () => {
  it("takes every card the goal question applies to first, then fills in batch order", () => {
    const items = [
      { action_id: "a", snapshot: snap("Write a post.") },
      { action_id: "b", snapshot: snap("The campaign spent $40.") },
      { action_id: "c", snapshot: snap("Claim your handle.") },
      { action_id: "d", snapshot: snap("CTR fell to 0.4%.") },
    ];
    expect([...pickTechnical(items, 3)]).toEqual(["b", "d", "a"]);
  });
});

describe("queueItems + answeredIn", () => {
  const items: Item[] = [
    { position: 1, action_id: "y", overlap: false, technical: true },
    { position: 0, action_id: "x", overlap: true, technical: false },
  ];
  it("quick covers every card in order; technical only the flagged ones", () => {
    expect(queueItems(items, "quick").map((i) => i.action_id)).toEqual(["x", "y"]);
    expect(queueItems(items, "technical").map((i) => i.action_id)).toEqual(["y"]);
  });
  it("a card is done in a queue only when both of that queue's questions are answered", () => {
    expect(answeredIn({ WORTH_NOW: "yes", STEPS_FOLLOWABLE: "no" }, "quick")).toBe(true);
    expect(answeredIn({ WORTH_NOW: "yes", STEPS_FOLLOWABLE: "no" }, "technical")).toBe(false);
    expect(answeredIn({ TRUE: "no", RIGHT_GOAL: "skip", WORTH_NOW: "yes" }, "technical")).toBe(true);
    expect(answeredIn(null, "quick")).toBe(false);
  });
});

describe("gist", () => {
  it("quotes the first sentences of the body word for word", () => {
    expect(gist("One. Two. Three. Four.")).toBe("One. Two. Three.");
    expect(gist("")).toBe("");
  });
});

describe("companyLines", () => {
  it("takes two sentences of what_we_sell, strips markdown, and adds who_we_serve", () => {
    const lines = companyLines([
      { key: "what_we_sell", value_text: "**Mela** is a marketplace. It sells Indian brands. It ships globally." },
      { key: "who_we_serve", value_text: "eco shoppers" },
    ]);
    expect(lines).toEqual(["Mela is a marketplace. It sells Indian brands.", "Serves: eco shoppers"]);
  });
  it("falls back to company_story and returns nothing when no facts are stored", () => {
    expect(companyLines([{ key: "company_story", value_text: "A coffee roaster." }])).toEqual(["A coffee roaster."]);
    expect(companyLines([])).toEqual([]);
  });
});

describe("evidenceBlocks", () => {
  it("keeps only successful calls and clips at the same size as the TRUE judge", () => {
    const { blocks, clipped } = evidenceBlocks([
      { name: "web_fetch", status: "ok", input_preview: "https://x.com", output_preview: "a".repeat(7000) },
      { name: "meta_ads", status: "tool_error", output_preview: "403" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].output).toBe("a".repeat(6000));
    expect(clipped).toBe(true);
  });
  it("tolerates a missing or non-array trace", () => {
    expect(evidenceBlocks(null)).toEqual({ blocks: [], clipped: false });
  });
  it("budgets the whole block like the judge, so a block the judge drops is dropped here too", () => {
    const calls = Array.from({ length: 10 }, () => ({ name: "web_fetch", status: "ok", input_preview: "i".repeat(300), output_preview: "o".repeat(5900) }));
    const { blocks, clipped } = evidenceBlocks(calls);
    expect(blocks).toHaveLength(9);
    expect(clipped).toBe(true);
  });
});

describe("siteUrl", () => {
  it("adds https to a bare domain and keeps a full URL", () => {
    expect(siteUrl("upcar.ai")).toBe("https://upcar.ai");
    expect(siteUrl("https://x.com/a")).toBe("https://x.com/a");
    expect(siteUrl(null)).toBeNull();
  });
});

describe("fetchedUrls", () => {
  it("lists the pages the judge re-reads: successful web_fetch calls, first 5, no repeats", () => {
    const calls = [
      { name: "web_fetch", status: "ok", input_preview: '{"url":"https://a.com/x"}' },
      { name: "web_fetch", status: "tool_error", input_preview: '{"url":"https://b.com"}' },
      { name: "web_fetch", status: "ok", input_preview: '{"url":"https://a.com/x"}' },
      { name: "web_search", status: "ok", input_preview: "https://c.com" },
    ];
    expect(fetchedUrls(calls)).toEqual(["https://a.com/x"]);
  });
});

describe("labellerId", () => {
  it("names one of the three people, else the login; anyone else is refused", () => {
    expect(labellerId(undefined, "login")).toBe("login");
    expect(labellerId("", "login")).toBe("login");
    expect(labellerId("tarun", "login")).toBe(LABELLERS.find((l) => l.key === "tarun")!.user_id);
    expect(labellerId("mallory", "login")).toBeNull();
  });
});

describe("peopleProgress", () => {
  it("counts each person's finished cards in this queue only", () => {
    const items: Item[] = [
      { position: 0, action_id: "x", overlap: false, technical: true },
      { position: 1, action_id: "y", overlap: false, technical: false },
    ];
    const [ravi, tarun] = LABELLERS;
    const labels = [
      { labeller: ravi.user_id, action_id: "x", answers: { WORTH_NOW: "yes", STEPS_FOLLOWABLE: "no" } },
      { labeller: ravi.user_id, action_id: "y", answers: { WORTH_NOW: "yes" } },
      { labeller: tarun.user_id, action_id: "x", answers: { TRUE: "yes", RIGHT_GOAL: "skip" } },
    ];
    const quick = peopleProgress(items, labels, "quick");
    expect(quick.map((p) => [p.key, p.done, p.total])).toEqual([["ravi", 1, 2], ["tarun", 0, 2], ["pallabi", 0, 2]]);
    expect(peopleProgress(items, labels, "technical").map((p) => p.done)).toEqual([0, 1, 0]);
  });
});
