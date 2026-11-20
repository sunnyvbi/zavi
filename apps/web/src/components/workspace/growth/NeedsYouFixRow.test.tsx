import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  reconnect: vi.fn(async () => {}),
  fetch: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, resolved: "acted" }) })),
}));
vi.mock("../settings/reconnectFlows", () => ({ startReconnectFlow: m.reconnect }));
vi.mock("@/lib/api", () => ({ apiFetch: m.fetch }));

import { NeedsYouFixRow } from "./NeedsYouFixRow";

const DID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeEach(() => {
  m.reconnect.mockClear();
  m.reconnect.mockResolvedValue(undefined);
  m.fetch.mockClear();
});
afterEach(cleanup);

describe("NeedsYouFixRow", () => {
  it("reconnect runs the flow and reports the window honestly (never claims auth finished)", async () => {
    render(
      <ul>
        <NeedsYouFixRow
          row={{ line: "Reconnect TikTok Ads", url: null, urgent: true, fix: { kind: "reconnect", slug: "tiktok_ads" } }}
          label="Needs you"
        />
      </ul>,
    );
    expect(screen.getByText("Money at risk")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Finish the connection"));
    expect(m.reconnect).toHaveBeenCalledWith("tiktok_ads");
  });

  it("a failed reconnect shows the retry path and nothing is claimed fixed", async () => {
    m.reconnect.mockRejectedValueOnce(new Error("window closed"));
    render(
      <ul>
        <NeedsYouFixRow row={{ line: "x", url: null, fix: { kind: "reconnect", slug: "meta_ads" } }} label="Needs you" />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("window closed"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });

  it("'It went through' posts the check and never re-sends", async () => {
    render(
      <ul>
        <NeedsYouFixRow row={{ line: "Check Meta", url: null, fix: { kind: "check", decision_id: DID } }} label="Needs you" />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: "It went through" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(m.fetch).toHaveBeenCalledWith(
      `/api/workspace/decisions/${DID}/check`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ went_through: true }) }),
    );
  });

  it("budget rows offer the two budget moves, no network", () => {
    render(
      <ul>
        <NeedsYouFixRow row={{ line: "Over cap", url: null, urgent: true, fix: { kind: "budget" } }} label="Needs you" />
      </ul>,
    );
    expect(screen.getByRole("button", { name: "Lower daily budgets" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Raise the cap" })).toBeTruthy();
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("a plain row keeps its link and gains no buttons", () => {
    render(
      <ul>
        <NeedsYouFixRow
          row={{ line: "Pick locations", url: "/workspace?tab=channels&channel=google_ads&locations=1", url_label: "Pick where ads show", fix: { kind: "locations", channel_slug: "google_ads" } }}
          label="Needs you"
        />
      </ul>,
    );
    const a = screen.getByRole("link", { name: "Pick where ads show" });
    expect(a.getAttribute("href")).toContain("locations=1");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
