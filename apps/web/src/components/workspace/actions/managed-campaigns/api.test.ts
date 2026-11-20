import { beforeEach, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { campaignFetch } from "./api";

const launch = () => campaignFetch<never>("/api/ads/campaigns/x/launch", { method: "POST", body: "{}" });

beforeEach(() => {
  apiFetch.mockReset();
});

it("marks a launch whose connection dropped as a lost reply, never a refusal", async () => {
  apiFetch.mockRejectedValue(new TypeError("Failed to fetch"));
  const e = await launch().catch((x: any) => x);
  expect(e).toBeInstanceOf(TypeError);
  expect(e.reply_lost).toBe(true);
  expect(e.status).toBeUndefined();
});

it("marks an unreadable reply, such as a gateway page, as a lost reply", async () => {
  apiFetch.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  const e = await launch().catch((x: any) => x);
  expect(e.reply_lost).toBe(true);
});

it("keeps a server refusal a refusal, with its status and code and no lost-reply mark", async () => {
  apiFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { message: "Refused", code: "ads_launch_not_sent" } }) });
  const e = await launch().catch((x: any) => x);
  expect(e.message).toBe("Refused");
  expect(e.status).toBe(409);
  expect(e.code).toBe("ads_launch_not_sent");
  expect(e.reply_lost).toBeUndefined();
});

it("does not mark a deliberate cancel as a lost reply", async () => {
  apiFetch.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
  const e = await launch().catch((x: any) => x);
  expect(e.reply_lost).toBeUndefined();
});
