// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { ActionsEmpty, type ChannelRunInfo } from "./ChannelEmptyStates";
import { ChannelChatProvider } from "../actions/channelChat";
import type { ChannelDetail } from "./channelDetail";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }) }) }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
  }),
}));

const run: ChannelRunInfo = { slug: "linkedin_ads", name: "LinkedIn Ads", switched: false, priorCount: 0, foldBelow: false, onRan: () => {} };

async function mount(workState: ChannelDetail["workState"]) {
  const r = render(
    <ChannelChatProvider open={() => {}}>
      <ActionsEmpty workState={workState} lastRunAt={new Date().toISOString()} run={run} />
    </ChannelChatProvider>,
  );
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
  return r;
}

const shell = (el: HTMLElement) => ({ tag: el.tagName, classes: el.className.split(/\s+/).sort(), icon: !!el.querySelector('img[src="/zavi-icon.svg"]') });

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => (String(url).includes("/runs") ? { runs: [] } : { channels: [] }) }));
});
afterEach(cleanup);

describe("the running state", () => {
  it("draws the cooking card with the Zavi icon, the title, a Cooking badge and no buttons", async () => {
    await mount("running");
    const card = screen.getByTestId("empty-running");
    expect(card.querySelector('img[src="/zavi-icon.svg"]')).toBeTruthy();
    expect(within(card).getByText("Cooking up new suggestions for LinkedIn Ads")).toBeTruthy();
    expect(within(card).getByTestId("running-badge").textContent).toBe("Cooking");
    expect(card.textContent).toContain("Usually a few minutes. You can leave this page; they'll be waiting here.");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  });
});
