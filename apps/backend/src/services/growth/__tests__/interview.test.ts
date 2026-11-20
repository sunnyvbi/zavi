import { describe, it, expect } from "vitest";
import {
  buildInterview,
  CUSTOMERS_QUESTION,
  interviewPairs,
  interviewNoteFields,
  extractCompanyFacts,
  isUsableGtmMotion,
  playback,
  slotsFor,
} from "../interview";

describe("slotsFor — the same three questions for everyone", () => {
  it("does not vary with company context", () => {
    const a = slotsFor({});
    const b = slotsFor({ gtmMotion: "outbound sales", oneLiner: "a marketplace" });
    expect(b.map((s) => s.key)).toEqual(a.map((s) => s.key));
    expect(b.map((s) => s.question)).toEqual(a.map((s) => s.question));
  });

  it("offers a distinct, pickable option set for every slot", () => {
    for (const slot of slotsFor({})) {
      expect(slot.options.length).toBeGreaterThanOrEqual(4);
      expect(new Set(slot.options).size).toBe(slot.options.length);
    }
  });

  it("opens on the metric, because it sets both fields the envelope requires", () => {
    expect(slotsFor({})[0].key).toBe("metric");
  });
});

describe("isUsableGtmMotion — the placeholder must read as unknown", () => {
  it("rejects onboarding's explicit not-established marker", () => {
    expect(isUsableGtmMotion("GTM motion: not specified yet - operator to confirm")).toBe(false);
    expect(isUsableGtmMotion("unknown")).toBe(false);
    expect(isUsableGtmMotion("unclear at this stage")).toBe(false);
    expect(isUsableGtmMotion("n/a")).toBe(false);
    expect(isUsableGtmMotion("")).toBe(false);
    expect(isUsableGtmMotion(null)).toBe(false);
    expect(isUsableGtmMotion(undefined)).toBe(false);
  });

  it("accepts a real motion", () => {
    expect(isUsableGtmMotion("self-serve signup driven by SEO")).toBe(true);
    expect(isUsableGtmMotion("outbound sales to mid-market")).toBe(true);
  });
});

describe("buildInterview", () => {
  it("asks three when we know nothing", () => {
    const { slots, next, complete } = buildInterview({});
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => !s.settled)).toBe(true);
    expect(next?.key).toBe("metric");
    expect(complete).toBe(false);
  });

  it("asks only the slots that change a strategy field", () => {
    expect(buildInterview({}).slots.map((s) => s.key)).toEqual([
      "metric",
      "constraint",
      "channels",
    ]);
  });

  it("leads with the two questions the envelope cannot do without", () => {
    expect(buildInterview({}).slots.map((s) => s.key).slice(0, 2)).toEqual([
      "metric",
      "constraint",
    ]);
  });

  it("never asks for a number or a metric name", () => {
    const text = buildInterview({})
      .slots.flatMap((s) => [s.question, s.why, ...s.options])
      .join(" ")
      .toLowerCase();
    for (const jargon of [
      "mrr",
      "arr",
      "cac",
      "ltv",
      "churn",
      "funnel",
      "north star",
      "activation rate",
      "conversion rate",
    ]) {
      expect(text).not.toContain(jargon);
    }
  });

  it("gives the constraint question a real escape hatch", () => {
    const c = buildInterview({}).slots.find((s) => s.key === "constraint")!;
    expect(c.options.some((o) => /not sure/i.test(o))).toBe(true);
  });

  it("pre-fills channels from a known GTM motion, as a confirmation", () => {
    const { slots } = buildInterview({ gtmMotion: "referrals and word of mouth" });
    const channels = slots.find((s) => s.key === "channels")!;
    expect(channels.answer).toBe("referrals and word of mouth");
    expect(channels.inferred).toBe(true);
    expect(channels.settled).toBe(false);
    expect(buildInterview({ gtmMotion: "referrals and word of mouth" }).next?.key).toBe(
      "channels",
    );
  });

  it("does NOT pre-fill from the not-established placeholder", () => {
    const { slots } = buildInterview({
      gtmMotion: "GTM motion: not specified yet - operator to confirm",
    });
    const channels = slots.find((s) => s.key === "channels")!;
    expect(channels.answer).toBeNull();
    expect(channels.inferred).toBe(false);
  });

  it("lets the founder's own answer override an inference", () => {
    const { slots } = buildInterview(
      { gtmMotion: "paid ads" },
      { channels: "actually it's all referrals now" },
    );
    const channels = slots.find((s) => s.key === "channels")!;
    expect(channels.answer).toBe("actually it's all referrals now");
    expect(channels.inferred).toBe(false);
    expect(channels.settled).toBe(true);
  });

  it("walks the remaining slots in order and completes", () => {
    const answers = {
      metric: "More of them actually buying",
      constraint: "They look, but don't buy",
    };
    expect(buildInterview({}, answers).next?.key).toBe("channels");
    const all = { ...answers, channels: "Word of mouth from a customer" };
    expect(buildInterview({}, all).complete).toBe(true);
    expect(buildInterview({}, all).next).toBeNull();
  });

  it("ignores a blank answer rather than counting it as settled", () => {
    const { slots } = buildInterview({}, { metric: "   " });
    expect(slots[0].settled).toBe(false);
  });
});

