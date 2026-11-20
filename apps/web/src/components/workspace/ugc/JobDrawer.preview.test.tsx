// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { CreatorJobDetail, CreatorJobSubmission } from "@/components/humans/creatorJobTypes";

let served: CreatorJobDetail;
vi.mock("./useCards", () => ({
  callJson: vi.fn(async (path: string) => (path.startsWith("/api/humans/orders/o1") && !path.includes("/fulfil") ? { ok: true, data: served } : { ok: true, data: {} })),
  useCreatorCards: () => ({}),
}));
vi.mock("./PublishCard", () => ({ PublishCard: () => null }));

import { JobDrawer, PREVIEW_POLL_MS } from "./JobDrawer";
import { callJson } from "./useCards";

function sub(over: Partial<CreatorJobSubmission>): CreatorJobSubmission {
  return {
    id: "s1",
    version: 1,
    position: 0,
    kind: "video",
    mime_type: "video/mp4",
    bytes: 10,
    note: null,
    created_at: "2026-10-05T10:00:00Z",
    play_url: null,
    ...over,
  };
}

function job(status: string, closed_reason: string | null, s: CreatorJobSubmission): CreatorJobDetail {
  return {
    job: {
      id: "o1",
      source: "booking",
      status,
      closed_reason,
      title: "Sales promo",
      creator_display_name: "Maya Films",
      creator_slug: null,
      created_at: "2026-10-01T00:00:00Z",
      due_at: null,
      money: { currency: "usd", price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500, business_fee_label: "10%", creator_payout_cents: 12750, payout_status: "held" },
      deadline: null,
      awaiting_creator: false,
    },
    package_snapshot: null,
    brief_snapshot: null,
    submissions: [s],
    actions: [],
    rebook: null,
    extension: null,
    dispute: null,
    thread: { available: false, thread_id: null, messages: [] },
  } as unknown as CreatorJobDetail;
}

beforeEach(() => window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=job&job=o1"));
afterEach(cleanup);

describe("the job drawer before and after the business pays", () => {
  it("before payment plays the watermarked preview, says so, and offers no download", async () => {
    served = job("submitted", null, sub({ play_url: "https://signed.test/preview/s1.mp4", watermarked: true, preview: "ready", download_url: null }));
    render(<JobDrawer />);
    await waitFor(() => expect(screen.getByTestId("preview-note")).toBeTruthy());
    expect(screen.getByTestId("preview-note").textContent).toMatch(/watermarked preview.*unlocks to download and post once you approve and pay/);
    expect(document.querySelector("video")?.getAttribute("src")).toBe("https://signed.test/preview/s1.mp4");
    expect(screen.getByLabelText(/watermarked preview/)).toBeTruthy();
    expect(screen.queryByText("Download the original")).toBeNull();
    expect(screen.queryByText(/Download it and post it/)).toBeNull();
  });

  it("while the watermark is being made shows a waiting tile and the reason, never a player", async () => {
    served = job("submitted", null, sub({ play_url: null, watermarked: false, preview: "preparing", download_url: null }));
    render(<JobDrawer />);
    await waitFor(() => expect(screen.getByTestId("preview-note")).toBeTruthy());
    expect(screen.getByTestId("preview-note").textContent).toMatch(/putting a watermark on this file/);
    expect(screen.getByText("Preview being prepared")).toBeTruthy();
    expect(document.querySelector("video")).toBeNull();
    expect(screen.queryByText("Download the original")).toBeNull();
  });

  it("once paid plays the original and offers it as a download, with no watermark note", async () => {
    served = job("completed", "approved", sub({ play_url: "https://signed.test/orig.mp4", watermarked: false, preview: null, download_url: "https://signed.test/orig.mp4?download=zavi-job.mp4" }));
    render(<JobDrawer />);
    await waitFor(() => expect(screen.getByText("Download the original")).toBeTruthy());
    expect(screen.getByText("Download the original").closest("a")?.getAttribute("href")).toBe("https://signed.test/orig.mp4?download=zavi-job.mp4");
    expect(document.querySelector("video")?.getAttribute("src")).toBe("https://signed.test/orig.mp4");
    expect(screen.queryByTestId("preview-note")).toBeNull();
    const steps = screen.getByRole("list", { name: "Job progress" });
    expect(steps.textContent).toContain("Paid out");
    expect(steps.textContent).not.toMatch(/Paid(?! out)/);
    expect(steps.querySelector('[aria-current="step"]')?.parentElement?.textContent).toMatch(/Paid out/);
    const delivery = screen.getByRole("region", { name: "Delivery receipt" });
    expect(delivery.textContent).toMatch(/Version 1 · 1 file/);
    expect(delivery.textContent).toMatch(/Delivered /);
  });

  it("marks Paid out done only once the creator's payout has transferred", async () => {
    served = job("completed", "approved", sub({ play_url: "https://signed.test/orig.mp4", watermarked: false, preview: null, download_url: "https://signed.test/orig.mp4?download=zavi-job.mp4" }));
    served.job.money.payout_status = "transferred";
    render(<JobDrawer />);
    await waitFor(() => expect(screen.getByRole("list", { name: "Job progress" })).toBeTruthy());
    const steps = screen.getByRole("list", { name: "Job progress" });
    expect(steps.querySelector('[aria-current="step"]')).toBeNull();
    expect(steps.querySelectorAll("svg").length).toBe(4);
  });

  it("a file Zavi could not preview says so plainly, with no player and no original", async () => {
    served = job("submitted", null, sub({ play_url: null, watermarked: false, preview: "unavailable", download_url: null }));
    render(<JobDrawer />);
    await waitFor(() => expect(screen.getByTestId("preview-note")).toBeTruthy());
    expect(screen.getByTestId("preview-note").textContent).toMatch(/could not make a watermarked preview/);
    expect(screen.getByText("No preview for this file")).toBeTruthy();
    expect(document.querySelector("video")).toBeNull();
    expect(screen.queryByText("Download the original")).toBeNull();
  });
});

describe("a preview that finishes while the drawer is open", () => {
  it("shows the video on its own once Zavi has built it, then stops asking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      served = job("submitted", null, sub({ play_url: null, watermarked: false, preview: "preparing", download_url: null }));
      render(<JobDrawer />);
      await waitFor(() => expect(screen.getByText("Preview being prepared")).toBeTruthy());
      expect(document.querySelector("video")).toBeNull();

      served = job("submitted", null, sub({ play_url: "https://signed.test/preview/s1.mp4", watermarked: true, preview: "ready", download_url: null }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
      });
      await waitFor(() => expect(document.querySelector("video")?.getAttribute("src")).toBe("https://signed.test/preview/s1.mp4"));
      expect(screen.queryByText("Preview being prepared")).toBeNull();

      const reads = () => vi.mocked(callJson).mock.calls.filter(([path]) => path === "/api/humans/orders/o1").length;
      const before = reads();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 5);
      });
      expect(reads()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep re-reading a job whose preview is already there", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      served = job("submitted", null, sub({ play_url: "https://signed.test/preview/s1.mp4", watermarked: true, preview: "ready", download_url: null }));
      vi.mocked(callJson).mockClear();
      render(<JobDrawer />);
      await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS * 3);
      });
      expect(vi.mocked(callJson).mock.calls.filter(([path]) => path === "/api/humans/orders/o1").length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
