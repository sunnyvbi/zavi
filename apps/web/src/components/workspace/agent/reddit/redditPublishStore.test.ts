import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => "tenant-1" }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));

import {
  readRedditPublishState,
  resetRedditPublishStates,
  restoreRedditPublishStates,
  writeRedditPublishState,
  writeRedditPublishStates,
} from "./redditPublishStore";

const KEY = "source:reply:card-1";
const DISK = `zavi:reddit-publish:v1:tenant-1:${KEY}`;

describe("reddit publish store when a persisted write fails mid-publish", () => {
  beforeEach(async () => {
    resetRedditPublishStates();
    localStorage.clear();
    localStorage.setItem(DISK, JSON.stringify({ status: "refused", decisionId: "old-decision", error: "rules" }));
    await restoreRedditPublishStates();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRedditPublishStates();
  });

  it("reads back the posted state kept in memory, not the stale refused row still on disk", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const posted = { status: "posted" as const, decisionId: "new-decision", error: null };

    expect(() => writeRedditPublishStates([KEY], posted)).toThrow();
    writeRedditPublishStates([KEY], posted, false);
    setItem.mockRestore();

    expect(localStorage.getItem(DISK)).toContain("old-decision");
    expect(readRedditPublishState(KEY)).toEqual(posted);
  });

  it("goes back to the disk copy once a later write persists again", () => {
    writeRedditPublishState(KEY, { status: "posted", decisionId: "new-decision", error: null }, false);
    writeRedditPublishState(KEY, { status: "scheduled", decisionId: "third", error: null });
    localStorage.setItem(DISK, JSON.stringify({ status: "posted", decisionId: "from-other-tab", error: null }));

    expect(readRedditPublishState(KEY).decisionId).toBe("from-other-tab");
  });
});
