// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
let active: string | null = "t1";
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: async () => active }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
const toastAdd = vi.fn();
vi.mock("@/components/ui/toast", () => ({ toast: { add: (o: unknown) => toastAdd(o) } }));

import { AnomalyMuteLink, __resetAnomalyMuteLinkForTest, muteLabel } from "./AnomalyMuteLink";

type ToastArg = { type: string; title: string; actionProps?: { children: string; onClick: () => void } };
const titles = () => toastAdd.mock.calls.map((c) => (c[0] as ToastArg).title);
const bodies = () => apiFetch.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));

beforeEach(() => {
  __resetAnomalyMuteLinkForTest();
  apiFetch.mockReset();
  toastAdd.mockReset();
  active = "t1";
  window.history.replaceState(null, "", "/workspace?company=t1&mute_alert=net_revenue&tab=home");
});

describe("AnomalyMuteLink", () => {
  it("sends exactly one mute POST with the key, confirms, and Undo unmutes", async () => {
    apiFetch.mockResolvedValue({ ok: true });
    const { rerender } = render(<AnomalyMuteLink muteKey="net_revenue" company="t1" />);
    rerender(<AnomalyMuteLink muteKey="net_revenue" company="t1" />);
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/analytics/anomaly-mutes");
    expect(bodies()).toEqual([{ key: "net_revenue", muted: true, expect_tenant: "t1" }]);
    const t = toastAdd.mock.calls[0][0] as ToastArg;
    expect(t.title).toBe("Alerts muted for net revenue.");
    expect(t.actionProps?.children).toBe("Undo");

    t.actionProps!.onClick();
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(2));
    expect(bodies()[1]).toEqual({ key: "net_revenue", muted: false, expect_tenant: "t1" });
    expect(titles()[1]).toBe("Alerts back on for net revenue.");
  });

  it("strips mute_alert from the URL and keeps the rest", async () => {
    apiFetch.mockResolvedValue({ ok: true });
    render(<AnomalyMuteLink muteKey="net_revenue" company="t1" />);
    await waitFor(() => expect(toastAdd).toHaveBeenCalled());
    expect(window.location.search).toBe("?company=t1&tab=home");
  });

  it("a failed POST shows the error and never claims success", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500 });
    render(<AnomalyMuteLink muteKey="net_revenue" company="t1" />);
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1));
    expect(titles()).toEqual(["Could not mute alerts. Try the link again."]);
    expect(titles().some((t) => t.includes("Alerts muted"))).toBe(false);
    expect(window.location.search).not.toContain("mute_alert");
  });

  it("never mutes when the browser's active company is not the link's", async () => {
    active = "t2";
    render(<AnomalyMuteLink muteKey="net_revenue" company="t1" />);
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1));
    expect(apiFetch).not.toHaveBeenCalled();
    expect(titles()).toEqual(["Could not mute alerts. Try the link again."]);
  });

  it("labels keys readably", () => {
    expect(muteLabel("*")).toBe("every metric");
    expect(muteLabel("read_failed:google_ads")).toBe("the google ads connection");
  });
});
