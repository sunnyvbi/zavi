// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Answer = { status: number; body: unknown };
const calls: string[] = [];
const answers: Record<string, Answer> = {};
const held: Record<string, Array<(a: Answer) => void>> = {};
const holding = new Set<string>();

const reply = (a: Answer) => ({ ok: a.status < 400, status: a.status, json: () => Promise.resolve(a.body) });

vi.mock("@/lib/api", () => ({
  apiFetch: (url: string) => {
    calls.push(url);
    if (holding.has(url)) return new Promise((resolve) => (held[url] ??= []).push((a) => resolve(reply(a))));
    return Promise.resolve(reply(answers[url] ?? { status: 200, body: {} }));
  },
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));

import { EmailSendBlockers, forgetBlockersSeen } from "../EmailSendBlockers";
import { ChannelSettingsPanels } from "../EmailSettingsPanels";
import { REREAD_EVERY_MS } from "../useRereadWhileFailed";
import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";
import { gotoEmailSettings } from "../emailSettingsNav";

const TOOLS = "/api/workspace/email-test-lists";
const DOMAIN = "/api/workspace/sending-domain";
const TEMPLATE = "/api/workspace/email-template";

const MISSING = /No sending domain yet/;
const KLAVIYO_ROW = /Klaviyo test emails need a verified sending domain/;

const tool = (route: string, status: string, error: string | null = null) => ({ route, label: route, status, error, lists: [] });
const tools = (klaviyo: string, sendgrid = "not_connected", error: string | null = null) => ({
  routes: [tool("mailchimp", "not_connected"), tool("klaviyo", klaviyo, klaviyo === "unreadable" ? error : null), tool("sendgrid", sendgrid, sendgrid === "unreadable" ? error : null), tool("zavi_list", "complete")],
  orphans: [],
});
const domainState = (domain: unknown, suggested: string | null = null) => ({ domain, suggested_domain: suggested, can_manage: true, bulk_email_ready: true, postal_address_set: true });
const verified = { domain: "mail.acme.test", status: "verified", from_address: "hello@mail.acme.test", dns_records: [], last_error: null, verified_at: "2026-10-01T00:00:00Z" };

const set = (url: string, body: unknown, status = 200) => {
  answers[url] = { status, body };
};
const hold = (url: string) => holding.add(url);
const release = async (url: string, body: unknown, status = 200) => {
  holding.delete(url);
  set(url, body, status);
  const waiting = held[url] ?? [];
  delete held[url];
  await act(async () => {
    for (const r of waiting) r({ status, body });
    await Promise.resolve();
  });
};
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const rows = () => screen.queryAllByTestId("email-send-blocker").map((b) => b.getAttribute("data-blocker"));
const page = () => document.body.textContent ?? "";

beforeEach(() => {
  calls.length = 0;
  holding.clear();
  for (const k of Object.keys(answers)) delete answers[k];
  for (const k of Object.keys(held)) delete held[k];
  forgetEmailTestLists();
  forgetBlockersSeen();
  set(TEMPLATE, { template: { postal_address: "1 Main St, Springfield" }, fonts: [], can_edit: true });
  set("/api/channels/email_marketing/settings", { fields: {} });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Before you send never calls the domain missing until a read proves it", () => {
  it("shows nothing while the tool read is pending even though the domain read already answered none", async () => {
    set(DOMAIN, domainState(null));
    hold(TOOLS);
    render(<EmailSendBlockers />);
    await settle();
    expect(screen.queryByTestId("email-send-blockers")).toBeNull();
    await release(TOOLS, tools("not_connected"));
    await waitFor(() => expect(rows()).toEqual(["domain"]));
    expect(page()).toMatch(MISSING);
  });

  it("shows nothing while the domain read is pending even though the tools already answered", async () => {
    set(TOOLS, tools("complete"));
    hold(DOMAIN);
    render(<EmailSendBlockers />);
    await settle();
    expect(screen.queryByTestId("email-send-blockers")).toBeNull();
    await release(DOMAIN, domainState(verified));
    await settle();
    expect(screen.queryByTestId("email-send-blockers")).toBeNull();
  });

  it("the founder's path: Klaviyo timed out on the first read, so Zavi says it could not check, and the row is gone once Klaviyo answers", async () => {
    set(DOMAIN, domainState(null));
    set(TOOLS, tools("unreadable", "not_connected", "Klaviyo did not answer in time. Try again in a minute."));
    render(<EmailSendBlockers />);
    const row = await screen.findByTestId("email-send-blockers-unchecked");
    expect(row.textContent).toContain("could not check");
    expect(page()).not.toMatch(MISSING);
    expect(page()).not.toMatch(KLAVIYO_ROW);
    expect(rows()).toEqual([]);

    set(DOMAIN, domainState(verified));
    set(TOOLS, tools("complete"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("email-send-blockers")).toBeNull());
  });

  it("a SendGrid read that failed beside a working Klaviyo does not claim Klaviyo needs a domain, until SendGrid proves absent", async () => {
    set(DOMAIN, domainState(null));
    set(TOOLS, tools("complete", "unreadable", "SendGrid could not be read right now."));
    render(<EmailSendBlockers />);
    await screen.findByTestId("email-send-blockers-unchecked");
    expect(page()).not.toMatch(KLAVIYO_ROW);

    set(TOOLS, tools("complete", "not_connected"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rows()).toEqual(["klaviyo-domain"]));
    expect(screen.queryByTestId("email-send-blockers-unchecked")).toBeNull();
  });

  it("a failed domain read says it could not check, then a successful read showing none raises the real row", async () => {
    set(DOMAIN, { error: { message: "down" } }, 500);
    set(TOOLS, tools("complete"));
    render(<EmailSendBlockers />);
    await screen.findByTestId("email-send-blockers-unchecked");
    expect(page()).not.toMatch(KLAVIYO_ROW);
    expect(page()).not.toMatch(MISSING);

    set(DOMAIN, domainState(null));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rows()).toEqual(["klaviyo-domain"]));
  });

  it("a failed tools read beside an unverified domain raises no domain row at all", async () => {
    set(DOMAIN, domainState({ ...verified, status: "pending" }));
    set(TOOLS, { error: { message: "down" } }, 500);
    render(<EmailSendBlockers />);
    await screen.findByTestId("email-send-blockers-unchecked");
    expect(rows()).toEqual([]);
  });

  it.each([[{}], [{ suggested_domain: null, can_manage: true }]])("a 200 with no domain field (%j) is not proof", async (body) => {
    set(DOMAIN, body);
    set(TOOLS, tools("complete"));
    render(<EmailSendBlockers />);
    await screen.findByTestId("email-send-blockers-unchecked");
    expect(rows()).toEqual([]);
  });

  it("a 200 with no routes array is not proof", async () => {
    set(DOMAIN, domainState(null));
    set(TOOLS, {});
    render(<EmailSendBlockers />);
    await screen.findByTestId("email-send-blockers-unchecked");
    expect(rows()).toEqual([]);
  });

  it("a domain the founder already saved is named, not called missing", async () => {
    set(DOMAIN, domainState(null, "brightloop.test"));
    set(TOOLS, tools("not_connected"));
    render(<EmailSendBlockers />);
    await waitFor(() => expect(rows()).toEqual(["domain"]));
    expect(page()).toContain("brightloop.test is saved but not verified yet");
    expect(page()).not.toMatch(MISSING);
  });

  it("a rejected Klaviyo key is a proven answer: the key row and the no-domain row both stay, with no could-not-check row", async () => {
    set(DOMAIN, domainState(null));
    set(TOOLS, tools("unreadable", "not_connected", "Klaviyo rejected the key Zavi has saved."));
    render(<EmailSendBlockers />);
    await waitFor(() => expect(rows()).toEqual(["key:klaviyo", "domain"]));
    expect(screen.queryByTestId("email-send-blockers-unchecked")).toBeNull();
  });

  it("does not stack re-reads over a slow read, which would throw each one away before it landed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    set(DOMAIN, domainState(null));
    set(TOOLS, tools("unreadable", "not_connected", "Klaviyo did not answer in time."));
    render(<EmailSendBlockers />);
    await screen.findByTestId("email-send-blockers-unchecked");
    const reads = () => calls.filter((c) => c === TOOLS).length;
    hold(TOOLS);
    await act(async () => void vi.advanceTimersByTime(REREAD_EVERY_MS));
    await settle();
    expect(reads()).toBe(2);
    await act(async () => void vi.advanceTimersByTime(REREAD_EVERY_MS * 3));
    await settle();
    expect(reads()).toBe(2);
    await release(TOOLS, tools("complete"));
    await waitFor(() => expect(rows()).toEqual(["klaviyo-domain"]));
  });
});

