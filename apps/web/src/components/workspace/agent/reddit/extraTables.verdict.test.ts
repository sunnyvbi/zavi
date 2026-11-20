// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_SWITCH_EVENT } from "@/lib/workspace/tenantSwitch";

type Item = { item: string; item_type?: string | null; status?: string | null };

const db = vi.hoisted(() => ({ items: [] as Item[], puts: 0 }));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const next = (JSON.parse(String(init.body)) as { items: Item[] }).items;
      await new Promise((r) => setTimeout(r, 20));
      db.items = next.map((i) => ({ ...i }));
      db.puts += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    const snapshot = db.items.map((i) => ({ ...i }));
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true, status: 200, json: async () => ({ fields: { communities: snapshot } }) };
  }),
}));

import { saveVerdict } from "./extraTables";

const verdictOf = (name: string) => db.items.find((i) => i.item.toLowerCase() === name.toLowerCase())?.item_type;

describe("self-promo verdicts changed back to back", () => {
  beforeEach(() => {
    db.puts = 0;
    db.items = [
      { item: "SaaS", item_type: null, status: "tracking" },
      { item: "startups", item_type: null, status: "tracking" },
    ];
  });

  it("keeps both answers when two rows are changed within a second", async () => {
    await Promise.all([saveVerdict("r/SaaS", "banned"), saveVerdict("startups", "allowed")]);

    expect(db.puts).toBe(2);
    expect(verdictOf("SaaS")).toBe("banned");
    expect(verdictOf("startups")).toBe("allowed");
  });

  it("keeps both new communities when two unsaved ones get a verdict together", async () => {
    await Promise.all([saveVerdict("r/smallbusiness", "unclear"), saveVerdict("r/Entrepreneur", "banned")]);

    expect(verdictOf("smallbusiness")).toBe("unclear");
    expect(verdictOf("Entrepreneur")).toBe("banned");
    expect(db.items).toHaveLength(4);
  });

  it("a failed save does not block the next one", async () => {
    const { apiFetch } = await import("@/lib/api");
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);

    const first = saveVerdict("SaaS", "banned");
    const second = saveVerdict("startups", "allowed");

    await expect(first).rejects.toThrow();
    await second;
    expect(verdictOf("startups")).toBe("allowed");
  });

  it("drops queued writes when the workspace changes", async () => {
    const first = saveVerdict("SaaS", "banned");
    const stale = saveVerdict("startups", "allowed");
    window.dispatchEvent(new Event(TENANT_SWITCH_EVENT));

    await expect(first).rejects.toThrow("Workspace changed");
    await expect(stale).rejects.toThrow("Workspace changed");
    expect(db.puts).toBe(0);
  });
});
