// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChannelSettingsTab, withArrivals } from "../ChannelTabs";
import { PLATFORMS } from "../../actions/platforms";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

afterEach(cleanup);

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
  });
};
const respond = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const kw = (item: string, status = "tracking", origin = "custom") => ({ item, item_type: "problem", status, origin });

const sectionFor = (label: string) => screen.getByText(label, { selector: "h4" }).closest("section") as HTMLElement;

describe("saving the Settings tab after Zavi added rows in the background", () => {
  it("keeps the keyword Zavi found mid-edit and still drops the one the founder removed", async () => {
    let server = { keywords: [kw("eggless cake"), kw("cake delivery")] };
    const puts: Array<Array<{ item: string }>> = [];
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const items = (JSON.parse(String(init.body)) as { items: Array<{ item: string }> }).items;
        puts.push(items);
        return respond({ fields: { keywords: items } });
      }
      return respond({ fields: server });
    });

    render(<ChannelSettingsTab slug="reddit_organic" fields={PLATFORMS.reddit_organic.settings ?? []} />);
    await flush();

    server = { keywords: [...server.keywords, kw("birthday cake glasgow", "suggested", "suggested")] };

    const keywords = sectionFor("Keywords");
    const removeButtons = within(keywords).getAllByRole("button", { name: "Remove" });
    fireEvent.click(removeButtons[1]);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    const sent = puts.at(-1)!.map((i) => i.item);
    expect(sent).toContain("eggless cake");
    expect(sent).toContain("birthday cake glasgow");
    expect(sent).not.toContain("cake delivery");
  });
});

describe("a save where one field fails and another succeeds", () => {
  const mountWithFailingCompetitors = (failure: () => { ok: boolean; status: number; json: () => Promise<unknown> }) => {
    const server = { keywords: [kw("eggless cake"), kw("cake delivery")], competitors: [kw("Crumbl"), kw("Goldbelly")] };
    const puts: Array<{ path: string; items: Array<{ item: string }> }> = [];
    const state = { competitorsFail: true };
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const items = (JSON.parse(String(init.body)) as { items: Array<{ item: string }> }).items;
        puts.push({ path, items });
        if (path.endsWith("/competitors") && state.competitorsFail) return Promise.resolve(failure());
        return respond({ fields: { ...server, [path.split("/").pop()!]: items } });
      }
      return respond({ fields: server });
    });
    render(<ChannelSettingsTab slug="reddit_organic" fields={PLATFORMS.reddit_organic.settings ?? []} />);
    return { puts, state };
  };
  const removeRow = (label: string, item: string) => {
    const row = within(sectionFor(label)).getByText(item).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
  };

  it("keeps the failed field's edit on screen and sends it again on retry", async () => {
    const { puts, state } = mountWithFailingCompetitors(() => ({ ok: false, status: 400, json: async () => ({}) }));
    await flush();

    removeRow("Competitors", "Goldbelly");
    removeRow("Keywords", "cake delivery");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    expect(within(sectionFor("Competitors")).queryByText("Goldbelly")).toBeNull();
    expect(within(sectionFor("Keywords")).queryByText("cake delivery")).toBeNull();
    expect(screen.getByText(/1 of 2 didn't save/)).toBeTruthy();

    state.competitorsFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    const retry = puts.filter((p) => p.path.endsWith("/competitors")).at(-1)!;
    expect(retry.items.map((i) => i.item)).toEqual(["Crumbl"]);
    expect(puts.filter((p) => p.path.endsWith("/keywords"))).toHaveLength(1);
  });

  it("shows the server's own reason instead of a count, and still keeps the edit", async () => {
    const reason = "Competitors can list at most 20 brands.";
    const { puts } = mountWithFailingCompetitors(() => ({ ok: false, status: 400, json: async () => ({ error: { code: "too_many", message: reason } }) }));
    await flush();

    removeRow("Competitors", "Goldbelly");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByText(/didn't save/)).toBeNull();
    expect(screen.queryByText(/^Saved\./)).toBeNull();
    expect(within(sectionFor("Competitors")).queryByText("Goldbelly")).toBeNull();
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(false);
    expect(puts).toHaveLength(1);
  });

  it("reads a top-level message when the error is only a code string", async () => {
    const { puts } = mountWithFailingCompetitors(() => ({ ok: false, status: 409, json: async () => ({ error: "conflict", message: "Someone else changed this list. Reload to see it." }) }));
    await flush();
    removeRow("Competitors", "Goldbelly");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();
    expect(screen.getByText("Someone else changed this list. Reload to see it.")).toBeTruthy();
    expect(puts).toHaveLength(1);
  });
});

describe("an edit made while Save is still running", () => {
  it("stays unsaved and is sent on the next Save", async () => {
    const server = { keywords: [kw("eggless cake"), kw("cake delivery")], competitors: [kw("Crumbl"), kw("Goldbelly")] };
    let release: () => void = () => {};
    const puts: Array<{ path: string; items: Array<{ item: string }> }> = [];
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const items = (JSON.parse(String(init.body)) as { items: Array<{ item: string }> }).items;
        puts.push({ path, items });
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 200, json: async () => ({ fields: { ...server, [path.split("/").pop()!]: items } }) });
        });
      }
      return respond({ fields: server });
    });

    render(<ChannelSettingsTab slug="reddit_organic" fields={PLATFORMS.reddit_organic.settings ?? []} />);
    await flush();
    const keywordRow = within(sectionFor("Keywords")).getByText("cake delivery").closest("li") as HTMLElement;
    fireEvent.click(within(keywordRow).getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    const competitorRow = within(sectionFor("Competitors")).getByText("Goldbelly").closest("li") as HTMLElement;
    fireEvent.click(within(competitorRow).getByRole("button", { name: "Remove" }));
    await act(async () => release());
    await flush();

    expect(screen.queryByText("Saved. Applies on the next run.")).toBeNull();
    const save = screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await flush();
    await act(async () => release());
    await flush();
    const sent = puts.filter((p) => p.path.endsWith("/competitors"));
    expect(sent).toHaveLength(1);
    expect(sent[0].items.map((i) => i.item)).toEqual(["Crumbl"]);
  });

  it("keeps a background arrival when the same field changes during Save", async () => {
    let server = { keywords: [kw("eggless cake"), kw("first gone"), kw("second gone")] };
    let release: () => void = () => {};
    const puts: Array<Array<{ item: string }>> = [];
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const items = (JSON.parse(String(init.body)) as { items: Array<{ item: string }> }).items;
        puts.push(items);
        if (puts.length === 1) {
          return new Promise((resolve) => {
            release = () => {
              server = { keywords: items.map((i) => kw(i.item)) };
              resolve({ ok: true, status: 200, json: async () => ({ fields: server }) });
            };
          });
        }
        server = { keywords: items.map((i) => kw(i.item)) };
        return respond({ fields: server });
      }
      return respond({ fields: server });
    });

    render(<ChannelSettingsTab slug="reddit_organic" fields={PLATFORMS.reddit_organic.settings ?? []} />);
    await flush();
    server = { keywords: [...server.keywords, kw("background arrival", "suggested", "suggested")] };

    const remove = (item: string) => {
      const row = within(sectionFor("Keywords")).getByText(item).closest("li") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    };
    remove("first gone");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    remove("second gone");
    await act(async () => release());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    expect(puts.at(-1)?.map((item) => item.item)).toEqual(["eggless cake", "background arrival"]);
  });

  it("does not restore a prefixed community removed during Save", async () => {
    let server: { communities: Array<{ item: string; status: string; origin: string }> } = { communities: [] };
    let release: () => void = () => {};
    const puts: Array<Array<{ item: string }>> = [];
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const items = (JSON.parse(String(init.body)) as { items: Array<{ item: string }> }).items;
        puts.push(items);
        if (puts.length === 1) {
          return new Promise((resolve) => {
            release = () => {
              server = { communities: [{ item: "SaaS", status: "tracking", origin: "custom" }] };
              resolve({ ok: true, status: 200, json: async () => ({ fields: server }) });
            };
          });
        }
        return respond({ fields: { communities: items } });
      }
      return respond({ fields: server });
    });

    render(<ChannelSettingsTab slug="reddit_organic" fields={PLATFORMS.reddit_organic.settings ?? []} />);
    await flush();
    const communities = sectionFor("Communities");
    const input = within(communities).getByPlaceholderText(/Add to communities/i);
    fireEvent.change(input, { target: { value: "r/SaaS" } });
    fireEvent.click(within(communities).getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    fireEvent.click(within(communities).getByRole("button", { name: "Remove" }));
    await act(async () => release());
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    expect(puts.at(-1)).toEqual([]);
  });
});

