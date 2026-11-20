// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelSettingsTab } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const flush = async (ticks = 16) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};

const respond = (ok: boolean, body: unknown) =>
  Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => body });

function stubApi(fields: Record<string, unknown[]>) {
  apiFetch.mockImplementation((_path: string, init?: RequestInit) =>
    init?.method === "PUT" ? respond(true, {}) : respond(true, { fields }),
  );
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

const mountReddit = async (fields: Record<string, unknown[]>) => {
  stubApi(fields);
  render(<ChannelSettingsTab slug="reddit_organic" fields={PLATFORMS.reddit_organic.settings ?? []} />);
  await flush();
};

const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await flush();
};

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("a settings list row prints what the read already carries", () => {
  it("prints `detail` beside the item", async () => {
    await mountReddit({
      competitors: [{ id: "c1", item: "Turo", detail: "turo.com", status: "tracking", origin: "suggested" }],
    });
    const section = sectionFor("Competitors");
    expect(within(section).getByText("Turo")).toBeTruthy();
    expect(within(section).getByText("turo.com")).toBeTruthy();
  });

  it("prints a declared stat column only where the row has the number", async () => {
    await mountReddit({
      keywords: [
        {
          id: "k1",
          item: "car rental software",
          item_type: "category",
          status: "tracking",
          stats: { mentions_7d: 214, top_subreddit: "smallbusiness", matches_today: 12 },
        },
        { id: "k2", item: "fleet crm", item_type: "category", status: "tracking" },
      ],
    });
    const section = sectionFor("Keywords");
    expect(within(section).getByText("214")).toBeTruthy();
    expect(within(section).getByText("smallbusiness")).toBeTruthy();
    expect(within(section).getByText("12")).toBeTruthy();
    expect(within(section).getAllByText(/mentions\/7d/)).toHaveLength(1);
  });
});

describe("the rules verdict is a labelled, nullable item_type", () => {
  it("shows an unchecked community as not-checked, never as the first value", async () => {
    await mountReddit({
      communities: [{ id: "s1", item: "sweatystartup", item_type: null, status: "tracking" }],
    });
    const select = within(sectionFor("Communities")).getByLabelText(
      "What the rules of r/sweatystartup say",
    ) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.value).not.toBe("allowed");
    expect(within(select).getByText("Rules: not checked")).toBeTruthy();
    expect(within(select).getByText("Self-promotion is banned")).toBeTruthy();
  });

  it("saves a chosen verdict, and saves a cleared one as null rather than ''", async () => {
    await mountReddit({
      communities: [{ id: "s1", item: "sweatystartup", item_type: "allowed", status: "tracking" }],
    });
    const select = within(sectionFor("Communities")).getByLabelText(
      "What the rules of r/sweatystartup say",
    ) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "banned" } });
    await save();
    expect(puts()).toHaveLength(1);
    expect(puts()[0].path).toContain("/settings/communities");
    expect(puts()[0].items[0].item_type).toBe("banned");

    fireEvent.change(select, { target: { value: "" } });
    await save();
    expect(puts()[1].items[0].item_type).toBeNull();
  });
});
