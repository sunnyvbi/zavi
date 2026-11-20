import { describe, expect, it } from "vitest";
import { LINKEDIN_CHANNELS, X_CHANNELS, stagedDrafts } from "../staged-drafts";
import type { DashboardContext } from "@/routes/agents/dashboards/_contract";

const ROWS = [
  { id: "d1", body: { channel: "x", payload: { text: "an x post" } }, emitted_at: "2026-09-22T11:03:45Z" },
  { id: "d2", body: { channel: "linkedin", payload: { text: "a linkedin post about $30/day" } }, emitted_at: "2026-09-22T10:00:00Z" },
  { id: "d3", body: { channel: "linkedin_image", payload: { text: "with an image", image_path: "https://x/y.png" } }, emitted_at: "2026-09-22T09:00:00Z" },
  { id: "d4", body: { channel: "tiktok_video", payload: { text: "not either channel" } }, emitted_at: "2026-09-22T08:00:00Z" },
];

function ctx(answer: { data?: unknown; error?: unknown } = { data: ROWS, error: null }): DashboardContext {
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order"]) chain[k] = () => chain;
  chain.limit = async () => answer;
  return { sb: { from: () => chain }, tenantId: "t-1" } as unknown as DashboardContext;
}

describe("stagedDrafts", () => {
  it("keeps only the channel keys it was asked for", async () => {
    expect((await stagedDrafts(ctx(), X_CHANNELS))!.map((d) => d.decision_id)).toEqual(["d1"]);
    expect((await stagedDrafts(ctx(), LINKEDIN_CHANNELS))!.map((d) => d.decision_id)).toEqual(["d2", "d3"]);
  });

  it("carries the fields the web's pairing adapter reads", async () => {
    const [text, image] = (await stagedDrafts(ctx(), LINKEDIN_CHANNELS))!;
    expect(text).toMatchObject({ source: "staged", channel: "linkedin", text: "a linkedin post about $30/day" });
    expect(text.needs_confirm).toBe(true);
    expect(image.image_path).toBe("https://x/y.png");
    expect(image.needs_confirm).toBe(false);
  });

  it("keeps snoozed proposals, carrying when the snooze ends", async () => {
    const rows = [{ ...ROWS[0], snoozed_until: "2999-01-01T00:00:00Z" }];
    const [d] = (await stagedDrafts(ctx({ data: rows, error: null }), X_CHANNELS))!;
    expect(d.snoozed_until).toBe("2999-01-01T00:00:00Z");
  });

  it("answers null on a failed read rather than throwing or claiming none", async () => {
    expect(await stagedDrafts(ctx({ data: null, error: { message: "boom" } }), X_CHANNELS)).toBeNull();
  });
});

it("binds a staged card revision to all saved payload and media fields", async () => {
  const row = { ...ROWS[0], body: { channel: "x_image", payload: { text: "Same copy", image_path: "first.png" } } };
  const first = (await stagedDrafts(ctx({ data: [row], error: null }), X_CHANNELS))?.[0];
  const changed = { ...row, body: { ...row.body, payload: { ...row.body.payload, image_path: "second.png" } } };
  const second = (await stagedDrafts(ctx({ data: [changed], error: null }), X_CHANNELS))?.[0];
  expect(first?.post_revision).toMatch(/^[a-f0-9]{64}$/);
  expect(second?.post_revision).not.toBe(first?.post_revision);
});
