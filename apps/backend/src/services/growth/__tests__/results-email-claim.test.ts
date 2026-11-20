
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: new Map<string, boolean>(), failRead: false }));
vi.mock("@/services/settings", () => ({
  getBoolSettingStrict: async (key: string) => {
    if (h.failRead) throw new Error("db down");
    return h.rows.get(key) === true;
  },
  claimTenantFlag: async (_t: string, key: string) => {
    if (h.rows.has(key)) return false;
    h.rows.set(key, true);
    return true;
  },
  setTenantSetting: async (_t: string, key: string, v: unknown) => {
    if (v === null) h.rows.delete(key);
    else h.rows.set(key, v === true);
  },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { claimResultsEmail, releaseResultsEmail, resultsEmailTaken } from "../results-email-claim";

beforeEach(() => {
  h.rows = new Map();
  h.failRead = false;
});

describe("results email claim", () => {
  it("only the first claimer wins; the other email is then refused", async () => {
    expect(await claimResultsEmail("t", "digest")).toBe(true);
    expect(await claimResultsEmail("t", "upgrade")).toBe(false);
    expect(await resultsEmailTaken("t")).toBe(true);
  });

  it("a workspace whose actions-ready email went before the claim existed counts as claimed", async () => {
    h.rows.set("upgrade_actions_ready_email_sent", true);
    expect(await claimResultsEmail("t", "digest")).toBe(false);
    expect(await resultsEmailTaken("t")).toBe(true);
  });

  it("a release lets the next sender claim again", async () => {
    await claimResultsEmail("t", "digest");
    await releaseResultsEmail("t", "digest");
    expect(await resultsEmailTaken("t")).toBe(false);
    expect(await claimResultsEmail("t", "upgrade")).toBe(true);
  });

  it("a read error throws (the caller sends nothing)", async () => {
    h.failRead = true;
    await expect(claimResultsEmail("t", "digest")).rejects.toThrow("db down");
  });
});