describe("Settings > Sending does not hold the domain behind the email tool read", () => {
  const open = () => {
    gotoEmailSettings("sending");
    render(<ChannelSettingsPanels panels={["email_sending_domain", "email_sendgrid"]} />);
  };
  const box = () => within(screen.getByTestId("sending-domain"));

  it("a saved domain shows straight away while the tool row is still loading", async () => {
    set(DOMAIN, domainState(verified));
    hold(TOOLS);
    open();
    expect(await screen.findByText("hello@mail.acme.test")).toBeTruthy();
    await release(TOOLS, tools("complete"));
    await settle();
    expect(screen.getByText("hello@mail.acme.test")).toBeTruthy();
    expect(calls.filter((c) => c === DOMAIN)).toHaveLength(1);
  });

  it("no domain stays a neutral placeholder until the tool read lands, with no Not set up pill and no form", async () => {
    set(DOMAIN, domainState(null));
    hold(TOOLS);
    open();
    await settle();
    expect(screen.getByTestId("sending-domain")).toBeTruthy();
    expect(box().queryByText("Not set up")).toBeNull();
    expect(box().queryByRole("button", { name: "Add domain" })).toBeNull();
    expect(page()).not.toMatch(/can't send until/);
    await release(TOOLS, tools("complete"));
    expect(await box().findByText("Not set up")).toBeTruthy();
    expect(box().getByRole("button", { name: "Add domain" })).toBeTruthy();
    expect(calls.filter((c) => c === DOMAIN)).toHaveLength(1);
  });

  it("a failed domain read says so, whatever the tool read is doing", async () => {
    set(DOMAIN, { error: { message: "We could not read your sending domain. Try again." } }, 500);
    hold(TOOLS);
    open();
    expect(await screen.findByText(/could not read your sending domain/)).toBeTruthy();
    expect(box().queryByText("Not set up")).toBeNull();
  });
});
