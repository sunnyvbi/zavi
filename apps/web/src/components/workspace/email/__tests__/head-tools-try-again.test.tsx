// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { askTopActionAgain } from "../../actions/topActions/api";
import { ChannelPlanLockProvider } from "../../actions/channelPlanLock";

vi.mock("../NewCampaignDialog", () => ({
  NEW_CAMPAIGN_KEY: "new_email",
  newCampaignSession: () => ({ runId: "r", lastAsk: null, planId: "p", planPending: null }),
  NewCampaignDialog: ({ slug }: { slug: string }) => <div data-testid="new-campaign-open">{slug}</div>,
}));

import { EmailHeadTools } from "../EmailHeadTools";

afterEach(cleanup);

describe("New email button", () => {
  it("is the filled card button and opens the builder", () => {
    render(<EmailHeadTools slug="email_marketing" channelName="Email campaigns" />);
    const button = screen.getByRole("button", { name: "New email" });
    expect(button.className.split(/\s+/)).toContain("bg-ca-action");
    act(() => button.click());
    expect(screen.getByTestId("new-campaign-open").textContent).toBe("email_marketing");
  });
});

describe("Try again on a Write it that filed nothing", () => {
  it("opens New campaign for this channel's own new_email only", () => {
    render(<EmailHeadTools slug="email_marketing" channelName="Email campaigns" />);
    expect(screen.queryByTestId("new-campaign-open")).toBeNull();
    act(() => askTopActionAgain("sms", "new_email"));
    act(() => askTopActionAgain("email_marketing", "something_else"));
    expect(screen.queryByTestId("new-campaign-open")).toBeNull();
    act(() => askTopActionAgain("email_marketing", "new_email"));
    expect(screen.getByTestId("new-campaign-open").textContent).toBe("email_marketing");
  });

  it("under a plan lock opens the upgrade path instead of doing nothing, and never opens the dialog", () => {
    const upgrade = vi.fn();
    render(
      <ChannelPlanLockProvider value={{ tierName: "Pro", upgrade }}>
        <EmailHeadTools slug="email_marketing" channelName="Email campaigns" />
      </ChannelPlanLockProvider>,
    );
    act(() => askTopActionAgain("sms", "new_email"));
    expect(upgrade).not.toHaveBeenCalled();
    act(() => askTopActionAgain("email_marketing", "new_email"));
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("new-campaign-open")).toBeNull();
  });
});
