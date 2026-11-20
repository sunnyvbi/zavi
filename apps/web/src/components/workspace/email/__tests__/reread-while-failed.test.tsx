// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

type Answer = { status: number; body: unknown };
type Reply = Answer | "offline" | "hang" | Promise<Answer>;
const routes: Record<string, Reply> = {};
const calls: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const r = routes[key] ?? { status: 200, body: {} };
    if (r === "offline") return Promise.reject(new TypeError("Failed to fetch"));
    if (r === "hang") return new Promise(() => undefined);
    return Promise.resolve(r).then((a) => ({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) }));
  },
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("@/app/connectors/composioConnect", () => ({ startComposioConnect: vi.fn(() => Promise.resolve()) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { EmailConnectTiles, forgetConnected } from "../EmailConnectTiles";
import { EmailSendingSwitch, forgetPaused, EMAIL_SENDING_COPY } from "../EmailSendingSwitch";
import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";
import { REREAD_EVERY_MS } from "../useRereadWhileFailed";
import { ChannelOverviewPanels, ChannelSettingsPanels } from "../EmailSettingsPanels";
import { EmailSendBlockers } from "../EmailSendBlockers";
import { SentEmailsBlock } from "../SentEmailsBlock";
import { ChannelPageHeaderSlotProvider } from "../../layout/ChannelHeaderRow";

const TOOLS = "GET /api/workspace/email-test-lists";
const PAUSE = "GET /api/workspace/email-pause";
const PLAN = "GET /api/workspace/email-plan";
const SENT = "GET /api/email-results";
const REACH = /We could not reach Zavi/;
const tools = { routes: [{ route: "mailchimp", label: "Mailchimp", status: "complete", error: null, lists: [] }], orphans: [] };
const count = (key: string) => calls.filter((c) => c === key).length;
const tick = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
const setHidden = (hidden: boolean) => Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  for (const k of Object.keys(routes)) delete routes[k];
  calls.length = 0;
  setHidden(false);
  forgetConnected();
  forgetPaused();
  forgetEmailTestLists();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setHidden(false);
});

describe("EmailConnectTiles after one failed read", () => {
  it("recovers by itself, the alert never flickers between tries, and reads stop once it is back", async () => {
    routes[TOOLS] = "offline";
    render(<EmailConnectTiles />);
    await screen.findByText(REACH);
    let answer: (a: Answer) => void = () => undefined;
    routes[TOOLS] = new Promise<Answer>((resolve) => (answer = resolve));
    await tick(REREAD_EVERY_MS);
    expect(count(TOOLS)).toBe(2);
    expect(screen.getByText(REACH)).toBeTruthy();
    await act(async () => answer({ status: 200, body: tools }));
    expect(await screen.findByTestId("email-connect-mailchimp-state")).toBeTruthy();
    expect(screen.queryByText(REACH)).toBeNull();
    const after = count(TOOLS);
    await tick(REREAD_EVERY_MS * 3);
    expect(count(TOOLS)).toBe(after);
  });

  it("does not read while the tab is hidden, and reads as soon as the network is back", async () => {
    routes[TOOLS] = "offline";
    render(<EmailConnectTiles />);
    await screen.findByText(REACH);
    setHidden(true);
    await tick(REREAD_EVERY_MS * 3);
    expect(count(TOOLS)).toBe(1);
    setHidden(false);
    routes[TOOLS] = { status: 200, body: tools };
    await act(async () => void window.dispatchEvent(new Event("online")));
    expect(await screen.findByTestId("email-connect-mailchimp-state")).toBeTruthy();
    expect(count(TOOLS)).toBe(2);
  });

  it("stops reading after it unmounts", async () => {
    routes[TOOLS] = "offline";
    const view = render(<EmailConnectTiles />);
    await screen.findByText(REACH);
    view.unmount();
    await tick(REREAD_EVERY_MS * 3);
    expect(count(TOOLS)).toBe(1);
  });
});

describe("EmailSendingSwitch after one failed read", () => {
  it("shows the switch again by itself and keeps the failure up between tries", async () => {
    routes[PAUSE] = "offline";
    render(<EmailSendingSwitch />);
    await screen.findByText(EMAIL_SENDING_COPY.unknown);
    routes[PAUSE] = "hang";
    await tick(REREAD_EVERY_MS);
    expect(screen.getByText(EMAIL_SENDING_COPY.unknown)).toBeTruthy();
    routes[PAUSE] = { status: 200, body: { paused: false, held: null } };
    await tick(REREAD_EVERY_MS);
    expect(await screen.findByRole("switch")).toBeTruthy();
    expect(screen.queryByText(EMAIL_SENDING_COPY.unknown)).toBeNull();
  });
});

describe("EmailSendingSwitch at phone width", () => {
  it("has a 24px tap area around the 18px track and a short label for phones", async () => {
    routes[PAUSE] = { status: 200, body: { paused: true, held: null } };
    render(<EmailSendingSwitch />);
    const button = await screen.findByRole("switch");
    expect(button.className.split(/\s+/)).toContain("h-6");
    expect(button.className).not.toContain("h-[18px]");
    expect(screen.getByTestId("email-sending-track").className).toContain("h-[18px]");
    expect(button.contains(screen.getByTestId("email-sending-track"))).toBe(true);
    expect(screen.getByTestId("email-sending-label-short").textContent).toBe("Email");
    expect(screen.getByTestId("email-sending-label-short").className).toContain("compact:inline");
    expect(screen.getByTestId("email-sending-label").className).toContain("compact:hidden");
  });
});

describe("type scale and tokens", () => {
  it("the connect tiles use 13, 12 and 11px text only", async () => {
    routes[TOOLS] = { status: 200, body: tools };
    const { container } = render(<EmailConnectTiles />);
    await screen.findByTestId("email-connect-gmail-state");
    expect(container.innerHTML).toContain("text-[13px]");
    expect(container.innerHTML).toContain("text-[11px]");
    expect(container.innerHTML).not.toMatch(/\b13\.5px|12\.5px|11\.5px/);
  });

  it("the Paused badge uses the marigoldDeep token, not raw hex", async () => {
    routes[PAUSE] = { status: 200, body: { paused: true, held: null } };
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    render(
      <ChannelPageHeaderSlotProvider element={null} titleElement={slot}>
        <EmailSendingSwitch />
      </ChannelPageHeaderSlotProvider>,
    );
    const badge = await screen.findByTestId("email-paused-badge");
    expect(badge.className).toContain("text-marigoldDeep");
    expect(badge.className).not.toContain("#a96a0c");
    slot.remove();
  });
});

describe("the other read failures on the page", () => {
  it("Coming up comes back by itself", async () => {
    routes[PLAN] = "offline";
    render(<ChannelOverviewPanels panels={["email_coming_up"]} />);
    const alert = await screen.findByTestId("coming-up-read-error");
    expect(alert.textContent).toMatch(REACH);
    routes[PLAN] = { status: 200, body: { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: false, items: [], holds: [], released: [] } };
    await tick(REREAD_EVERY_MS);
    await act(async () => undefined);
    expect(screen.queryByTestId("coming-up-read-error")).toBeNull();
  });

  it("How your emails are doing comes back by itself", async () => {
    routes[SENT] = "offline";
    routes[PLAN] = { status: 200, body: { ok: true, role: "owner", timezone: "UTC", items: [], holds: [], released: [] } };
    render(<SentEmailsBlock />);
    await screen.findByText(REACH);
    routes[SENT] = { status: 200, body: { emails: [], more: false } };
    await tick(REREAD_EVERY_MS);
    await act(async () => undefined);
    expect(screen.queryByText(REACH)).toBeNull();
  });
});

describe("Settings and Before you send after one failed read", () => {
  it("Settings Sending clears the alert by itself, never flickers it, and stops reading", async () => {
    routes[TOOLS] = "offline";
    render(<ChannelSettingsPanels panels={["email_sending_domain"]} />);
    await screen.findByText(REACH);
    await tick(REREAD_EVERY_MS);
    expect(screen.queryByText(REACH)).not.toBeNull();
    routes[TOOLS] = { status: 200, body: tools };
    await tick(REREAD_EVERY_MS);
    await act(async () => undefined);
    expect(screen.queryByText(REACH)).toBeNull();
    const reads = count(TOOLS);
    await tick(REREAD_EVERY_MS * 3);
    expect(count(TOOLS)).toBe(reads);
  });

  it("Before you send reads again by itself while a check could not run, and stops once it can", async () => {
    routes[TOOLS] = "offline";
    render(<EmailSendBlockers />);
    await act(async () => undefined);
    await act(async () => undefined);
    const first = count(TOOLS);
    await tick(REREAD_EVERY_MS);
    await act(async () => undefined);
    expect(count(TOOLS)).toBeGreaterThan(first);
    routes[TOOLS] = { status: 200, body: tools };
    await tick(REREAD_EVERY_MS);
    await act(async () => undefined);
    await act(async () => undefined);
    const reads = count(TOOLS);
    await tick(REREAD_EVERY_MS * 3);
    expect(count(TOOLS)).toBeLessThanOrEqual(reads + 1);
  });
});
