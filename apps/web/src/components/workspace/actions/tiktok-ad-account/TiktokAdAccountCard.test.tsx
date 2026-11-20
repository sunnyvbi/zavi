// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: fetchMock }));

import { TiktokAdAccountCard } from "./TiktokAdAccountCard";
import { parseAdAccountInput } from "./api";

const acct = (id: string, name: string) => ({ advertiser_id: id, name, currency: "USD", status: "ENABLE", timezone: "UTC", source: "business_center" });
const state = (over: Record<string, unknown>) => ({ connected: true, accounts: [], selected_id: null, needs: "paste", checked_at: null, ...over });
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

afterEach(cleanup);
beforeEach(() => fetchMock.mockReset());

describe("TiktokAdAccountCard", () => {
  it("walks the founder through finding the ID when none was found, then saves a confirmed one", async () => {
    fetchMock.mockResolvedValueOnce(reply(state({})));
    fetchMock.mockResolvedValueOnce(reply(state({ accounts: [acct("7123456789", "Shop")], selected_id: "7123456789", needs: "nothing" })));
    const onChanged = vi.fn();
    render(<TiktokAdAccountCard onChanged={onChanged} />);

    expect(await screen.findByText("Add your TikTok ad account")).toBeTruthy();
    expect(screen.getByRole("link", { name: "TikTok Ads Manager" }).getAttribute("href")).toContain("ads.tiktok.com");
    const save = screen.getByRole("button", { name: "Check and save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Ads Manager link or ad account ID"), {
      target: { value: "https://ads.tiktok.com/i18n/dashboard?aadvid=7123456789&lang=en" },
    });
    expect(screen.getByText("Found ad account ID 7123456789.")).toBeTruthy();
    fireEvent.click(save);

    expect(await screen.findByText("Shop")).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/connectors/tiktok-ads/ad-accounts/manual", expect.objectContaining({ method: "POST" }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("shows TikTok's refusal in plain words and keeps the paste box", async () => {
    fetchMock.mockResolvedValueOnce(reply(state({})));
    fetchMock.mockResolvedValueOnce(reply({ error: { code: "tiktok_ads_account_not_reachable", message: "TikTok didn't confirm access to ad account 7123456789." } }, 400));
    render(<TiktokAdAccountCard />);
    fireEvent.change(await screen.findByLabelText("Ads Manager link or ad account ID"), { target: { value: "7123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("didn't confirm access");
    expect(screen.getByText("Add your TikTok ad account")).toBeTruthy();
  });

  it("asks which account to use when several were found, and saves the choice", async () => {
    fetchMock.mockResolvedValueOnce(reply(state({ accounts: [acct("111111", "Brand A"), acct("222222", "Brand B")], needs: "pick" })));
    fetchMock.mockResolvedValueOnce(reply(state({ accounts: [acct("111111", "Brand A"), acct("222222", "Brand B")], selected_id: "222222", needs: "nothing" })));
    render(<TiktokAdAccountCard />);
    expect(await screen.findByText("Which ad account should Zavi use?")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Brand B/ }));
    await waitFor(() => expect(screen.getByText("Ad account")).toBeTruthy());
    expect(screen.getByText("Brand B")).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ advertiser_id: "222222" });
  });

  it("offers Reconnect when TikTok no longer accepts the login", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: { code: "tiktok_ads_token_revoked", message: "x" } }, 409));
    const onReconnect = vi.fn(async () => {});
    render(<TiktokAdAccountCard onReconnect={onReconnect} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect TikTok Ads" }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when TikTok Ads is not connected", async () => {
    fetchMock.mockResolvedValueOnce(reply({ connected: false, accounts: [], selected_id: null, needs: "nothing", checked_at: null }));
    const { container } = render(<TiktokAdAccountCard />);
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });
});

describe("parseAdAccountInput", () => {
  it.each([
    ["7123456789", "7123456789"],
    ["https://ads.tiktok.com/i18n/perf/campaign?aadvid=7123456789&x=1", "7123456789"],
    ["ads.tiktok.com/i18n/dashboard?aadvid=7123456789", "7123456789"],
    ["hello", null],
    ["https://ads.tiktok.com/i18n/dashboard", null],
  ])("%s → %s", (input, id) => expect(parseAdAccountInput(input)).toBe(id));
});
