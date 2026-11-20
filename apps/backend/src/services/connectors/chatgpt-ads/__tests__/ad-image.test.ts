import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ row: {} as any, deliver: vi.fn(), log: vi.fn() }));
vi.mock("../action-execution", async () => {
  const { ExpectedToolError } = await import("@/services/tools/types");
  return {
    readAction: async () => m.row,
    assertReviewable: (row: any) => { if (row.status !== "pending" || row.exec_class) throw new ExpectedToolError("chatgpt_ads_conflict", "This action changed."); },
  };
});
vi.mock("@/services/reports/deliver-image", () => ({ deliverImage: m.deliver }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
import { createAdImage } from "../ad-image";

const tenant = "11111111-1111-4111-8111-111111111111";
const run = "20000000-0000-4000-8000-000000000002";
const action = "10000000-0000-4000-8000-000000000001";
const path = `${tenant}/33333333-3333-4333-8333-333333333333.jpg`;
beforeEach(() => {
  vi.clearAllMocks();
  m.row = { status: "pending", exec_class: null, run_id: run };
  m.deliver.mockResolvedValue({ images: [{ artifact_id: "art", filename: "chatgpt-ad-image.png", bytes: 1, cached: false, image_path: path }], skipped: [], generated: 1, cached: 0, typeset: 0, slack_ok: true });
});

it("makes a square photo through the metered pipeline, bound to the run that drafted the card", async () => {
  expect(await createAdImage(tenant, action, { prompt: "A clean car parked by a beach at sunset" })).toEqual({ image_path: path });
  expect(m.deliver).toHaveBeenCalledWith(
    { tenant_id: tenant, run_id: run, stageable: true },
    { prompts: [{ prompt: "A clean car parked by a beach at sunset", filename: "chatgpt-ad-image" }], aspect_ratio: "1:1", mode: "photo" },
  );
});
it("ignores a run id sent in the request", async () => {
  await expect(createAdImage(tenant, action, { prompt: "A car", run_id: "other" })).rejects.toThrow();
  expect(m.deliver).not.toHaveBeenCalled();
});
it.each([["empty", ""], ["too short", "ab"], ["too long", "x".repeat(901)]])("refuses a %s description before spending", async (_w, prompt) => {
  await expect(createAdImage(tenant, action, { prompt })).rejects.toThrow();
  expect(m.deliver).not.toHaveBeenCalled();
});
it("refuses once the draft is no longer waiting for review", async () => {
  m.row.status = "acted";
  await expect(createAdImage(tenant, action, { prompt: "A car by the sea" })).rejects.toThrow(/changed/);
  expect(m.deliver).not.toHaveBeenCalled();
});
it("refuses a draft with no run to bill against", async () => {
  m.row.run_id = null;
  await expect(createAdImage(tenant, action, { prompt: "A car by the sea" })).rejects.toMatchObject({ code: "image_service_unavailable" });
  expect(m.deliver).not.toHaveBeenCalled();
});
it.each([
  ["insufficient_credits", "insufficient_credits", /enough credits/],
  ["refused", "image_refused", /declined/],
  ["vendor_out_of_credits", "image_service_unavailable", /Upload your own/],
  ["over_daily_cap", "image_daily_limit", /limit/],
])("tells the founder what a %s refusal means", async (reason, code, words) => {
  m.deliver.mockResolvedValue({ images: [], skipped: [{ index: 0, reason }], generated: 0, cached: 0, typeset: 0, slack_ok: true });
  await expect(createAdImage(tenant, action, { prompt: "A car by the sea" })).rejects.toMatchObject({ code, message: expect.stringMatching(words) });
});
it("logs a made-but-unattached image as an error (the founder paid for it)", async () => {
  m.deliver.mockResolvedValue({ images: [{ artifact_id: "art", filename: "x.png", bytes: 1, cached: false }], skipped: [], generated: 1, cached: 0, typeset: 0, slack_ok: true });
  await expect(createAdImage(tenant, action, { prompt: "A car by the sea" })).rejects.toMatchObject({ code: "image_unavailable" });
  expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ level: "error", code: "chatgpt_ads.ad_image_copy_failed" }));
});
it("a New AI image click asks for a different picture; a retry of the same click asks for the same one", async () => {
  await createAdImage(tenant, action, { prompt: "A car by the sea" });
  await createAdImage(tenant, action, { prompt: "A car by the sea", variation: 2 });
  await createAdImage(tenant, action, { prompt: "A car by the sea", variation: 2 });
  const prompts = m.deliver.mock.calls.map(c => c[1].prompts[0].prompt);
  expect(prompts[0]).toBe("A car by the sea");
  expect(prompts[1]).not.toBe(prompts[0]);
  expect(prompts[1]).toMatch(/^A car by the sea\n\nVersion 2:/);
  expect(prompts[2]).toBe(prompts[1]);
  expect(prompts[1].length).toBeLessThanOrEqual(1000);
});
it("the longest allowed description still fits the image pipeline with a variation", async () => {
  const { variationPrompt } = await import("../ad-image");
  expect(variationPrompt("x".repeat(900), 100).length).toBeLessThanOrEqual(1000);
});
