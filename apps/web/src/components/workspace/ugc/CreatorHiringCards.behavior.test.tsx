// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ api: vi.fn(), chat: vi.fn(), failed: new Set<string>(), briefs: [] as unknown[], tenant: "t-acme" as string | null, hydrating: 0 }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => { if (state.hydrating > 0) { state.hydrating -= 1; return null; } return state.tenant; } }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/api", () => ({ apiFetch: state.api }));
vi.mock("@/components/humans/CreatorLibraryIsland", () => ({ downloadLibraryVideo: vi.fn(), MetaPanel: () => null, YoutubePanel: () => null }));
vi.mock("./useCards", () => ({ useCreatorCards: () => ({}) }));
import { ChannelChatProvider } from "../actions/channelChat";
import { useCreatorHiringCards } from "./CreatorHiringCards";
import { CREATOR_HIDDEN_KEY, creatorDismissalsKey } from "./creatorCardDismissals";

const starter = "instagram_organic-get-creator-video";
const packageData = { kind: "ugc_video", title: "1 UGC video, 30s", price_cents: 25000, video_count: 1, video_length_seconds: 30, ad_rights_days: 90 };
function Harness({ slug = "instagram_organic" }: { slug?: string }) {
  const result = useCreatorHiringCards(slug);
  return <ChannelChatProvider open={state.chat}>{result.notice && <p role="alert">{result.notice}</p>}{result.cards}{result.more}</ChannelChatProvider>;
}
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=instagram_organic");
  state.failed.clear(); state.briefs = []; state.chat.mockReset(); state.tenant = "t-acme"; state.hydrating = 0;
  state.api.mockReset().mockImplementation(async (path: string) => {
    if (state.failed.has(path)) return { ok: false, status: 503 };
    const body = path === "/api/humans/briefs" ? { briefs: state.briefs }
      : path === "/api/creators/library" ? { assets: [] }
      : path.includes("/search?") ? { creators: [
        { human_member_id: "unavailable", display_name: "Unavailable Creator", bookable: true, from_price_cents: 10000, packages: [] },
        { human_member_id: "meri", display_name: "Meri", bookable: true, from_price_cents: 25000, packages: [{ ...packageData, pricing: { price_cents: 25000 } }] },
      ] }
      : path.includes("/unavailable/") ? { creator: { packages: [] } }
      : { creator: { packages: [packageData] } };
    return { ok: true, json: async () => body };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const ready = () => screen.findByRole("button", { name: "Create video brief" });

describe("creator video suggestion controls", () => {
  it("opens the brief editor without saving, hiring or charging", async () => {
    render(<Harness />);
    fireEvent.click(await ready());
    expect(window.location.search).toContain("channel=ugc");
    expect(window.location.search).toContain("drawer=brief");
    expect(window.location.search).toContain("from=instagram_organic");
    expect(state.api.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
    expect(state.chat).not.toHaveBeenCalled();
  });

  it("shows the brief's spec rows and no 'Not supplied' cost or source rows", async () => {
    render(<Harness />); await ready();
    expect(screen.queryByText("Not supplied")).toBeNull();
    expect(screen.queryByTestId("action-cost")).toBeNull();
    expect(screen.getByText("Format")).toBeTruthy();
    expect(screen.getByText("Ad rights")).toBeTruthy();
  });

  it("Close leaves a closed row whose Undo brings the card back", async () => {
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole("button", { name: /^Close “Create a video brief/ }));
    expect(screen.getByTestId("card-closed").textContent).toContain("Closed");
    expect(screen.queryByRole("button", { name: "Create video brief" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Create video brief" })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(creatorDismissalsKey("t-acme"))!)).toEqual([]);
  });

  it("Not now shows the status with Undo, and Undo restores the card", async () => {
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByRole("status").textContent).toBe("Not now");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Create video brief" })).toBeTruthy();
  });

  it("prefills Ask Zavi with placement, rights and price provenance but never sends", async () => {
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Ask Zavi" }));
    const pin = state.chat.mock.calls[0][0];
    expect(pin.target).toBe("channel");
    expect(pin.draft.autoSend).toBeUndefined();
    for (const detail of ["Instagram", "Vertical 9:16, 30 seconds", "90 days", "$250", "Meri", "1 UGC video, 30s", "10% fee", "My question:"]) expect(pin.draft.text).toContain(detail);
    expect(pin.draft.text).toContain("No creator has been selected or invited");
  });

  it("Not now hides for fourteen days, removes duplicate Hide, and returns without a reload", async () => {
    render(<Harness />); await ready();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("button", { name: "Create video brief" })).toBeNull();
    const saved = JSON.parse(window.localStorage.getItem(creatorDismissalsKey("t-acme"))!);
    expect(window.localStorage.getItem(CREATOR_HIDDEN_KEY)).toBeNull();
    expect(saved).toEqual([{ id: starter, until: Date.now() + 14 * 86_400_000 }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(14 * 86_400_000); });
    expect(screen.getByRole("button", { name: "Create video brief" })).toBeTruthy();
    expect(state.api.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });

  it("restores cards hidden forever by an old Reject", async () => {
    window.localStorage.setItem(CREATOR_HIDDEN_KEY, JSON.stringify([starter]));
    render(<Harness />);
    expect(await ready()).toBeTruthy();
  });

  it("retains a supported estimate if another creator's packages fail to load", async () => {
    state.failed.add("/api/humans/creators/unavailable/card");
    render(<Harness />); await ready();
    expect(screen.getByText("Around $250 per video, plus 10% fee")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "What it is" }));
    expect(screen.getByText(/Example from the packages checked/).textContent).toContain("Meri");
  });

  it.each(["/api/humans/briefs", "/api/creators/library"])("shows a read failure instead of pretending there are no cards: %s", async path => {
    state.failed.add(path);
    render(<Harness />);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load");
    expect(screen.queryByRole("button", { name: "Create video brief" })).toBeNull();
  });

  it("loads cards again when switching between video channels", async () => {
    const { rerender } = render(<Harness />); await ready();
    state.api.mockClear();
    rerender(<Harness slug="youtube_organic" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create video brief" })).toBeTruthy());
    expect(state.api).toHaveBeenCalledWith("/api/humans/briefs");
    expect(screen.getByRole("heading", { name: /Create a video brief for/ }).textContent).toContain("YouTube");
  });

  it("a card hidden in one company stays visible in another company on the same browser", async () => {
    const first = render(<Harness />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("button", { name: "Create video brief" })).toBeNull();
    first.unmount();

    state.tenant = "t-lumen";
    const other = render(<Harness />);
    expect(await ready()).toBeTruthy();
    expect(window.localStorage.getItem(creatorDismissalsKey("t-lumen"))).toBeNull();
    other.unmount();

    state.tenant = "t-acme";
    render(<Harness />);
    await waitFor(() => expect(state.api).toHaveBeenCalledWith("/api/humans/briefs"));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(screen.queryByRole("button", { name: "Create video brief" })).toBeNull();
  });

  it("a card hidden earlier stays hidden when the session is still loading on first paint", async () => {
    const until = Date.now() + 5 * 86_400_000;
    window.localStorage.setItem(creatorDismissalsKey("t-acme"), JSON.stringify([{ id: starter, until }]));
    state.hydrating = 1;
    render(<Harness />);
    await waitFor(() => expect(state.api).toHaveBeenCalledWith("/api/humans/briefs"));
    await act(async () => { await new Promise(r => setTimeout(r, 400)); });
    expect(state.hydrating).toBe(0);
    expect(screen.queryByRole("button", { name: "Create video brief" })).toBeNull();
  });

  it("two open tabs each hiding a card keep both dismissals, not the last tab's mount-time copy", async () => {
    const ig = render(<Harness slug="instagram_organic" />);
    const yt = render(<Harness slug="youtube_organic" />);
    await within(ig.container).findByRole("button", { name: "Create video brief" });
    await within(yt.container).findByRole("button", { name: "Create video brief" });
    fireEvent.click(within(ig.container).getByRole("button", { name: "Not now" }));
    fireEvent.click(within(yt.container).getByRole("button", { name: "Not now" }));
    const saved = JSON.parse(window.localStorage.getItem(creatorDismissalsKey("t-acme"))!) as Array<{ id: string }>;
    expect(saved.map(e => e.id).sort()).toEqual(["instagram_organic-get-creator-video", "youtube_organic-get-creator-video"]);
  });

  it("adopts dismissals saved under the old shared key into the first company that loads them, once", async () => {
    const until = Date.now() + 5 * 86_400_000;
    window.localStorage.setItem(CREATOR_HIDDEN_KEY, JSON.stringify([{ id: starter, until }]));
    render(<Harness />);
    await waitFor(() => expect(window.localStorage.getItem(CREATOR_HIDDEN_KEY)).toBeNull());
    expect(JSON.parse(window.localStorage.getItem(creatorDismissalsKey("t-acme"))!)).toEqual([{ id: starter, until }]);
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(screen.queryByRole("button", { name: "Create video brief" })).toBeNull();
  });

  it("hides the card for this page even when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<Harness />); await ready();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("button", { name: "Create video brief" })).toBeNull();
  });
});

describe("creator cards on paid video channels", () => {
  it.each(["meta_ads", "tiktok_ads", "youtube_ads"])("%s draws the brief card with its spec rows and Create video brief last", async (slug) => {
    render(<Harness slug={slug} />);
    await ready();
    const card = screen.getByTestId(`action-${slug}-get-creator-video`);
    expect(card.textContent).toContain("Format");
    const buttons = within(card).getAllByRole("button").map((b) => b.textContent);
    expect(buttons[buttons.length - 1]).toBe("Create video brief");
  });
});

describe("creator cards when the founder comes back to the tab", () => {
  it("re-read the briefs and jobs on focus, so a creator's new ask shows without a reload", async () => {
    render(<Harness />);
    await ready();
    const reads = () => state.api.mock.calls.filter(([p]) => p === "/api/humans/briefs").length;
    const before = reads();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(reads()).toBe(before + 1));
  });
});

