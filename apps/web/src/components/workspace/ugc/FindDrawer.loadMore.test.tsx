// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Paging = { members?: boolean; invites?: boolean; invitesFailed?: boolean; total?: number | null };
type Search = { data: unknown; loading: boolean; error: string | null; notBuilt: boolean; sessionExpired: boolean };

const h = vi.hoisted(() => ({
  byPath: {} as Record<string, unknown>,
  first: null as unknown,
  state: {} as Partial<{ loading: boolean; error: string | null; notBuilt: boolean; sessionExpired: boolean }>,
  apiFetch: vi.fn(),
  gone: [] as string[],
}));

function person(id: string, invited = false) {
  return { human_member_id: id, display_name: `Creator ${id}`, lanes: [], niches: [], packages: [], location: { city: null }, handles: [], invited, status_label: invited ? "Not on Zavi yet" : undefined };
}
function page(creators: unknown[], invited: unknown[], p: Paging = {}) {
  return {
    creators,
    invited,
    count: creators.length,
    page: { limit: 100, offset: 0, has_more: !!p.members },
    invited_page: { limit: 100, offset: 0, has_more: !!p.invites, ...(p.invitesFailed ? { failed: true } : {}) },
    invited_total: p.total ?? null,
  };
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

vi.mock("@/components/humans/useHumanResource", () => ({
  useHumanResource: (path: string): Search => ({
    data: path in h.byPath ? h.byPath[path] : h.first,
    loading: false,
    error: null,
    notBuilt: false,
    sessionExpired: false,
    ...h.state,
  }),
}));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));
vi.mock("./useCards", () => ({
  primeCreatorCards: () => undefined,
  useCreatorCards: (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, h.gone.includes(id) ? null : { human_member_id: id, display_name: `Creator ${id}` }])),
}));
vi.mock("./unread", () => ({ useCreatorUnread: () => ({}) }));
vi.mock("./FindFilters", async (orig) => ({
  ...(await orig<typeof import("./FindFilters")>()),
  FindFilterBar: ({ value, onChange, scanned, shown }: { value: object; onChange: (v: object) => void; scanned: number | null; shown: number }) => (
    <div>
      <p data-testid="count">{shown}</p>
      <button type="button" onClick={() => onChange({ ...value, platform: "x" })}>other search</button>
      <span data-testid="scanned">{scanned === null ? "all" : String(scanned)}</span>
    </div>
  ),
}));
vi.mock("./ui", async (orig) => ({
  ...(await orig<typeof import("./ui")>()),
  CreatorCard: ({ creator }: { creator: { display_name: string } }) => <div data-testid="card">{creator.display_name}</div>,
}));

import { FindDrawer, firstCursor, nextCursor } from "./FindDrawer";

const names = () => screen.queryAllByTestId("card").map((c) => c.textContent);
const loadMoreButton = () => screen.queryByRole("button", { name: /Load more creators|Loading…/ });
const lastUrl = () => String(h.apiFetch.mock.calls[h.apiFetch.mock.calls.length - 1][0]);

beforeEach(() => {
  h.apiFetch.mockReset();
  h.byPath = {};
  h.state = {};
  h.gone = [];
  window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=find");
});
afterEach(cleanup);

