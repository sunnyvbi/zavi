import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PlatformSpec } from "../types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: vi.fn() }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("../platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "../ChannelActionsLane";
import { linkedin_ads } from "../platforms/linkedin_ads";
import { meta_ads } from "../platforms/meta_ads";
import { FIXTURES } from "./fixtures";

const headed = { ...linkedin_ads, topActionsInHeading: true, createMenu: undefined } as PlatformSpec;

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function lane(slug: string, surfaceOff = false) {
  return render(
    <ChannelActionsLane slug={slug} legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={1} connected hasConnectors surfaceOff={surfaceOff}>
      <li>prior row</li>
    </ChannelActionsLane>,
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => {
    if (url.includes("/actions")) return ok({ actions: [FIXTURES.other], more: 0, store: "channel_actions" });
    return ok({});
  });
});
afterEach(cleanup);

describe("LinkedIn Boost a Page post sits in the snapshot heading row", () => {
  it("renders inside the heading row, after the heading, and not under the campaigns", async () => {
    spec.current = headed;
    lane("linkedin_ads");
    const boost = (await screen.findAllByTestId("top-action-boost_post"))[0];
    const heading = await screen.findByRole("heading", { name: "How the account is doing" });
    const row = heading.parentElement as HTMLElement;
    expect(row.contains(boost)).toBe(true);
    expect(row.className).toContain("flex-wrap");
    expect(boost.closest('[data-section="snapshot"]')).not.toBeNull();
    expect(heading.compareDocumentPosition(boost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("channel-top-actions").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTestId("channel-top-actions")[0].className).toContain("ml-auto");
  });

  it("still opens the same Boost flow", async () => {
    spec.current = headed;
    lane("linkedin_ads");
    fireEvent.click((await screen.findAllByTestId("top-action-boost_post"))[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Prepare the campaign" })).toBeTruthy();
  });

  it("is not drawn at all while the channel surface is off", async () => {
    spec.current = headed;
    lane("linkedin_ads", true);
    expect((await screen.findAllByText("Ask three recent customers for a quote")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("top-action-boost_post")).toBeNull();
  });

  it("leaves another channel's Create menu below the snapshot, with no Boost in the heading row", async () => {
    spec.current = { ...meta_ads, topActions: meta_ads.topActions } as PlatformSpec;
    lane("meta_ads");
    const create = (await screen.findAllByTestId("channel-create-menu"))[0];
    const heading = await screen.findByRole("heading", { name: "How the account is doing" });
    expect((heading.parentElement as HTMLElement).contains(create)).toBe(false);
    expect(create.closest('[data-section="snapshot"]')).toBeNull();
    expect(screen.getAllByTestId("channel-top-actions")[0].className).not.toContain("ml-auto");
  });
});
