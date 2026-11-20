// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) }));

import { TopActionsRow } from "../TopActionsRow";
import { ChannelPlanLockProvider } from "../../channelPlanLock";
import { meta_ads } from "../../platforms/meta_ads";
import { google_ads } from "../../platforms/google_ads";
import { youtube_ads } from "../../platforms/youtube_ads";
import { x_ads } from "../../platforms/x_ads";
import { ChannelHeaderRow } from "../../../layout/ChannelHeaderRow";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => cleanup());

describe("TopActionsRow", () => {
  it("Meta shows one Create menu with Create campaign and Boost a Page post", () => {
    render(<TopActionsRow slug="meta_ads" channelName="Meta Ads" actions={meta_ads.topActions} menu={meta_ads.createMenu} onChanged={() => {}} />);
    const create = screen.getByRole("button", { name: "Create" });
    expect(create.className).toContain("bg-ca-action");
    expect(screen.queryByRole("button", { name: "Create new ad" })).toBeNull();
    fireEvent.click(create);
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Create campaign", "Boost a Page post"]);
  });

  it("puts the Create menu beside the tabs", async () => {
    render(
      <ChannelHeaderRow left={<button type="button">Overview</button>} underline spaced>
        <div data-testid="lane">
          <TopActionsRow slug="meta_ads" channelName="Meta Ads" actions={meta_ads.topActions} menu={meta_ads.createMenu} onChanged={() => {}} />
        </div>
      </ChannelHeaderRow>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeTruthy());
    const action = screen.getByRole("button", { name: "Create" });
    expect(screen.getByTestId("channel-header").contains(action)).toBe(true);
    expect(screen.getByTestId("lane").contains(action)).toBe(false);
  });

  it("Meta's Create campaign asks for Zavi's Meta campaign editor", () => {
    const heard: unknown[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("zavi:meta-campaign-editor", on);
    render(<TopActionsRow slug="meta_ads" channelName="Meta Ads" actions={meta_ads.topActions} menu={meta_ads.createMenu} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create campaign" }));
    window.removeEventListener("zavi:meta-campaign-editor", on);
    expect(heard).toEqual(["new"]);
  });

  it("Meta's Boost a Page post opens the boost form", () => {
    render(<TopActionsRow slug="meta_ads" channelName="Meta Ads" actions={meta_ads.topActions} menu={meta_ads.createMenu} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Boost a Page post" }));
    expect(screen.getByRole("dialog", { name: "Boost a Page post" })).toBeTruthy();
  });

  it("X shows one Create menu whose two options each open their own form", () => {
    render(<TopActionsRow slug="x_ads" channelName="X Ads" actions={x_ads.topActions} menu={x_ads.createMenu} onChanged={() => {}} />);
    expect(screen.queryByRole("button", { name: "Promote a post" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Promote a post", "Create new ad"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Promote a post" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByLabelText("Posts")).toBeTruthy();
    cleanup();
    render(<TopActionsRow slug="x_ads" channelName="X Ads" actions={x_ads.topActions} menu={x_ads.createMenu} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create new ad" }));
    expect(screen.getByLabelText("What is the ad about?")).toBeTruthy();
  });

  it("Google's Create menu holds only Create campaign, which asks for Zavi's Google campaign editor", () => {
    const heard: unknown[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("zavi:google-campaign-editor", on);
    render(<TopActionsRow slug="google_ads" channelName="Google Ads" actions={google_ads.topActions} menu={google_ads.createMenu} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Create campaign"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Create campaign" }));
    window.removeEventListener("zavi:google-campaign-editor", on);
    expect(heard).toEqual(["new"]);
  });

  it("YouTube's Create campaign asks for the editor in YouTube mode", () => {
    const heard: unknown[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener("zavi:youtube-campaign-editor", on);
    render(<TopActionsRow slug="youtube_ads" channelName="YouTube Ads" actions={youtube_ads.topActions} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Create campaign" }));
    window.removeEventListener("zavi:youtube-campaign-editor", on);
    expect(heard).toEqual(["new"]);
  });

  it("locked: shows the tag and opens the upgrade, never the form", () => {
    const upgrade = vi.fn();
    render(
      <ChannelPlanLockProvider value={{ tierName: "Pro", upgrade }}>
        <TopActionsRow slug="meta_ads" channelName="Meta Ads" actions={meta_ads.topActions} onChanged={() => {}} />
      </ChannelPlanLockProvider>,
    );
    const btn = screen.getByTestId("top-action-boost_post");
    expect(btn.textContent).toContain("Pro");
    fireEvent.click(btn);
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders nothing for a channel with no top actions", () => {
    const { container } = render(<TopActionsRow slug="x" channelName="X" actions={undefined} onChanged={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