describe("FindDrawer load more", () => {
  it("says the whole search's total, not just the loaded cards", () => {
    h.first = page([person("m1"), person("m2")], [person("invite:a", true)], { invites: true, total: 950 });
    render(<FindDrawer />);
    expect(screen.getByTestId("count").textContent).toBe("952");
  });

  it("falls back to the cards shown when the total is unknown", () => {
    h.first = page([person("m1")], [person("invite:a", true)], { total: null });
    render(<FindDrawer />);
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("adds the next page after the first, and hides the button on the last page", async () => {
    h.first = page([person("m1")], [person("invite:a", true), person("invite:b", true)], { invites: true });
    h.apiFetch.mockResolvedValue(ok(page([], [person("invite:c", true)])));
    render(<FindDrawer />);
    expect(names()).toEqual(["Creator m1", "Creator invite:a", "Creator invite:b"]);

    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    await waitFor(() => expect(screen.getAllByTestId("card")).toHaveLength(4));
    expect(lastUrl()).toMatch(/[?&]limit=100.*&offset=100&invited_offset=100$/);
    expect(screen.getAllByTestId("card")[3].textContent).toBe("Creator invite:c");
    expect(loadMoreButton()).toBeNull();
  });

  it("next-page members go after the invites already shown, never above them", async () => {
    h.first = page([person("m1")], [person("invite:a", true)], { members: true });
    h.apiFetch.mockResolvedValue(ok(page([person("m2")], [])));
    render(<FindDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    await waitFor(() => expect(screen.getAllByTestId("card")).toHaveLength(3));
    expect(names()).toEqual(["Creator m1", "Creator invite:a", "Creator m2"]);
  });

  it("pages members on page.has_more alone (no invites at all)", async () => {
    h.first = page([person("m1")], [], { members: true });
    h.apiFetch.mockResolvedValue(ok(page([person("m2")], [])));
    render(<FindDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    await waitFor(() => expect(names()).toEqual(["Creator m1", "Creator m2"]));
    expect(loadMoreButton()).toBeNull();
  });

  it("with more to load, shows only full rows; the rest come first after Load more", async () => {
    const invites = Array.from({ length: 13 }, (_, i) => person(`invite:${i}`, true));
    h.first = page([person("m1")], invites, { invites: true });
    h.apiFetch.mockResolvedValue(ok(page([], [person("invite:x", true)])));
    render(<FindDrawer />);
    expect(screen.getAllByTestId("card")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    await waitFor(() => expect(screen.getAllByTestId("card")).toHaveLength(15));
    expect(screen.getAllByTestId("card").map((c) => c.textContent).slice(12)).toEqual(["Creator invite:11", "Creator invite:12", "Creator invite:x"]);
  });

  it("an empty card does not leave a hole in a full row", () => {
    const invites = Array.from({ length: 14 }, (_, i) => person(`invite:${i}`, true));
    h.first = page([], invites, { invites: true });
    h.gone = ["invite:3", "invite:7"];
    render(<FindDrawer />);
    const names = screen.getAllByTestId("card").map((c) => c.textContent);
    expect(names).toHaveLength(12);
    expect(names).not.toContain("Creator invite:3");
  });

  it("shows no button when the first page is everything", () => {
    h.first = page([person("m1")], [person("invite:a", true)]);
    render(<FindDrawer />);
    expect(loadMoreButton()).toBeNull();
  });

  it("a failed page keeps the cards, offers a retry, and the retry asks for the SAME page", async () => {
    h.first = page([], [person("invite:a", true)], { invites: true });
    h.apiFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    render(<FindDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    expect(await screen.findByText(/Couldn.t load more creators/)).toBeTruthy();
    expect(screen.getAllByTestId("card")).toHaveLength(1);
    const failedUrl = lastUrl();

    h.apiFetch.mockResolvedValueOnce(ok(page([], [person("invite:b", true)])));
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    await waitFor(() => expect(names()).toEqual(["Creator invite:a", "Creator invite:b"]));
    expect(lastUrl()).toBe(failedUrl);
  });

  it("a card repeated on the next page shows once", async () => {
    h.first = page([person("m1"), person("m2")], [], { members: true });
    h.apiFetch.mockResolvedValue(ok(page([person("m2"), person("m3")], [])));
    render(<FindDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    await waitFor(() => expect(names()).toEqual(["Creator m1", "Creator m2", "Creator m3"]));
  });

  it("a failed invite page is asked for again, not skipped, while members move on", async () => {
    h.first = page([person("m1")], [person("invite:a", true)], { members: true, invites: true });
    h.apiFetch.mockResolvedValueOnce(ok(page([person("m2")], [], { members: true, invitesFailed: true })));
    render(<FindDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    await waitFor(() => expect(names()).toContain("Creator m2"));
    expect(screen.getByText(/Some invited creators couldn.t load/)).toBeTruthy();

    h.apiFetch.mockResolvedValueOnce(ok(page([person("m3")], [person("invite:b", true)])));
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    await waitFor(() => expect(names()).toContain("Creator invite:b"));
    expect(lastUrl()).toMatch(/&offset=200&invited_offset=100$/);
    expect(screen.queryByText(/Some invited creators couldn.t load/)).toBeNull();
  });

  it("a failed FIRST invite read is retried from 0, even when members are done", async () => {
    h.first = page([person("m1")], [], { invitesFailed: true });
    h.apiFetch.mockResolvedValueOnce(ok(page([], [person("invite:a", true)])));
    render(<FindDrawer />);
    expect(screen.getByText(/Some invited creators couldn.t load/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    await waitFor(() => expect(names()).toEqual(["Creator m1", "Creator invite:a"]));
    expect(lastUrl()).toMatch(/&invited_offset=0$/);
  });

  it("a hung page of an earlier search never leaves the new search's button on Loading", async () => {
    h.first = page([person("m1")], [], { members: true });
    let resolveOld: (v: unknown) => void = () => {};
    h.apiFetch.mockReturnValueOnce(new Promise((r) => (resolveOld = r)));
    render(<FindDrawer />);
    fireEvent.click(screen.getByRole("button", { name: "Load more creators" }));
    expect(screen.getByRole("button", { name: "Loading…" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "other search" }));
    const other = screen.getByRole("button", { name: "Load more creators" }) as HTMLButtonElement;
    expect(other.disabled).toBe(false);

    await act(async () => resolveOld(ok(page([person("old")], []))));
    expect(names()).not.toContain("Creator old");
  });

  it("offers no Load more when the session expired or the search is not built", () => {
    h.first = page([person("m1")], [], { members: true });
    h.state = { sessionExpired: true };
    render(<FindDrawer />);
    expect(loadMoreButton()).toBeNull();
    cleanup();
    h.state = { notBuilt: true };
    render(<FindDrawer />);
    expect(loadMoreButton()).toBeNull();
  });

  it("a keyword over a partial list says so, instead of 'no creators match'", () => {
    window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=find&keyword=zzz");
    h.first = page([person("m1")], [], { members: true });
    render(<FindDrawer />);
    expect(screen.queryByText("No creators match these filters.")).toBeNull();
    expect(screen.getByText(/No match in the first 1 creators/)).toBeTruthy();
    expect(screen.getByTestId("scanned").textContent).toBe("1");
    expect(loadMoreButton()).toBeTruthy();
  });

  it("a keyword over the whole list keeps the plain empty state and count", () => {
    window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=find&keyword=zzz");
    h.first = page([person("m1")], []);
    render(<FindDrawer />);
    expect(screen.getByText("No creators match these filters.")).toBeTruthy();
    expect(screen.getByTestId("scanned").textContent).toBe("all");
  });
});

describe("cursor", () => {
  it("stops at the route's deepest offset instead of asking for one it refuses", () => {
    const cur = { memberNext: 10_000, membersMore: true, inviteNext: 10_000, invitesMore: true, invitesFailed: false };
    const { cursor } = nextCursor(cur, page([person("m")], [person("i", true)], { members: true, invites: true }) as never);
    expect(cursor.membersMore).toBe(false);
    expect(cursor.invitesMore).toBe(false);
  });

  it("ignores a side that had no more pages", () => {
    const cur = { ...firstCursor(page([], [], { invites: true }) as never) };
    const { creators, cursor } = nextCursor(cur, page([person("stray")], [], {}) as never);
    expect(creators).toEqual([]);
    expect(cursor.memberNext).toBe(100);
  });
});
