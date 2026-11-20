// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const posted = {
  id: "b-old",
  title: "Spring launch",
  angle: "A real morning",
  hook: "I did not expect this",
  format: "Vertical 9:16",
  posted_at: "2026-10-20T00:00:00Z",
  closed_at: null,
};
vi.mock("./useCards", () => ({
  callJson: vi.fn(async (path: string) => {
    if (path === "/api/humans/briefs/b-old/workbench") return { ok: true, data: { brief: posted, applicant_count: 0, creator_preview: { business_name: "Upcar" } } };
    if (path === "/api/humans/briefs/b-old/repost") return { ok: true, data: { brief: { id: "b-new" } } };
    if (path === "/api/humans/briefs/b-new/workbench")
      return { ok: true, data: { brief: { ...posted, id: "b-new", posted_at: null }, applicant_count: 0, creator_preview: { business_name: "Upcar" } } };
    return { ok: true, data: {} };
  }),
}));
vi.mock("./CreatorHiringCards", () => ({ loadBudgetHint: vi.fn(async () => null) }));

import { BriefDrawer } from "./BriefDrawer";
import { ChannelHumanLane } from "../layout/ChannelHumanLane";
import { notifyBriefsChanged } from "./hub";

const ugc = (CHANNELS as readonly Channel[]).find((c) => c.slug === "ugc")!;
const briefReads = () => apiFetch.mock.calls.filter(([p]) => p === "/api/humans/briefs").length;

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => ({
    ok: true,
    json: async () => (path === "/api/humans/briefs" ? { briefs: [] } : { jobs: [] }),
  }));
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=ugc&drawer=brief&brief=b-old");
});
afterEach(cleanup);

describe("Your creators stays current while the brief drawer is open", () => {
  it("re-reads the briefs after Close and repost, with the drawer still on a brief", async () => {
    render(
      <>
        <ChannelHumanLane channel={ugc} />
        <BriefDrawer />
      </>,
    );
    await waitFor(() => expect(briefReads()).toBe(1));
    fireEvent.click(await screen.findByRole("button", { name: "Close and repost" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Confirm repost" })).getByRole("button", { name: "Close and repost" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("brief")).toBe("b-new"));
    expect(new URLSearchParams(window.location.search).get("drawer")).toBe("brief");
    await waitFor(() => expect(briefReads()).toBe(2));
  });

  it("re-reads on every change signal, not only when a drawer opens or closes", async () => {
    render(<ChannelHumanLane channel={ugc} />);
    await waitFor(() => expect(briefReads()).toBe(1));
    act(() => notifyBriefsChanged());
    await waitFor(() => expect(briefReads()).toBe(2));
    act(() => notifyBriefsChanged());
    await waitFor(() => expect(briefReads()).toBe(3));
  });

  it("stops listening once the lane is gone", async () => {
    const { unmount } = render(<ChannelHumanLane channel={ugc} />);
    await waitFor(() => expect(briefReads()).toBe(1));
    unmount();
    act(() => notifyBriefsChanged());
    await new Promise((r) => setTimeout(r, 20));
    expect(briefReads()).toBe(1);
  });
});
