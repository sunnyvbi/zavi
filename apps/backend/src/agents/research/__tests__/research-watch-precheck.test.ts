
import { describe, it, expect, vi } from "vitest";
import {
  detectResearchWatchDelta,
  shouldShortCircuitResearchWatch,
  type BaselineSource,
} from "../research-watch-precheck";

describe("detectResearchWatchDelta (pure)", () => {
  it("no change → anyDelta false, no changed urls, not uncertain", () => {
    const baseline: BaselineSource[] = [
      { url: "https://a.com", excerpt: "hello world" },
      { url: "https://b.com", excerpt: "second page" },
    ];
    const refetched = [
      {
        url: "https://a.com",
        content: "<untrusted_web_content>\n  hello   world  \n</untrusted_web_content>",
        ok: true,
      },
      { url: "https://b.com", content: "second page", ok: true },
    ];
    const r = detectResearchWatchDelta(baseline, refetched);
    expect(r.anyDelta).toBe(false);
    expect(r.changedUrls).toEqual([]);
    expect(r.uncertain).toBe(false);
  });

  it("one URL changed → anyDelta true with that url", () => {
    const baseline: BaselineSource[] = [
      { url: "https://a.com", excerpt: "hello world" },
      { url: "https://b.com", excerpt: "second page" },
    ];
    const refetched = [
      { url: "https://a.com", content: "hello world", ok: true },
      { url: "https://b.com", content: "second page CHANGED", ok: true },
    ];
    const r = detectResearchWatchDelta(baseline, refetched);
    expect(r.anyDelta).toBe(true);
    expect(r.changedUrls).toEqual(["https://b.com"]);
    expect(r.uncertain).toBe(false);
  });

  it("a failed re-fetch → uncertain true (NOT suppressible)", () => {
    const baseline: BaselineSource[] = [
      { url: "https://a.com", excerpt: "hello world" },
      { url: "https://b.com", excerpt: "second page" },
    ];
    const refetched = [
      { url: "https://a.com", content: "hello world", ok: true },
      { url: "https://b.com", content: "", ok: false },
    ];
    const r = detectResearchWatchDelta(baseline, refetched);
    expect(r.uncertain).toBe(true);
  });

  it("a missing re-fetch (url absent) → uncertain true", () => {
    const baseline: BaselineSource[] = [
      { url: "https://a.com", excerpt: "hello world" },
      { url: "https://missing.com", excerpt: "x" },
    ];
    const refetched = [{ url: "https://a.com", content: "hello world", ok: true }];
    const r = detectResearchWatchDelta(baseline, refetched);
    expect(r.uncertain).toBe(true);
  });

  it("empty baseline → no delta, not uncertain (caller decides not-short-circuitable)", () => {
    const r = detectResearchWatchDelta([], []);
    expect(r.anyDelta).toBe(false);
    expect(r.uncertain).toBe(false);
    expect(r.changedUrls).toEqual([]);
  });
});

describe("shouldShortCircuitResearchWatch (orchestration)", () => {
  const okFetch = (content: string) =>
    vi.fn(async () => ({ content, ok: true }));

  it("zero delta, all ok → shortCircuit true", async () => {
    const r = await shouldShortCircuitResearchWatch({
      tenant_id: "t1",
      topic_key: "topic",
      loadBaseline: async () => [
        { url: "https://a.com", excerpt: "same" },
        { url: "https://b.com", excerpt: "same2" },
      ],
      refetch: async (url) => ({
        content: url === "https://a.com" ? "same" : "same2",
        ok: true,
      }),
    });
    expect(r.shortCircuit).toBe(true);
    expect(r.totalUrls).toBe(2);
    expect(r.changedUrls).toEqual([]);
  });

  it("one delta → shortCircuit false", async () => {
    const r = await shouldShortCircuitResearchWatch({
      tenant_id: "t1",
      topic_key: "topic",
      loadBaseline: async () => [{ url: "https://a.com", excerpt: "old" }],
      refetch: okFetch("NEW content"),
    });
    expect(r.shortCircuit).toBe(false);
    expect(r.changedUrls).toEqual(["https://a.com"]);
  });

  it("a fetch failure → shortCircuit false (fail-open via uncertainty)", async () => {
    const r = await shouldShortCircuitResearchWatch({
      tenant_id: "t1",
      topic_key: "topic",
      loadBaseline: async () => [
        { url: "https://a.com", excerpt: "same" },
        { url: "https://b.com", excerpt: "same2" },
      ],
      refetch: async (url) =>
        url === "https://a.com"
          ? { content: "same", ok: true }
          : { content: "", ok: false },
    });
    expect(r.shortCircuit).toBe(false);
  });

  it("zero baseline → shortCircuit false (never suppress with no baseline)", async () => {
    const refetch = vi.fn();
    const r = await shouldShortCircuitResearchWatch({
      tenant_id: "t1",
      topic_key: null,
      loadBaseline: async () => [],
      refetch,
    });
    expect(r.shortCircuit).toBe(false);
    expect(r.totalUrls).toBe(0);
    expect(refetch).not.toHaveBeenCalled();
  });
});
