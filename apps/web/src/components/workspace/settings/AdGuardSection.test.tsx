// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: Array<{ path: string; method: string; body?: unknown }> = [];
let googleDown = false;
let saved = { allowed_places: [] as unknown[], blocked_places: [] as unknown[], banned_phrases: ["cheapest in town"] };
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts?: { method?: string; body?: string }) => {
    calls.push({ path, method: opts?.method ?? "GET", body: opts?.body ? JSON.parse(opts.body) : undefined });
    if (path.startsWith("/api/channels/meta_ads/ad-locations/search")) {
      const extra = Array.from({ length: 7 }, (_, k) => ({ id: `m${k}`, name: `Portland area ${k}`, kind: "City" }));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ places: [{ id: "2421836", name: "Portland, Oregon, United States", kind: "City" }, ...extra] }) });
    }
    if (path.startsWith("/api/channels/google_ads/ad-locations/search")) {
      if (googleDown) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ places: [{ id: "1014044", name: "Portland, Maine, United States", kind: "City" }] }) });
    }
    if (path === "/api/rules/ad-guard" && opts?.method === "PUT") {
      saved = JSON.parse(opts.body ?? "{}");
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ad_guard: saved }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ad_guard: saved }) });
  },
}));

import { AdGuardSection } from "./AdGuardSection";

afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe("AdGuardSection", () => {
  it("an owner adds a place from the ad-platform search and a phrase, then saves the whole set", async () => {
    render(<AdGuardSection canManage />);
    await waitFor(() => screen.getByText("cheapest in town"));
    fireEvent.change(screen.getByLabelText("Search places: Ads may show only in"), { target: { value: "Portland" } });
    await screen.findByRole("button", { name: /Portland, Maine, United States.*Google/ });
    fireEvent.click(await screen.findByRole("button", { name: /Portland, Oregon, United States/ }));
    fireEvent.change(screen.getByLabelText("Add a phrase ads must never say"), { target: { value: "guaranteed" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save places and phrases" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({
      allowed_places: [{ id: "2421836", name: "Portland, Oregon, United States", kind: "City", platform: "meta" }],
      blocked_places: [],
      banned_phrases: ["cheapest in town", "guaranteed"],
    });
  });

  it("with one platform not connected, the other fills all 6 places", async () => {
    googleDown = true;
    render(<AdGuardSection canManage />);
    await waitFor(() => screen.getByText("cheapest in town"));
    fireEvent.change(screen.getByLabelText("Search places: Ads must never show in"), { target: { value: "Portland" } });
    await screen.findByRole("button", { name: /Portland area 4/ });
    expect(screen.getAllByRole("button", { name: /· Meta/ })).toHaveLength(6);
    googleDown = false;
  });

  it("a new search term clears the old results at once (no clicking a place from the last search)", async () => {
    render(<AdGuardSection canManage />);
    await waitFor(() => screen.getByText("cheapest in town"));
    const box = screen.getByLabelText("Search places: Ads may show only in");
    fireEvent.change(box, { target: { value: "Portland" } });
    await screen.findByRole("button", { name: /Portland area 0/ });
    fireEvent.change(box, { target: { value: "Salem" } });
    expect(screen.queryByRole("button", { name: /Portland area 0/ })).toBeNull();
  });

  it("a member reads the saved rules with no way to change them", async () => {
    render(<AdGuardSection canManage={false} />);
    await waitFor(() => screen.getByText("cheapest in town"));
    expect(screen.queryByRole("button", { name: "Save places and phrases" })).toBeNull();
    expect(screen.queryByLabelText("Add a phrase ads must never say")).toBeNull();
  });
});
