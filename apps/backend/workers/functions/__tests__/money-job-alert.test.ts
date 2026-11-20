import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/alert", () => ({ alert: vi.fn(async () => {}) }));

import type { AlertInput } from "@/services/logging/alert";
import { alertMoneyJobErrors } from "../_money-job-alert";

const sender = () => vi.fn(async (_input: AlertInput) => {});
const sent = (f: ReturnType<typeof sender>) => f.mock.lastCall?.[0];

describe("alertMoneyJobErrors", () => {
  it("pages once with an hourly email dedupe key and names the failing workspaces", async () => {
    const send = sender();
    await alertMoneyJobErrors("ad-spend-controller", ["t-a", "t-b"], 4, send);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "ad-spend-controller",
        code: "ad_spend_controller_errors",
        msg: expect.stringContaining("2 of 4 workspaces"),
        email: { dedupeKey: expect.stringMatching(/^money-job:ad-spend-controller:\d+$/) },
      }),
    );
    expect(sent(send)?.msg).toContain("Workspaces: t-a, t-b.");
  });

  it("keeps the page global (not tenant-readable) and caps a long list", async () => {
    const one = sender();
    await alertMoneyJobErrors("chatgpt-ads-wallet", ["t-only"], 14, one);
    expect(sent(one)?.tenant_id).toBeUndefined();
    expect(sent(one)?.msg).toContain("Workspaces: t-only.");

    const many = sender();
    await alertMoneyJobErrors("chatgpt-ads-wallet", ["1", "2", "3", "4", "5", "6", "7"], 14, many);
    expect(sent(many)?.msg).toContain("Workspaces: 1, 2, 3, 4, 5 (+2 more).");
  });

  it("stays quiet on a clean run and never throws when paging fails", async () => {
    const quiet = sender();
    await alertMoneyJobErrors("cgo-budget-review", [], 3, quiet);
    expect(quiet).not.toHaveBeenCalled();
    const broken = vi.fn(async () => {
      throw new Error("webhook down");
    });
    await expect(alertMoneyJobErrors("cgo-budget-review", ["t"], 3, broken)).resolves.toBeUndefined();
  });
});