describe("playback — evidence or silence", () => {
  const ONE_LINER = "Upcar, Inc. is a peer-to-peer car-rental marketplace";

  it("leads with the company's own one-line description", () => {
    const line = playback({ oneLiner: ONE_LINER, stage: 3, gtmMotion: "referrals" }, "Upcar")!;
    expect(line).toContain("peer-to-peer car-rental marketplace");
    expect(line).toContain("early but live");
    expect(line).toContain("referrals");
  });

  it("says NOTHING when it has no concrete fact — no hollow 'I read your file'", () => {
    expect(playback({}, "Acme")).toBeNull();
    expect(playback({ shape: "saas" }, "Acme")).toBeNull();
    expect(playback({ stage: 2 }, "Acme")).toBeNull();
  });

  it("omits what it lacks rather than rendering a placeholder", () => {
    const line = playback({ oneLiner: ONE_LINER }, null)!;
    expect(line).toContain("marketplace");
    expect(line).not.toMatch(/undefined|null|unknown/i);
  });

  it("never plays back the not-established marker as a fact", () => {
    const line = playback(
      { oneLiner: ONE_LINER, gtmMotion: "GTM motion: not specified yet - operator to confirm" },
      "Upcar",
    )!;
    expect(line).not.toMatch(/not specified/i);
  });
});

describe("extractCompanyFacts", () => {
  const REAL = "**Upcar, Inc.** is a peer-to-peer car-rental marketplace. Website: **upcar.ai**.\n\nMore prose.";

  it("pulls the one-liner and the shape from a real company doc", () => {
    const f = extractCompanyFacts(REAL);
    expect(f.oneLiner).toContain("peer-to-peer car-rental marketplace");
    expect(f.oneLiner).not.toContain("**");
    expect(f.shape).toBe("marketplace");
  });

  it("returns nulls for an empty or heading-only doc rather than guessing", () => {
    expect(extractCompanyFacts("")).toEqual({ oneLiner: null, shape: null });
    expect(extractCompanyFacts(null)).toEqual({ oneLiner: null, shape: null });
    expect(extractCompanyFacts("# Company").oneLiner).toBeNull();
  });
});

describe("channels options — a paid founder can answer honestly", () => {
  const channelOptions = () =>
    slotsFor({} as Parameters<typeof slotsFor>[0]).find((s) => s.key === "channels")!
      .options;

  it("offers a paid answer", () => {
    const opts = channelOptions();
    expect(opts.some((o) => /paid|ads/i.test(o))).toBe(true);
  });

  it("does not make a bare Google option carry both search and ads", () => {
    const opts = channelOptions();
    const ambiguous = opts.filter(
      (o) => /google/i.test(o) && !/ad|paid/i.test(o),
    );
    const hasPaid = opts.some((o) => /paid|ads/i.test(o));
    expect(ambiguous.length === 0 || hasPaid).toBe(true);
  });

  it("keeps an honest escape rather than forcing a guess", () => {
    expect(channelOptions().some((o) => /nothing repeatable/i.test(o))).toBe(true);
  });

  it("stays short enough to choose from without re-reading", () => {
    expect(channelOptions().length).toBeLessThanOrEqual(8);
  });
});

describe("interviewPairs: setup's number question", () => {
  it("adds it after the three slots, trimmed", () => {
    expect(interviewPairs({ interview: { answers: { customers: " 21-100 ", metric: "Customers worth more" } } })).toEqual([
      { question: expect.stringMatching(/one thing got better/i), answer: "Customers worth more" },
      { question: CUSTOMERS_QUESTION, answer: "21-100" },
    ]);
  });
  it("drops a blank number and never makes it a slot", () => {
    expect(interviewPairs({ interview: { answers: { customers: "  " } } })).toEqual([]);
    expect(buildInterview({}, { customers: "6-20" } as never).slots.map((s) => s.key)).toEqual(["metric", "constraint", "channels"]);
  });
});

describe("interviewNoteFields: an answer never replaces a live strategy", () => {
  it("keeps a live strategy note's title, body, source and tags", () => {
    const note = { id: "n1", metadata: { strategy: { x: 1 } }, title: "Growth strategy", body_markdown: "# The plan", source: "agent_write", source_ref: "run-1", tags: ["growth-strategy", "current"] };
    expect(interviewNoteFields(note, "_Interview in progress._", "current")).toEqual({
      title: "Growth strategy", body_markdown: "# The plan", source: "agent_write", source_ref: "run-1", tags: ["growth-strategy", "current"],
    });
  });
  it("writes the in-progress placeholder before any strategy exists", () => {
    expect(interviewNoteFields({ id: null, metadata: {} }, "_Interview in progress._", "current")).toEqual({
      title: "Growth strategy — in progress", body_markdown: "_Interview in progress._", source: "human", tags: ["current"],
    });
  });
});
