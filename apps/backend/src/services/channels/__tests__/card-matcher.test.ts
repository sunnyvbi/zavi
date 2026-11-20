import { describe, expect, it, vi } from "vitest";
import {
  buildMatcherPrompt,
  isDropped,
  isReplace,
  matchRunCards,
  mayBeSameWork,
  normalizeRef,
  parseMatchVerdicts,
  type FreshCard,
  type PoolCard,
} from "../card-matcher";

const FRESH: FreshCard[] = [
  { ref: "n0", title: "Update your LinkedIn headline to lead with the company", summary: "headline" },
  { ref: "n1", title: "Pause the Awareness campaign", summary: "pause" },
  { ref: "n2", title: "Duplicate the brand campaign as a test", summary: "test" },
  { ref: "n3", title: "Post the launch thread", summary: "post" },
];

const POOL: PoolCard[] = [
  { id: "open-li", channel: "linkedin_organic", status: "open", title: "Replace your LinkedIn headline", summary: "" },
  { id: "done-pause", channel: "meta_ads", status: "acted", title: "Pause Awareness", summary: "" },
  { id: "rej-dup", channel: "google_ads", status: "rejected", title: "Duplicate your best campaign", summary: "" },
  { id: "open-other", channel: "x_organic", status: "open", title: "Post the launch thread", summary: "" },
];

const ans = (rows: unknown[]) => JSON.stringify(rows);

