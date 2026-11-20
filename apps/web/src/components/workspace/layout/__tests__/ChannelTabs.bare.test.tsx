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

const respond = (ok: boolean, status: number, body: unknown) =>
  Promise.resolve({ ok, status, json: async () => body });

type Row = { id?: string; item: string; item_type?: string | null; status?: string };

function stubApi(rows: Row[], put: { ok: boolean } = { ok: true }) {
  apiFetch.mockImplementation((_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const items = (JSON.parse(String(init.body)) as { items: Row[] }).items;
      return put.ok ? respond(true, 200, { fields: { segments: items } }) : respond(false, 500, {});
    }
    return respond(true, 200, { fields: { segments: rows } });
  });
}

const puts = () =>
  apiFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([path, init]) => ({
      path: String(path),
      items: (JSON.parse(String((init as RequestInit).body)) as { items: Row[] }).items,
    }));

const ADDRESS = "mohit2703@yopmail.com";
const SAVED: Row[] = [{ id: "s1", item: ADDRESS, item_type: null, status: "tracking" }];

const mountEmail = async () => {
  render(<ChannelSettingsTab slug="email_marketing" fields={PLATFORMS.email_marketing.settings ?? []} bare />);
  await flush();
};

const IDLE_SENTENCE = /Nothing changes in your account until/;

beforeEach(() => {
  apiFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Who you email, rendered bare inside Email campaigns settings", () => {
  it("shows no save bar, no idle sentence and no Save button while nothing has changed", async () => {
    stubApi(SAVED);
    await mountEmail();

    expect(screen.getByText(ADDRESS)).toBeTruthy();
    expect(screen.queryByText(IDLE_SENTENCE)).toBeNull();
    expect(screen.queryByText(/Applies on the next run/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.queryByTestId("settings-save-bar")).toBeNull();
  });

  it("draws no status pill and no pause toggle on an audience row", async () => {
    stubApi(SAVED);
    await mountEmail();

    const row = screen.getByText(ADDRESS).closest("li")!;
    expect(within(row).queryByText("tracking")).toBeNull();
    expect(within(row).queryByText("paused")).toBeNull();
    expect(within(row).queryByRole("button", { name: `Pause ${ADDRESS}` })).toBeNull();
    expect(within(row).queryByRole("button", { pressed: true })).toBeNull();
    expect(within(row).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("uses the new label, help, placeholder and consent options, keeping the per-row aria-label", async () => {
    stubApi(SAVED);
    await mountEmail();

    expect(screen.getByRole("heading", { level: 3, name: "Who you email" })).toBeTruthy();
    expect(screen.getByText("Describe each group in a few words. Zavi reads this before planning emails.")).toBeTruthy();
    expect(screen.getByPlaceholderText("e.g. Customers who bought in the last 90 days")).toBeTruthy();
    const select = screen.getByLabelText(`What ${ADDRESS} agreed to`) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Consent not stated",
      "Opted in to marketing",
      "Customers only",
      "Imported or bought",
    ]);
    expect(select.value).toBe("");
    expect(screen.queryByText("Who's on your list")).toBeNull();
  });

  it("shows Unsaved changes and Save once the consent changes, saves that value, then says Saved. for three seconds", async () => {
    stubApi(SAVED);
    await mountEmail();

    fireEvent.change(screen.getByLabelText(`What ${ADDRESS} agreed to`), { target: { value: "marketing_optin" } });
    await flush();

    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.queryByText(IDLE_SENTENCE)).toBeNull();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    vi.useFakeTimers();
    fireEvent.click(save);
    await flush(40);

    expect(puts()).toEqual([
      {
        path: "/api/channels/email_marketing/settings/segments",
        items: [{ id: "s1", item: ADDRESS, item_type: "marketing_optin", status: "tracking" }],
      },
    ]);
    expect(screen.getByText("Saved.")).toBeTruthy();
    expect(screen.queryByText(/Applies on the next run/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(2900);
    });
    expect(screen.getByText("Saved.")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(screen.queryByTestId("settings-save-bar")).toBeNull();
  });

  it("keeps the failure note and a live Save button when the save is refused", async () => {
    stubApi(SAVED, { ok: false });
    await mountEmail();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await flush();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush(40);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByText(/didn't save\. Your changes are still here/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("adds a typed audience with the same height Add button and stores it unset, never claiming consent", async () => {
    stubApi([]);
    await mountEmail();

    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.className).toContain("h-9");
    expect(screen.getByPlaceholderText("e.g. Customers who bought in the last 90 days").className).toContain("h-9");
    expect(add.className).not.toMatch(/hover:/);

    fireEvent.change(screen.getByPlaceholderText("e.g. Customers who bought in the last 90 days"), {
      target: { value: "Newsletter" },
    });
    fireEvent.click(add);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush(40);

    expect(puts()).toEqual([
      {
        path: "/api/channels/email_marketing/settings/segments",
        items: [{ item: "Newsletter", item_type: null, status: "tracking", origin: "custom" }],
      },
    ]);
  });
});

describe("other channels keep the non-bare form exactly as before", () => {
  it("reddit still shows its pause toggle and the idle save sentence", async () => {
    apiFetch.mockImplementation(() =>
      respond(true, 200, {
        fields: { communities: [{ id: "c1", item: "sweatystartup", item_type: "allowed", status: "tracking" }] },
      }),
    );
    render(<ChannelSettingsTab slug="reddit_organic" fields={PLATFORMS.reddit_organic.settings ?? []} />);
    await flush();

    expect(screen.getByRole("button", { name: "Pause sweatystartup" })).toBeTruthy();
    expect(screen.getByText(IDLE_SENTENCE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeTruthy();
  });
});
