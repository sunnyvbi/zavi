import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => {
    throw new Error("no db in this test");
  },
}));

import { withCardTimelines, type CardEvent } from "../card-timeline";
import { mergeDecorations } from "../channel-actions";

type Card = { id: string; body: unknown; cap_warning?: string; approval?: unknown; timeline?: unknown };

describe("mergeDecorations", () => {
  const base: Card[] = [
    { id: "a", body: { media: { storage_path: "p/a.png" } } },
    { id: "b", body: { text: "plain" } },
  ];

  it("keeps the signed body and adds what each other decoration added", () => {
    const signed: Card[] = [{ ...base[0], body: { media: { url: "https://signed/a" } } }, base[1]];
    const warned: Card[] = [base[0], { ...base[1], cap_warning: "over budget" }];
    const timed: Card[] = [{ ...base[0], approval: { by: "you" }, timeline: [] }, base[1]];
    const out = mergeDecorations(base, signed, [warned, timed]);
    expect(out).toEqual([
      { id: "a", body: { media: { url: "https://signed/a" } }, approval: { by: "you" }, timeline: [] },
      { id: "b", body: { text: "plain" }, cap_warning: "over budget" },
    ]);
  });

  it("never lets another decoration overwrite the signed media", () => {
    const signed: Card[] = [{ ...base[0], body: { media: { url: "https://signed/a" } } }, base[1]];
    const sneaky: Card[] = [{ ...base[0], body: { media: { storage_path: "p/a.png" } }, cap_warning: "x" }, base[1]];
    const out = mergeDecorations(base, signed, [sneaky]);
    expect(out[0].body).toEqual({ media: { url: "https://signed/a" } });
    expect(out[0].cap_warning).toBe("x");
  });

  it("returns the signed card itself when nothing else changed it", () => {
    const signed = [...base];
    const out = mergeDecorations(base, signed, [[...base], [...base]]);
    expect(out[0]).toBe(base[0]);
    expect(out[1]).toBe(base[1]);
  });

  it("ignores a layer that changed the list's length instead of mis-pairing it", () => {
    const out = mergeDecorations(base, [...base], [[{ ...base[1], cap_warning: "wrong card" }]]);
    expect(out).toEqual(base);
  });
});

describe("withCardTimelines reads events and names together", () => {
  const VIEWER = "viewer";
  const MATE = "mate";
  const rows = new Map([["a1", { approved_by: MATE, approved_by_source: null, exec_claimed_at: "2026-11-01T10:00:00Z" }]]);
  const views = [{ id: "a1", exec_status: "executed", exec_bucket: null }];

  it("starts the names read before the events read has answered, with the same result", async () => {
    let releaseEvents!: (e: CardEvent[]) => void;
    const readEvents = vi.fn(() => new Promise<CardEvent[]>((r) => (releaseEvents = r)));
    const readNames = vi.fn(async (_t: string, ids: string[]) => new Map(ids.map((i) => [i, "Priya"])));
    const pending = withCardTimelines("t1", views, rows, VIEWER, { readEvents, readNames });
    await Promise.resolve();
    await Promise.resolve();
    expect(readEvents).toHaveBeenCalledTimes(1);
    expect(readNames).toHaveBeenCalledWith("t1", [MATE]);
    releaseEvents([{ id: 1, action_id: "a1", event: "approved", actor_kind: "founder", at: "2026-11-01T09:59:00Z" }]);
    const out = await pending;
    expect(out[0]).toMatchObject({ approval: { by: "teammate", name: "Priya" }, exec_started_at: "2026-11-01T10:00:00Z" });
  });

  it("a failed events read still serves the slow clock and no approval", async () => {
    const readEvents = vi.fn(async () => {
      throw new Error("events down");
    });
    const readNames = vi.fn(async () => new Map<string, string | null>());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await withCardTimelines("t1", views, rows, VIEWER, { readEvents, readNames });
    warn.mockRestore();
    expect(out[0]).toEqual({ ...views[0], exec_started_at: "2026-11-01T10:00:00Z" });
  });
});