describe("parseMatchVerdicts", () => {
  it("trusts a verdict whose match is in the pool with the status it claims", () => {
    const v = parseMatchVerdicts(
      ans([
        { ref: "n0", decision: "same_open", match_id: "open-li", reason: "same headline" },
        { ref: "n1", decision: "already_done", match_id: "done-pause", changed: false },
        { ref: "n2", decision: "already_rejected", match_id: "rej-dup", changed: false },
        { ref: "n3", decision: "new", match_id: null },
      ]),
      "linkedin_organic",
      FRESH,
      POOL,
    )!;
    expect(v.map((x) => [x.decision, x.match_id])).toEqual([
      ["same_open", "open-li"],
      ["already_done", "done-pause"],
      ["already_rejected", "rej-dup"],
      ["new", null],
    ]);
    expect(v.map(isDropped)).toEqual([false, true, true, false]);
    expect(v.map(isReplace)).toEqual([true, false, false, false]);
  });

  it("an open card on ANOTHER channel is not a repeat: duplicates across channels are kept", () => {
    const [v] = parseMatchVerdicts(
      ans([{ ref: "n3", decision: "same_open", match_id: "open-other" }]),
      "linkedin_organic",
      [FRESH[3]],
      POOL,
    )!;
    expect(v.decision).toBe("new");
  });

  it("a match id outside the pool, or with the wrong status, reads as new", () => {
    const v = parseMatchVerdicts(
      ans([
        { ref: "n0", decision: "same_open", match_id: "not-in-pool" },
        { ref: "n1", decision: "already_done", match_id: "rej-dup", changed: false },
        { ref: "n2", decision: "already_rejected", match_id: "open-li", changed: false },
      ]),
      "linkedin_organic",
      FRESH.slice(0, 3),
      POOL,
    )!;
    expect(v.every((x) => x.decision === "new" && !isDropped(x) && !isReplace(x))).toBe(true);
  });

  it("'changed' lets done or rejected work come back; a same_open always replaces", () => {
    const v = parseMatchVerdicts(
      ans([
        { ref: "n0", decision: "same_open", match_id: "open-li", changed: true },
        { ref: "n1", decision: "already_done", match_id: "done-pause", changed: true },
      ]),
      "linkedin_organic",
      FRESH.slice(0, 2),
      POOL,
    )!;
    expect(v.map(isDropped)).toEqual([false, false]);
    expect(v.map(isReplace)).toEqual([true, false]);
  });

  it("a done/rejected verdict without a boolean 'changed' reads as new, never as a drop", () => {
    const v = parseMatchVerdicts(
      ans([
        { ref: "n1", decision: "already_done", match_id: "done-pause" },
        { ref: "n2", decision: "already_rejected", match_id: "rej-dup", changed: "true" },
      ]),
      "linkedin_organic",
      FRESH.slice(1, 3),
      POOL,
    )!;
    expect(v.map((x) => x.decision)).toEqual(["new", "new"]);
  });

  it("a repeat inside the same run drops the LATER card only", () => {
    const v = parseMatchVerdicts(
      ans([
        { ref: "n3", decision: "same_new", match_id: "n0" },
        { ref: "n0", decision: "same_new", match_id: "n3" },
      ]),
      "linkedin_organic",
      FRESH,
      POOL,
    )!;
    expect(v.find((x) => x.ref === "n3")?.decision).toBe("same_new");
    expect(v.find((x) => x.ref === "n0")?.decision).toBe("new");
    expect(v.filter(isDropped).map((x) => x.ref)).toEqual(["n3"]);
  });

  it("a card is never hidden as a repeat of another card that is itself hidden", () => {
    const v = parseMatchVerdicts(
      ans([
        { ref: "n1", decision: "already_done", match_id: "done-pause", changed: false },
        { ref: "n3", decision: "same_new", match_id: "n1" },
      ]),
      "linkedin_organic",
      FRESH,
      POOL,
    )!;
    expect(v.filter(isDropped).map((x) => x.ref)).toEqual(["n1"]);
  });

  it("a card repeating an earlier card that REPLACES an open card is dropped (the replacement is shown)", () => {
    const v = parseMatchVerdicts(
      ans([
        { ref: "n0", decision: "same_open", match_id: "open-li" },
        { ref: "n3", decision: "same_new", match_id: "n0" },
      ]),
      "linkedin_organic",
      FRESH,
      POOL,
    )!;
    expect(v.filter(isDropped).map((x) => x.ref)).toEqual(["n3"]);
    expect(v.filter(isReplace).map((x) => x.ref)).toEqual(["n0"]);
  });

  it("unknown or duplicated refs are ignored; a skipped card reads as new", () => {
    const v = parseMatchVerdicts(
      ans([
        { ref: "zz", decision: "same_open", match_id: "open-li" },
        { ref: "n0", decision: "new" },
        { ref: "n0", decision: "same_open", match_id: "open-li" },
      ]),
      "linkedin_organic",
      FRESH.slice(0, 2),
      POOL,
    )!;
    expect(v.map((x) => x.decision)).toEqual(["new", "new"]);
  });

  it("prose or broken JSON is not an answer", () => {
    expect(parseMatchVerdicts("I think they are all new.", "x", FRESH, POOL)).toBeNull();
    expect(parseMatchVerdicts("[{ref: n0}", "x", FRESH, POOL)).toBeNull();
  });
});

