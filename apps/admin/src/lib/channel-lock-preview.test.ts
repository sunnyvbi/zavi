import { it, expect, vi, beforeEach } from "vitest";
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-admin", () => ({ adminApiFetch: fetchMock }));
import { readLockPreview } from "./channel-lock-preview";

beforeEach(() => {
  fetchMock.mockReset();
});

it("a preview the server refuses is null, so the page still offers the lock", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 }));
  await expect(readLockPreview("linkedin_ads")).resolves.toBeNull();
});

it("a preview that never reaches the server is null, not a thrown error", async () => {
  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(readLockPreview("linkedin_ads")).resolves.toBeNull();
});

it("a preview body that is not JSON is null", async () => {
  fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));
  await expect(readLockPreview("linkedin_ads")).resolves.toBeNull();
});

it("a preview that reads carries the campaign note through", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ running_runs: 1, schedules: 2, companies: 1, schedules_skipped_reason: null, live_campaigns_note: "unread" }), { status: 200 }));
  await expect(readLockPreview("linkedin_ads")).resolves.toMatchObject({ running_runs: 1, live_campaigns_note: "unread" });
  expect(fetchMock).toHaveBeenCalledWith("/api/admin/channel-locks/linkedin_ads/impact");
});
