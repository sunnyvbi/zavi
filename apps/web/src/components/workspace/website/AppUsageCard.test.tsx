// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { useState } from "react";
import { AppUsageCard } from "./AppUsageCard";

type Entry = { credits: number; usd: number; status: "settled" | "pending" | "refunded" | "covered" | "none"; covered?: number; daily?: number };

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function ledger(byId: Record<string, Entry>) {
  apiFetch.mockImplementation(async (url: string) => {
    const ids = decodeURIComponent(String(url).split("ids=")[1] ?? "").split(",");
    if (ids.length > 40) return { ok: false, status: 400, json: async () => ({}) };
    const runs: Record<string, Entry> = {};
    for (const id of ids) if (byId[id]) runs[id] = byId[id];
    return { ok: true, status: 200, json: async () => ({ runs }) };
  });
}

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("AppUsageCard", () => {
  it("sums every build and change of the app, even past the endpoint's 40-id limit", async () => {
    const ids = Array.from({ length: 45 }, (_, i) => uuid(i + 1));
    const byId: Record<string, Entry> = {};
    ids.forEach((id, i) => (byId[id] = { credits: i === 44 ? 1000 : 10, usd: 0, status: "settled" }));
    ledger(byId);
    render(<AppUsageCard runIds={ids} onOpenBilling={() => {}} />);
    expect(await screen.findByText("1,440")).toBeTruthy();
    const rows = within(screen.getByRole("list", { name: "Credits per build" })).getAllByRole("listitem");
    expect(rows).toHaveLength(45);
    expect(rows[0].textContent).toBe("First build10 credits");
    expect(rows[44].textContent).toBe("Change 441,000 credits");
    expect(screen.queryByText(/1 build/)).toBeNull();
    const calls = apiFetch.mock.calls.map((c) => decodeURIComponent(String(c[0])).split("ids=")[1].split(","));
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.length <= 40)).toBe(true);
    expect(new Set(calls.flat())).toEqual(new Set(ids));
  });

  it("says credits are still settling while a change is in flight", async () => {
    ledger({ [uuid(1)]: { credits: 300, usd: 0, status: "settled" }, [uuid(2)]: { credits: 0, usd: 0, status: "pending" } });
    render(<AppUsageCard runIds={[uuid(1), uuid(2)]} onOpenBilling={() => {}} />);
    expect(await screen.findAllByText("settling…")).toHaveLength(2);
    expect(screen.getByText("300")).toBeTruthy();
    expect(screen.getByText("Change 1")).toBeTruthy();
  });

  it("a failed read shows Retry, and Retry reads again instead of showing zero", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    render(<AppUsageCard runIds={[uuid(1)]} onOpenBilling={() => {}} />);
    const retry = await screen.findByRole("button", { name: /Retry/ });
    ledger({ [uuid(1)]: { credits: 75, usd: 0, status: "settled" } });
    fireEvent.click(retry);
    expect(await screen.findByText("75")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("a slow answer for the old run list never overwrites the newer one", async () => {
    let oldSettled = false;
    apiFetch.mockImplementation(async (url: string) => {
      const ids = decodeURIComponent(String(url).split("ids=")[1]).split(",");
      if (ids.length === 1) {
        await new Promise((r) => setTimeout(r, 150));
        oldSettled = true;
      }
      const runs = Object.fromEntries(ids.map((id) => [id, { credits: ids.length === 1 ? 5 : 20, usd: 0, status: "settled" }]));
      return { ok: true, status: 200, json: async () => ({ runs }) };
    });
    function Harness() {
      const [ids, setIds] = useState([uuid(1)]);
      return (
        <>
          <button type="button" onClick={() => setIds([uuid(1), uuid(2)])}>
            add change
          </button>
          <AppUsageCard runIds={ids} onOpenBilling={() => {}} />
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "add change" }));
    expect(await screen.findByText("40")).toBeTruthy();
    expect(oldSettled).toBe(false);
    await waitFor(() => expect(oldSettled).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText("40")).toBeTruthy();
    expect(screen.queryByText("5")).toBeNull();
  });

  it("counts what Zavi absorbed as used, and names the daily grant's share from its own field", async () => {
    ledger({
      [uuid(1)]: { credits: 1000, usd: 0, status: "settled", covered: 500, daily: 1000 },
      [uuid(2)]: { credits: 0, usd: 0, status: "covered", covered: 150 },
    });
    render(<AppUsageCard runIds={[uuid(1), uuid(2)]} onOpenBilling={() => {}} />);
    expect(await screen.findByText("1,650")).toBeTruthy();
    expect(screen.getByTestId("app-usage-covered").textContent).toBe("1,000 covered by daily credits");
    const rows = within(screen.getByRole("list", { name: "Credits per build" })).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["First build1,500 credits", "Change 1150 credits"]);
  });

  it("no daily line when the daily grant paid nothing", async () => {
    ledger({ [uuid(1)]: { credits: 0, usd: 0, status: "covered", covered: 600 } });
    render(<AppUsageCard runIds={[uuid(1)]} onOpenBilling={() => {}} />);
    expect(await screen.findByText("600")).toBeTruthy();
    expect(screen.queryByTestId("app-usage-covered")).toBeNull();
  });

  it("an app with no runs says so", async () => {
    render(<AppUsageCard runIds={[]} onOpenBilling={() => {}} />);
    expect(await screen.findByText("No builds yet")).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("Billing & credits hands off to the global billing settings", async () => {
    ledger({});
    const onOpenBilling = vi.fn();
    render(<AppUsageCard runIds={[uuid(1)]} onOpenBilling={onOpenBilling} />);
    fireEvent.click(screen.getByRole("button", { name: /Billing & credits/ }));
    expect(onOpenBilling).toHaveBeenCalledTimes(1);
  });
});