describe("matchRunCards", () => {
  it("fails open: a throwing model call returns null", async () => {
    const call = vi.fn(async () => {
      throw new Error("timeout");
    });
    expect(await matchRunCards("linkedin_organic", FRESH, POOL, { call: call as never })).toBeNull();
  });

  it("skips the call when there is nothing to compare against", async () => {
    const call = vi.fn();
    expect(await matchRunCards("linkedin_organic", FRESH.slice(0, 1), [], { call: call as never })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("uses the cheap model and returns parsed verdicts with token usage", async () => {
    const call = vi.fn(async () => ({
      text: ans([{ ref: "n0", decision: "same_open", match_id: "open-li" }]),
      usage: { input_tokens: 900, output_tokens: 40 },
      provider: "anthropic",
    }));
    const r = await matchRunCards("linkedin_organic", FRESH.slice(0, 1), POOL, { call: call as never });
    expect(r?.verdicts[0].decision).toBe("same_open");
    expect(r?.input_tokens).toBe(900);
    expect((call.mock.calls[0] as unknown[])[0]).toMatchObject({ model: expect.stringContaining("haiku") });
  });
});

describe("buildMatcherPrompt", () => {
  it("tells the model a series and different targets are not the same work", () => {
    const { system, user } = buildMatcherPrompt("linkedin_organic", FRESH, POOL);
    expect(system).toMatch(/series/);
    expect(system).toMatch(/different targets/);
    expect(user).toContain("id=done-pause [ACTED, channel meta_ads]");
    expect(user).toContain("ref=n0");
    expect(system).toContain("same_new|already_done");
  });
});

describe("labels rule pairs out in code (Ravi 2026-09-28: labels, not guesses)", () => {
  it("normalizeRef: one spelling per thing", () => {
    expect(normalizeRef({ kind: "page", ref: "https://www.site.com/Host/Become-Host/?utm=x" })).toBe("page:/host/become-host");
    expect(normalizeRef({ kind: "page", ref: "/host/become-host" })).toBe("page:/host/become-host");
    expect(normalizeRef({ kind: "profile", ref: "@SomeBrand" })).toBe("profile:somebrand");
    expect(normalizeRef({ kind: "campaign", ref: "Brand - Search  (US)" })).toBe("campaign:brand - search us");
  });

  it("a catch-all card is never the same work; different targets never are; unlabelled stays a candidate", () => {
    const q = { target: { kind: "queue", ref: "pending approvals" } };
    const a = { target: { kind: "page", ref: "/pricing" } };
    const b = { target: { kind: "page", ref: "https://x.com/pricing/" } };
    const c = { target: { kind: "page", ref: "/about" } };
    expect(mayBeSameWork(q, a)).toBe(false);
    expect(mayBeSameWork(a, q)).toBe(false);
    expect(mayBeSameWork(a, c)).toBe(false);
    expect(mayBeSameWork(a, b)).toBe(true);
    expect(mayBeSameWork(a, {})).toBe(true);
  });

  it("no candidate anywhere: no model call, every card is new", async () => {
    const call = vi.fn();
    const fresh: FreshCard[] = [
      { ref: "n0", title: "Pin this post", summary: "", target: { kind: "post", ref: "evergreen post" } },
      { ref: "n1", title: "Fix the about title", summary: "", target: { kind: "page", ref: "/about" } },
    ];
    const pool: PoolCard[] = [
      { id: "q1", channel: "x_organic", status: "open", title: "Clear your pending approvals", summary: "", target: { kind: "queue", ref: "approvals" } },
    ];
    expect(await matchRunCards("x_organic", fresh, pool, { call: call as never })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("the model can only match within the candidates code allowed", async () => {
    const fresh: FreshCard[] = [
      { ref: "n0", title: "Add FAQ to /pricing", summary: "", target: { kind: "page", ref: "/pricing" } },
    ];
    const pool: PoolCard[] = [
      { id: "p-pricing", channel: "seo", status: "open", title: "Fix /pricing title", summary: "", target: { kind: "page", ref: "/pricing" } },
      { id: "p-about", channel: "seo", status: "open", title: "Fix /about title", summary: "", target: { kind: "page", ref: "/about" } },
    ];
    const call = vi.fn(async () => ({
      text: JSON.stringify([{ ref: "n0", decision: "same_open", match_id: "p-about" }]),
      usage: { input_tokens: 1, output_tokens: 1 },
      provider: "anthropic",
    }));
    const r = await matchRunCards("seo", fresh, pool, { call: call as never });
    expect(r?.verdicts[0].decision).toBe("new");
    const prompt = (call.mock.calls[0] as unknown[])[0] as { messages: Array<{ content: string }> };
    expect(prompt.messages[0].content).toContain("p-pricing");
    expect(prompt.messages[0].content).not.toContain("p-about");
  });
});
