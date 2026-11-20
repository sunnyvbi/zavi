// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

type Rows = Record<string, unknown[]>;

const flush = async (ticks = 16) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};

const respond = (ok: boolean, status: number, body: unknown) =>
  Promise.resolve({ ok, status, json: async () => body });

function stubApi(fields: Rows, suggest: { ok: boolean } = { ok: true }) {
  apiFetch.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "PUT") return respond(true, 200, {});
    if (init?.method === "POST") return respond(suggest.ok, suggest.ok ? 200 : 502, {});
    return respond(true, 200, { fields });
  });
}

type PutItem = { item: string } & Record<string, unknown>;

const puts = (): { path: string; items: PutItem[] }[] =>
  apiFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([path, init]) => ({
      path: String(path),
      items: (JSON.parse(String((init as RequestInit).body)) as { items: PutItem[] }).items,
    }));

const sectionFor = (label: string) =>
  screen.getByText(label, { selector: "h4" }).closest("section") as HTMLElement;

const mount = (slug: "reddit_organic") =>
  render(<ChannelSettingsTab slug={slug} fields={PLATFORMS[slug].settings ?? []} />);

const runSuggest = async () => {
  fireEvent.click(within(sectionFor("Keywords")).getByRole("button", { name: "Suggest" }));
  await flush();
};

const TRACKED = {
  id: "k1",
  item: "acme crm",
  item_type: "brand",
  status: "tracking",
  position: 0,
  note: "your own brand",
  detail: "acme.com",
  origin: "custom",
};

