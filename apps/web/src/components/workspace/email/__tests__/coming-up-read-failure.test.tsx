// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};

type Reply = { status: number; body: unknown } | "network";
const replies: Record<string, Reply> = {};
const calls: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const r = replies[key] ?? { status: 200, body: { ok: true } };
    if (r === "network") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { ChannelOverviewPanels } from "../EmailSettingsPanels";

const PLAN = "GET /api/workspace/email-plan";
const offView = { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: false, items: [], holds: [], released: [] };

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(replies)) delete replies[k];
  replies["GET /api/workspace/growth/plan"] = { status: 500, body: { error: "boom" } };
});
afterEach(cleanup);

describe("Coming up when the plan cannot be read", () => {
  it("a 500 with a non-sentence body says what failed, under Autopilot, with Autopilot marked unread and one Retry that recovers both", async () => {
    replies[PLAN] = { status: 500, body: { error: "boom" } };
    render(<ChannelOverviewPanels panels={["email_coming_up"]} />);
    const alert = await screen.findByTestId("coming-up-read-error");
    expect(alert.textContent).toContain("Could not load your planned emails.");
    expect(screen.queryByText(/That did not work/)).toBeNull();
    expect(screen.queryByText(/boom/)).toBeNull();

    const strip = screen.getByTestId("coming-up-autopilot");
    expect(within(strip).getByTestId("coming-up-autopilot-unread").textContent).toBe("Could not read whether Autopilot is on.");
    expect(strip.contains(alert)).toBe(true);
    expect(alert.contains(screen.getByRole("button", { name: "Retry" }))).toBe(true);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    looksLikeButton(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("link", { name: /Turn on Autopilot/ })).toBeNull();

    replies[PLAN] = { status: 200, body: offView };
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /Turn on Autopilot/ })).toBeDefined());
    expect(within(screen.getByTestId("coming-up-autopilot")).getByText("Off")).toBeDefined();
    expect(screen.queryByTestId("coming-up-autopilot-unread")).toBeNull();
    expect(screen.queryByTestId("coming-up-read-error")).toBeNull();
    expect(calls.filter((c) => c === PLAN)).toHaveLength(2);
  });

  it("the server's generic 'That did not work' sentence is replaced the same way", async () => {
    replies[PLAN] = { status: 500, body: { error: { code: "internal_error", message: "That did not work. Try again." } } };
    render(<ChannelOverviewPanels panels={["email_coming_up"]} />);
    const alert = await screen.findByTestId("coming-up-read-error");
    expect(alert.textContent).toContain("Could not load your planned emails.");
    expect(alert.textContent).not.toContain("That did not work");
  });

  it("a real server sentence is kept, and Autopilot is still marked unread", async () => {
    replies[PLAN] = { status: 403, body: { error: { code: "forbidden", message: "You are no longer a member of this workspace." } } };
    render(<ChannelOverviewPanels panels={["email_coming_up"]} />);
    const alert = await screen.findByTestId("coming-up-read-error");
    expect(alert.textContent).toContain("You are no longer a member of this workspace.");
    expect(alert.textContent).not.toContain("Could not load your planned emails.");
    expect(screen.getByTestId("coming-up-autopilot-unread")).toBeDefined();
  });

  it("no answer keeps the network sentence", async () => {
    replies[PLAN] = "network";
    render(<ChannelOverviewPanels panels={["email_coming_up"]} />);
    const alert = await screen.findByTestId("coming-up-read-error");
    expect(alert.textContent).toContain("We could not reach Zavi. Check your connection and try again.");
    expect(screen.getByTestId("coming-up-autopilot-unread")).toBeDefined();
  });

  it("a failed refresh after a good read keeps the Autopilot status and does not mark it unread", async () => {
    replies[PLAN] = { status: 200, body: offView };
    render(<ChannelOverviewPanels panels={["email_coming_up"]} />);
    await screen.findByRole("link", { name: /Turn on Autopilot/ });
    replies[PLAN] = { status: 500, body: { error: "boom" } };
    window.dispatchEvent(new Event("zavi:email-plan-changed"));
    const alert = await screen.findByTestId("coming-up-read-error");
    expect(alert.textContent).toContain("Could not load your planned emails.");
    expect(screen.getByRole("link", { name: /Turn on Autopilot/ })).toBeDefined();
    expect(screen.queryByTestId("coming-up-autopilot-unread")).toBeNull();
  });
});
