// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionsEmpty, type ChannelRunInfo } from "./ChannelEmptyStates";
import { ChannelChatProvider } from "../actions/channelChat";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }) }),
    }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: () => {},
  }),
}));

const RUN = "aaaaaaaa-1111-4111-8111-111111111111";
const run: ChannelRunInfo = { slug: "linkedin-ads", name: "LinkedIn Ads", switched: false, priorCount: 0, foldBelow: false, onRan: () => {} };
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const NOTE = [
  "I checked the account and found these gaps:",
  "",
  "- No conversion tracking is installed",
  "* The audience is under 300 people",
  "- <img src=x onerror=alert(1)> budget is unset",
  "",
  "Tell me which to fix first.",
].join("\n");

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("the last run note in the channel drawer", () => {
  it("renders dash and star lines as list items and never as one inline paragraph", async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url === "/api/channels") {
        return Promise.resolve(
          ok({ channels: [{ channel_slug: "linkedin-ads", run_reserve_credits: 160, last_run_id: RUN, last_run_at: "2026-10-19T09:00:00Z" }] }),
        );
      }
      if (url.endsWith(`/runs/${RUN}`)) {
        return Promise.resolve(ok({ status: "success", actions: [], summary: "I checked the account…", note: NOTE }));
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    render(
      <ChannelChatProvider open={() => {}}>
        <ActionsEmpty workState="delivered" lastRunAt="2026-10-19T09:00:00Z" run={run} />
      </ChannelChatProvider>,
    );
    const box = await screen.findByTestId("empty-run-said-text");
    expect(box.className).toContain("line-clamp-3");
    expect(box.querySelector("ul")).toBeNull();
    expect(box.querySelector("li")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(box.className).not.toContain("line-clamp-3");
    const items = Array.from(box.querySelectorAll("ul > li")).map((li) => li.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toBe("No conversion tracking is installed");
    expect(items[1]).toBe("The audience is under 300 people");
    expect(items[2]).toContain("budget is unset");
    for (const t of items) expect(t).not.toMatch(/^\s*[-*]\s/);
    expect(box.textContent).not.toMatch(/(^|\n)\s*- /);
    expect(box.querySelectorAll("p").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(box.className).toContain("line-clamp-3");
    expect(box.querySelector("ul")).toBeNull();
    expect(box.querySelector("img")).toBeNull();
    expect(box.innerHTML).not.toContain("onerror");
  });
});
