import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissCreatorCard, parseCreatorDismissals, activeDismissals, creatorDismissalsKey, readCreatorDismissals, storeCreatorDismissal } from "./creatorCardDismissals";

const now = Date.parse("2026-10-14T12:00:00Z");
const id = "instagram_organic-get-creator-video";
describe("temporary creator-card dismissal", () => {
  it("survives a reload for fourteen days and expires at the deadline", () => {
    const hidden = dismissCreatorCard([], id, 14, now);
    const saved = JSON.stringify(hidden);
    expect(parseCreatorDismissals(saved, now + 13 * 86_400_000)).toEqual(hidden);
    expect(parseCreatorDismissals(saved, now + 14 * 86_400_000)).toEqual([]);
    expect(activeDismissals(hidden, now + 14 * 86_400_000)).toEqual([]);
  });
  it("releases the old permanent starter dismissal but preserves other hidden cards", () => {
    expect(parseCreatorDismissals(JSON.stringify([id, "meta_ads-ready-asset", "ugc-brief-b1"]), now)).toEqual(["meta_ads-ready-asset", "ugc-brief-b1"]);
  });
  it("replaces an earlier snooze instead of retaining a permanent entry", () => {
    const first = dismissCreatorCard([id], id, 14, now);
    const second = dismissCreatorCard(first, id, 14, now + 1000);
    expect(second).toEqual([{ id, until: now + 14 * 86_400_000 + 1000 }]);
  });
  it("ignores malformed entries and caps stored history", () => {
    expect(parseCreatorDismissals("invalid", now)).toEqual([]);
    expect(parseCreatorDismissals(JSON.stringify([{ id, until: "forever" }, { until: now + 100 }, null]), now)).toEqual([]);
    expect(dismissCreatorCard(Array.from({ length: 200 }, (_, i) => `card-${i}`), id, 14, now)).toHaveLength(200);
  });
});

describe("stored dismissals per company", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  function fakeStorage() {
    const data = new Map<string, string>();
    const localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    vi.stubGlobal("window", { localStorage });
    return data;
  }

  it("re-reads storage before writing, so another tab's dismissal survives this tab's stale copy", () => {
    const data = fakeStorage();
    const mountCopy = readCreatorDismissals("t1");
    expect(mountCopy).toEqual([]);
    data.set(creatorDismissalsKey("t1"), JSON.stringify(["ugc-applicants-b9"]));
    const next = storeCreatorDismissal("t1", mountCopy, "ugc-post-brief-b1", undefined, now);
    expect(next).toEqual(["ugc-applicants-b9", "ugc-post-brief-b1"]);
    expect(JSON.parse(data.get(creatorDismissalsKey("t1"))!)).toEqual(next);
  });

  it("keeps companies apart and never writes without a company", () => {
    const data = fakeStorage();
    storeCreatorDismissal("t1", [], "ugc-post-brief-b1", undefined, now);
    expect(readCreatorDismissals("t2")).toEqual([]);
    expect(readCreatorDismissals("t1")).toEqual(["ugc-post-brief-b1"]);
    expect(storeCreatorDismissal(null, [], "x", undefined, now)).toEqual(["x"]);
    expect(readCreatorDismissals(null)).toEqual([]);
    expect([...data.keys()]).toEqual([creatorDismissalsKey("t1")]);
  });

  it("falls back to the in-page list when storage throws", () => {
    const boom = () => { throw new Error("blocked"); };
    vi.stubGlobal("window", { localStorage: { getItem: boom, setItem: boom, removeItem: boom } });
    expect(readCreatorDismissals("t1")).toEqual([]);
    expect(storeCreatorDismissal("t1", ["a"], "b", undefined, now)).toEqual(["a", "b"]);
  });
});
