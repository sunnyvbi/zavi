// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "../types";

const h = vi.hoisted(() => ({ fetch: vi.fn(), role: "owner" as string | null, review: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: h.fetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: vi.fn() }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: h.role, tabs: [], activeTabId: null }) }));
vi.mock("../managed-campaigns/campaignReviewRequest", async (orig) => ({
  ...(await orig<typeof import("../managed-campaigns/campaignReviewRequest")>()),
  requestCampaignReview: h.review,
}));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("../platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelPlanLockProvider } from "../channelPlanLock";
import { NewCampaignButton } from "../linkedin-ads/NewCampaignButton";
import { LAUNCH_LOCK_ID } from "../managed-campaigns/launchLock";
import { linkedin_ads } from "../platforms/linkedin_ads";
import { FIXTURES } from "./fixtures";

const DRAFTS = "/api/channels/linkedin_ads/campaign-drafts";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const draftPosts = () => h.fetch.mock.calls.filter(([u, o]) => String(u) === DRAFTS && (o as RequestInit)?.method === "POST");

function campaignButton(lock: { tierName: string | null; upgrade: () => void } | null = null) {
  const tree = <NewCampaignButton />;
  return render(lock ? <ChannelPlanLockProvider value={lock}>{tree}</ChannelPlanLockProvider> : tree);
}

let draft: (res: unknown) => void = () => {};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  h.fetch.mockReset();
  h.review.mockReset();
  h.role = "owner";
  spec.current = linkedin_ads;
  h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (String(url) === DRAFTS && options?.method === "POST") return new Promise((resolve) => { draft = resolve; });
    if (String(url).includes("/actions")) return ok({ actions: [FIXTURES.other], more: 0, store: "channel_actions" });
    return ok({});
  });
});
afterEach(cleanup);

describe("LinkedIn Ads Create campaign", () => {
  it("an owner sees the create campaign button", async () => {
    campaignButton();
    expect((await screen.findByTestId("top-action-new_campaign")).textContent).toBe("Create campaign");
  });

  it("an admin sees it too and a member does not", async () => {
    h.role = "admin";
    campaignButton();
    await screen.findByTestId("top-action-new_campaign");
    cleanup();
    h.role = "member";
    campaignButton();
    expect(screen.queryByTestId("top-action-new_campaign")).toBeNull();
  });

  it("a double click posts one draft, says Starting…, then hands the action id to the review", async () => {
    campaignButton();
    const button = await screen.findByTestId("top-action-new_campaign");
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(draftPosts()).toHaveLength(1);
    expect(draftPosts()[0][1]).toMatchObject({ method: "POST", body: "{}" });
    expect(button.textContent).toBe("Starting…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      draft(ok({ action_id: "act-77" }));
    });
    await waitFor(() => expect(h.review).toHaveBeenCalledWith("act-77"));
    expect(h.review).toHaveBeenCalledTimes(1);
    expect(draftPosts()).toHaveLength(1);
    expect(button.textContent).toBe("Create campaign");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a refused draft shows the server's words beside the button and does not open the review", async () => {
    campaignButton();
    const button = await screen.findByTestId("top-action-new_campaign");
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      draft({ ok: false, status: 409, json: async () => ({ error: { code: "no_account", message: "Pick a LinkedIn ad account first." } }) });
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Pick a LinkedIn ad account first.");
    expect(button.getAttribute("aria-describedby")).toBe(alert.id);
    expect(h.review).not.toHaveBeenCalled();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(draftPosts()).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a read failure with no words falls back to the plain sentence", async () => {
    campaignButton();
    const button = await screen.findByTestId("top-action-new_campaign");
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      draft({ ok: true, status: 200, json: async () => { throw new Error(""); } });
    });
    expect((await screen.findByRole("alert")).textContent).toBe("The server response could not be read. Refresh before retrying.");
    cleanup();
    h.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (String(url) === DRAFTS && options?.method === "POST") throw new Error("");
      if (String(url).includes("/actions")) return ok({ actions: [FIXTURES.other], more: 0, store: "channel_actions" });
      return ok({});
    });
    campaignButton();
    const again = await screen.findByTestId("top-action-new_campaign");
    await act(async () => {
      fireEvent.click(again);
    });
    expect((await screen.findByRole("alert")).textContent).toBe("Zavi could not start a campaign. Try again.");
  });

  it("the plan lock disables it, points at the lock words and never posts", async () => {
    const upgrade = vi.fn();
    campaignButton({ tierName: "Starter", upgrade });
    const button = await screen.findByTestId("top-action-new_campaign");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(LAUNCH_LOCK_ID);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(draftPosts()).toHaveLength(0);
    expect(h.review).not.toHaveBeenCalled();
  });
});