describe("a single-value setting changed in another tab meanwhile", () => {
  it("saves only this tab's value, never two values for one setting", async () => {
    let server: Record<string, Array<{ item: string }>> = { tcpa: [{ item: "50" }] };
    const puts: Array<{ path: string; items: Array<{ item: string }> }> = [];
    apiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const items = (JSON.parse(String(init.body)) as { items: Array<{ item: string }> }).items;
        puts.push({ path, items });
        return respond({ fields: { ...server, tcpa: items } });
      }
      return respond({ fields: server });
    });

    render(<ChannelSettingsTab slug="chatgpt_ads" fields={PLATFORMS.chatgpt_ads.settings ?? []} />);
    await flush();
    server = { tcpa: [{ item: "70" }] };

    fireEvent.change(screen.getByLabelText("Target cost per customer"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await flush();

    const sent = puts.find((p) => p.path.endsWith("/tcpa"))!;
    expect(sent.items.map((i) => i.item)).toEqual(["60"]);
  });
});

describe("withArrivals", () => {
  const loaded = new Set(["a", "b"]);

  it("adds rows that appeared on the server after the load", () => {
    expect(withArrivals([{ item: "a" }], [{ item: "a" }, { item: "b" }, { item: "c" }], loaded).map((r) => r.item)).toEqual(["a", "c"]);
  });

  it("does not bring back a removed row or duplicate an edited one in another case", () => {
    expect(withArrivals([{ item: "C" }], [{ item: "a" }, { item: "c" }], loaded).map((r) => r.item)).toEqual(["C"]);
  });

  it("sends the edit unchanged when the re-read failed", () => {
    expect(withArrivals([{ item: "a" }], undefined, loaded)).toEqual([{ item: "a" }]);
  });

  it("treats a field that was empty at load as loaded with nothing", () => {
    expect(withArrivals([], [{ item: "z" }], new Set()).map((r) => r.item)).toEqual(["z"]);
  });
});
