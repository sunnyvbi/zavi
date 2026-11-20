// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function stubApi(get: Record<string, unknown>) {
  apiFetch.mockImplementation((_path: string, init?: RequestInit) =>
    init?.method === "PUT" ? respond(true, 200, {}) : respond(true, 200, get),
  );
}

const puts = () =>
  apiFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([path, init]) => ({
      path: String(path),
      items: (JSON.parse(String((init as RequestInit).body)) as { items: Array<{ item: string }> }).items,
    }));

const mount = async () => {
  render(<ChannelSettingsTab slug="pinterest_organic" fields={PLATFORMS.pinterest_organic.settings ?? []} />);
  await flush();
};

const handleInput = () => screen.getByLabelText("Your Pinterest account") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;

beforeEach(() => {
  apiFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

const offerButton = () => screen.queryByRole("button", { name: "Use @dudhat0633" }) as HTMLButtonElement | null;

describe("Pinterest account prefill from the connected account", () => {
  it("offers the connected username without touching the field, and Save stores exactly that username once taken", async () => {
    stubApi({ fields: {}, prefill: { handle: [{ item: "dudhat0633" }] } });
    await mount();

    expect(handleInput().value).toBe("");
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByText("Filled in from your connected account. Save to keep it.")).toBeNull();

    fireEvent.click(offerButton()!);
    await flush();

    expect(handleInput().value).toBe("dudhat0633");
    expect(saveButton().disabled).toBe(false);
    expect(screen.getByText("Filled in from your connected account. Save to keep it.")).toBeTruthy();
    expect(offerButton()).toBeNull();

    fireEvent.click(saveButton());
    await flush();

    expect(puts()).toEqual([
      { path: "/api/channels/pinterest_organic/settings/handle", items: [{ item: "dudhat0633" }] },
    ]);
  });

  it("a handle cleared and saved on purpose stays empty on the next visit", async () => {
    stubApi({ fields: {}, prefill: { handle: [{ item: "dudhat0633" }] } });
    await mount();
    fireEvent.click(offerButton()!);
    await flush();
    fireEvent.change(handleInput(), { target: { value: "" } });
    await flush();
    fireEvent.click(saveButton());
    await flush();
    expect(puts().at(-1)).toEqual({ path: "/api/channels/pinterest_organic/settings/handle", items: [] });

    cleanup();
    apiFetch.mockReset();
    stubApi({ fields: {}, prefill: { handle: [{ item: "dudhat0633" }] } });
    await mount();

    expect(handleInput().value).toBe("");
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText("Applies on the next run. Nothing changes in your account until you approve an action.")).toBeTruthy();
    expect(puts()).toEqual([]);
  });

  it("never offers over a handle the founder already saved", async () => {
    stubApi({
      fields: { handle: [{ id: "h1", item: "cakelyofficial", status: "tracking" }] },
      prefill: { handle: [{ item: "dudhat0633" }] },
    });
    await mount();

    expect(handleInput().value).toBe("cakelyofficial");
    expect(saveButton().disabled).toBe(true);
    expect(offerButton()).toBeNull();
    expect(puts()).toEqual([]);
  });

  it("bare, it drops the idle sentence and the Save button until something changes", async () => {
    stubApi({ fields: {}, prefill: {} });
    render(<ChannelSettingsTab slug="pinterest_organic" fields={PLATFORMS.pinterest_organic.settings ?? []} bare />);
    await flush();

    expect(handleInput().value).toBe("");
    expect(screen.queryByText(/Nothing changes in your account until/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();

    fireEvent.change(handleInput(), { target: { value: "cakely" } });
    await flush();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("offers nothing when no account is connected", async () => {
    stubApi({ fields: {}, prefill: {} });
    await mount();

    expect(handleInput().value).toBe("");
    expect(saveButton().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Use @/ })).toBeNull();
  });
});
