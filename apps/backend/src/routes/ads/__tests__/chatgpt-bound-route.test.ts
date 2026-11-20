import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({ auth: vi.fn(), binding: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.auth }));
vi.mock("@/services/ads-wallet/bindings", () => ({
  getCampaignBinding: m.binding,
}));
vi.mock("../wallet-auth", () => ({ walletError: vi.fn() }));
import { chatgptBoundRoute } from "../chatgpt-bound-route";
import { currentBoundCampaign } from "@/services/ads-wallet/campaign-context";
const id = "10000000-0000-4000-8000-000000000001";
const req = () => ({ params: { bindingId: id } }) as unknown as Request;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response;
};
beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ tenant_id: "t" });
  m.binding.mockResolvedValue({
    id,
    tenant_id: "t",
    platform: "chatgpt",
    provider_campaign_id: "12345",
    account_binding_id: "original",
    funding_source: "provider",
  });
});
it("keeps provider IDs on the server and internal IDs in editor receipts", async () => {
  const response = res();
  const handler = vi.fn(async (request: Request, r: Response) => {
    expect(request.params.campaignId).toBe("12345");
    expect(currentBoundCampaign()?.account_binding_id).toBe("original");
    r.json({
      campaign: { id: "12345", name: "Customer campaign" },
      currency: "USD",
    });
  });
  await chatgptBoundRoute(handler)(req(), response);
  expect(response.json).toHaveBeenCalledWith({
    campaign: { id, provider_campaign_id: "12345", name: "Customer campaign" },
    currency: "USD",
  });
  expect(currentBoundCampaign()).toBeUndefined();
});
it("does not reinterpret a different provider as ChatGPT", async () => {
  m.binding.mockResolvedValue({ platform: "linkedin" });
  const handler = vi.fn();
  const response = res();
  await chatgptBoundRoute(handler)(req(), response);
  expect(response.status).toHaveBeenCalledWith(404);
  expect(handler).not.toHaveBeenCalled();
});
it("never resolves campaign IDs for an unauthenticated request", async () => {
  m.auth.mockResolvedValue(null);
  const handler = vi.fn();
  await chatgptBoundRoute(handler)(req(), res());
  expect(m.binding).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});
