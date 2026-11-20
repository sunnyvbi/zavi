// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), campaignFetch: api }));
vi.mock("@/lib/stripe/adsStripe", () => ({ adsPublishableKey: () => null, adsStripe: () => null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => null }));
import { ChannelBalance } from "./ChannelBalance";
import { chatgpt_ads } from "../platforms/chatgpt_ads";

const spec = chatgpt_ads.campaignWorkspace!;
const wallet = { balance_cents: 0, reserved_cents: 0, available_cents: 0, funding_enabled: true, in_app_enabled: false, auto_refill_enabled: false, refill_cents: 0, threshold_cents: 2000, pending: false, last_error: null };

beforeEach(() => {
  api.mockReset();
  api.mockResolvedValue(wallet);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

describe("the shared ads balance card", () => {
  it("puts Add Balance in the same row as the title and amount, not on a line below them", async () => {
    render(<ChannelBalance spec={spec} platform="linkedin" variant="card" />);
    const add = await screen.findByRole("button", { name: "Add Balance" });
    const row = add.parentElement as HTMLElement;
    expect(row.textContent).toContain("Shared ads balance");
    expect(row.textContent).toContain("$0.00");
    expect(row.className).toMatch(/\bflex\b/);
    expect(row.className).not.toMatch(/\bflex-col\b/);
  });
});