const STALE_SUGGESTION = {
  id: "k2",
  item: "best crm",
  item_type: "category",
  status: "suggested",
  position: 1,
  note: "Zavi found this in r/sales",
  detail: null,
  origin: "suggested",
};

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("a suggestion is only as fresh as the run that drew it", () => {
  it("does not print a stored suggestion on load, and prints the tracked row beside it", async () => {
    stubApi({ keywords: [TRACKED, STALE_SUGGESTION] });
    mount("reddit_organic");
    await flush();

    const section = sectionFor("Keywords");
    expect(within(section).getByText("acme crm")).toBeTruthy();
    expect(within(section).queryByText("best crm")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Track it" })).toBeNull();
    expect(within(section).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("prints it once a live run answers, with both of its verbs", async () => {
    stubApi({ keywords: [TRACKED, STALE_SUGGESTION] });
    mount("reddit_organic");
    await flush();
    await runSuggest();

    const section = sectionFor("Keywords");
    expect(within(section).getByText("best crm")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Track it" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("keeps a hidden suggestion OUT of the browser's state but IN the saved set", async () => {
    stubApi({ keywords: [TRACKED, STALE_SUGGESTION] });
    mount("reddit_organic");
    await flush();

    fireEvent.change(screen.getByLabelText("Type for acme crm"), {
      target: { value: "product" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    const sent = puts().find((p) => p.path.endsWith("/settings/keywords"));
    expect(sent?.items).toEqual([{ ...TRACKED, item_type: "product" }, STALE_SUGGESTION]);
  });

  it("stays hidden when the run is refused", async () => {
    stubApi({ keywords: [TRACKED, STALE_SUGGESTION] }, { ok: false });
    mount("reddit_organic");
    await flush();
    await runSuggest();

    const section = sectionFor("Keywords");
    expect(within(section).queryByText("best crm")).toBeNull();
    expect(screen.getByText(/couldn't draft suggestions/i)).toBeTruthy();
  });

  it("reveals every field the one run writes, not just the pressed one", async () => {
    stubApi({
      keywords: [STALE_SUGGESTION],
      competitors: [{ id: "c1", item: "Turo", detail: "turo.com", status: "suggested", origin: "suggested" }],
    });
    mount("reddit_organic");
    await flush();
    expect(within(sectionFor("Competitors")).queryByText("Turo")).toBeNull();

    await runSuggest();
    expect(within(sectionFor("Competitors")).getByText("Turo")).toBeTruthy();
  });

  it("still prints a suggestion on a field no run can refresh", async () => {
    stubApi({ communities: [{ id: "s1", item: "cars", status: "suggested", origin: "suggested" }] });
    mount("reddit_organic");
    await flush();

    const section = sectionFor("Communities");
    expect(within(section).queryByRole("button", { name: "Suggest" })).toBeNull();
    expect(within(section).getByText("cars")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Track it" })).toBeTruthy();
  });
});

describe("a long list scrolls inside its card", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `k${i}`,
      item: `keyword ${i}`,
      item_type: "brand",
      status: "tracking",
    }));

  const listWrap = (label: string) =>
    sectionFor(label).querySelector("ul")?.parentElement as HTMLElement;

  it("caps its height past eight rows", async () => {
    stubApi({ keywords: many(9) });
    mount("reddit_organic");
    await flush();

    expect(listWrap("Keywords").className).toContain("overflow-y-auto");
    expect(listWrap("Keywords").className).toContain("max-h-");
  });

  it("does not cap a short list", async () => {
    stubApi({ keywords: many(3) });
    mount("reddit_organic");
    await flush();

    expect(listWrap("Keywords").className).not.toContain("overflow-y-auto");
  });

  it("counts only what it prints, so hidden suggestions never trip the cap", async () => {
    stubApi({ keywords: [...many(3), ...Array.from({ length: 9 }, (_, i) => ({ ...STALE_SUGGESTION, id: `s${i}`, item: `suggested ${i}` }))] });
    mount("reddit_organic");
    await flush();

    expect(listWrap("Keywords").className).not.toContain("overflow-y-auto");
  });
});

describe("adding a term that is already there, hidden, as a suggestion", () => {
  it("sends a Reddit keyword to its own route once, never a PUT that would carry a duplicate", async () => {
    let server: Rows = { keywords: [TRACKED, STALE_SUGGESTION] };
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return respond(true, 200, {});
      if (init?.method === "POST" && path === "/api/reddit/workspace/keywords") {
        server = { keywords: [TRACKED, { ...STALE_SUGGESTION, status: "tracking" }] };
        return respond(true, 200, {});
      }
      return respond(true, 200, { fields: server });
    });
    mount("reddit_organic");
    await flush();

    const keywords = sectionFor("Keywords");
    expect(within(keywords).queryByText("best crm")).toBeNull();

    fireEvent.change(within(keywords).getByPlaceholderText(/Add to keywords/i), {
      target: { value: "  Best CRM " },
    });
    fireEvent.click(within(keywords).getByRole("button", { name: "Add" }));
    await flush();

    const posts = apiFetch.mock.calls.filter(([p, init]) => String(p) === "/api/reddit/workspace/keywords" && (init as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ term: "Best CRM" });
    expect(puts()).toHaveLength(0);
    expect(within(keywords).getAllByText("best crm")).toHaveLength(1);
    expect(within(keywords).getByText("Added.")).toBeTruthy();
  });

  it("tracks the existing hidden community instead of sending a duplicate the RPC will drop", async () => {
    const hidden = { ...STALE_SUGGESTION, id: "c1", item: "sales", item_type: null, note: null };
    stubApi({ communities: [hidden] });
    mount("reddit_organic");
    await flush();

    const communities = sectionFor("Communities");
    fireEvent.change(within(communities).getByPlaceholderText(/Add to communities/i), {
      target: { value: " Sales " },
    });
    fireEvent.click(within(communities).getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    const items = puts().at(-1)!.items;
    expect(items.filter((i) => i.item.toLowerCase() === "sales")).toEqual([expect.objectContaining({ item: "sales", status: "tracking", origin: "suggested" })]);
  });
});

describe("the empty state when every row is a hidden suggestion", () => {
  it("says the rows are hidden rather than claiming nothing is tracked", async () => {
    stubApi({ keywords: [STALE_SUGGESTION] });
    mount("reddit_organic");
    await flush();

    const keywords = sectionFor("Keywords");
    expect(within(keywords).queryByText(/Nothing tracked yet/i)).toBeNull();
    expect(within(keywords).getByText(/1 suggestion from an earlier run is hidden/i)).toBeTruthy();
  });
});

describe("Suggest never overwrites an unsaved edit", () => {
  it("keeps the edited field, leaves it unsaved, and fills only the untouched ones", async () => {
    let suggested = false;
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") return respond(true, 200, {});
      if (init?.method === "POST") {
        suggested = true;
        return respond(true, 200, {});
      }
      return respond(true, 200, {
        fields: suggested
          ? {
              keywords: [TRACKED, STALE_SUGGESTION],
              competitors: [{ id: "c1", item: "Turo", detail: "turo.com", status: "suggested", origin: "suggested" }],
            }
          : { keywords: [TRACKED] },
      });
    });
    mount("reddit_organic");
    await flush();

    fireEvent.change(screen.getByLabelText("Type for acme crm"), { target: { value: "product" } });
    await runSuggest();

    expect((screen.getByLabelText("Type for acme crm") as HTMLSelectElement).value).toBe("product");
    expect(within(sectionFor("Keywords")).queryByText("best crm")).toBeNull();
    expect(within(sectionFor("Competitors")).getByText("Turo")).toBeTruthy();
    expect(screen.getByText(/fields you haven't changed/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();
    const sent = puts().find((p) => p.path.endsWith("/settings/keywords"));
    expect(sent?.items).toEqual([{ ...TRACKED, item_type: "product" }, STALE_SUGGESTION]);
  });
});
