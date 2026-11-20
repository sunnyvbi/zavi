
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const mocks = vi.hoisted(() => ({ fbPost: vi.fn(), getCurrency: vi.fn() }));

vi.mock("../../_client", () => ({
  fbPost: mocks.fbPost,
  getAdAccountCurrency: mocks.getCurrency,
}));

import { metaUpdateAdSetBudget } from "../update_ad_set_budget";
import { metaSetStatus } from "../set_status";

beforeEach(() => {
  mocks.fbPost.mockReset();
  mocks.getCurrency.mockReset();
  mocks.getCurrency.mockResolvedValue("USD");
});

describe("metaUpdateAdSetBudget — Graph success validation", () => {
  it("THROWS when Graph returns 200 {success:false} (no false 'acted')", async () => {
    mocks.fbPost.mockResolvedValue({ success: false });
    await expect(
      metaUpdateAdSetBudget("t1", { ad_set_id: "as1", daily_budget_usd: 11 }),
    ).rejects.toThrow(ExpectedToolError);
  });

  it("THROWS when Graph returns an {error} envelope", async () => {
    mocks.fbPost.mockResolvedValue({ error: { message: "Invalid budget", code: 100 } });
    await expect(
      metaUpdateAdSetBudget("t1", { ad_set_id: "as1", daily_budget_usd: 11 }),
    ).rejects.toThrow(ExpectedToolError);
  });

  it("succeeds on {success:true}", async () => {
    mocks.fbPost.mockResolvedValue({ success: true });
    const r = await metaUpdateAdSetBudget("t1", { ad_set_id: "as1", daily_budget_usd: 11 });
    expect(r.id).toBe("as1");
  });
});

describe("metaSetStatus — Graph success validation", () => {
  it("THROWS when a pause returns 200 {success:false} (silent-fail pause is the dangerous case)", async () => {
    mocks.fbPost.mockResolvedValue({ success: false });
    await expect(
      metaSetStatus("t1", { object_id: "c1", level: "campaign", status: "PAUSED" }),
    ).rejects.toThrow(ExpectedToolError);
  });

  it("succeeds on {success:true}", async () => {
    mocks.fbPost.mockResolvedValue({ success: true });
    const r = await metaSetStatus("t1", { object_id: "c1", level: "campaign", status: "PAUSED" });
    expect(r.status).toBe("PAUSED");
  });
});
