// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));
import { GrowthCommandCenter } from "./GrowthCommandCenter";
import type { GrowthPlanPayload } from "@/lib/workspace/useGrowthPlan";

const data: GrowthPlanPayload = {
  plan: null, bets: [], goals: { max_active: 3, active_count: 0, over_cap: false, items: [] },
  metrics: [], channels: [], changes: [], unreadable: [],
};
afterEach(cleanup);

describe("GrowthCommandCenter setup additions", () => {
  it("a failed setup draft says so and offers a (refunded) Try again", () => {
    const onRetry = vi.fn();
    render(<GrowthCommandCenter data={data} onChanged={async () => {}} draftFailed onRetryDraft={onRetry} />);
    expect(screen.getByText("Something went wrong cooking your strategy")).toBeTruthy();
    expect(screen.queryByText("This try uses your credits.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("after the 3 refunded drafts, Try again is a charged (tracked) try and says so", () => {
    const onRetry = vi.fn();
    render(<GrowthCommandCenter data={data} onChanged={async () => {}} draftFailed retryCharged onRetryDraft={onRetry} />);
    expect(screen.getByText("This try uses your credits.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
  it("the Building line wins while a draft runs", () => {
    render(<GrowthCommandCenter data={data} onChanged={async () => {}} drafting draftFailed onRetryDraft={() => {}} />);
    expect(screen.queryByText("Something went wrong cooking your strategy")).toBeNull();
  });
  it("renders a page footer and a Company Details footer", async () => {
    render(<GrowthCommandCenter data={data} onChanged={async () => {}} footer={<p>ready card</p>} companyFooter={<p>add knowledge</p>} />);
    expect(screen.getByText("ready card")).toBeTruthy();
    expect(await screen.findByText("add knowledge")).toBeTruthy();
  });
});
