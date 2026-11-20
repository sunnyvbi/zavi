// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const api = vi.hoisted(() => ({ options: vi.fn(), create: vi.fn() }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  readBoostOptions: api.options,
  createBoostAd: api.create,
}));
const reconnect = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/components/workspace/settings/reconnectFlows", () => ({ startReconnectFlow: reconnect }));

import { BoostPostModal, count } from "../BoostPostModal";

const post = (id: string, likes: number, comments = 0, shares = 0) => ({ id, message: `post ${id}`, created_time: null, picture: null, permalink: null, likes, comments, shares });

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.options.mockReset().mockResolvedValue({
    eligible: true,
    pages: [{ id: "100", name: "Upcar" }],
    page_id: "100",
    posts: [post("100_1", 3), post("100_2", 4, 3, 1), post("100_3", 1)],
    posts_note: null,
    ad_sets: [{ id: "9", name: "Old", status: "PAUSED" }, { id: "8", name: "Traffic", status: "ACTIVE" }],
  });
  api.create.mockReset().mockResolvedValue({ ad_id: "ad-1", status: "PAUSED", ads_manager_url: "https://adsmanager.facebook.com/x" });
});
afterEach(() => cleanup());

describe("BoostPostModal", () => {
  it("preselects the most engaged post and creates the paused ad with the right body", async () => {
    const onChanged = vi.fn();
    render(<BoostPostModal channelName="Meta Ads" onClose={() => {}} onChanged={onChanged} />);
    await act(async () => {});
    expect(screen.getByRole("radio", { name: /post 100_2/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Most engagement")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create paused ad" }));
    });
    expect(api.create).toHaveBeenCalledWith({ page_id: "100", post_id: "100_2", ad_set_id: "8", request_id: expect.any(String) });
    expect(screen.getByText("Paused ad created. Turn it on in Meta Ads Manager.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in Ads Manager" }).getAttribute("href")).toBe("https://adsmanager.facebook.com/x");
    expect(onChanged).toHaveBeenCalled();
  });

  it("without Page access: says why and offers Reconnect Meta Ads", async () => {
    api.options.mockResolvedValue({ eligible: false, reason_code: "page_permission_missing", reason: "Meta did not give Zavi access to your Facebook Page." });
    render(<BoostPostModal channelName="Meta Ads" onClose={() => {}} onChanged={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/did not give Zavi access/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Meta Ads" }));
    expect(reconnect).toHaveBeenCalledWith("meta_ads");
  });
});

describe("count", () => {
  it("is singular for one and plural otherwise", () => {
    expect(count(1, "like")).toBe("1 like");
    expect(count(0, "comment")).toBe("0 comments");
    expect(count(3, "share")).toBe("3 shares");
  });
});
