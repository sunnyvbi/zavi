// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, act, fireEvent } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};

const calls: string[] = [];
const routes: Record<string, unknown> = {};
const failures = new Set<string>();
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const body = routes[url] ?? {};
    if (failures.has(url)) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { message: "down" } }) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  },
}));

import { EmailSendBlockers, forgetBlockersSeen } from "../EmailSendBlockers";
import { EMAIL_FOOTER_SAVED_EVENT, forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";

beforeEach(() => {
  calls.length = 0;
  failures.clear();
  for (const k of Object.keys(routes)) delete routes[k];
  forgetEmailTestLists();
  forgetBlockersSeen();
  routes["/api/workspace/email-template"] = { template: { postal_address: null }, fonts: [], can_edit: true };
  routes["/api/workspace/sending-domain"] = { domain: { domain: "mail.acme.test", status: "failed" }, suggested_domain: null };
  routes["/api/workspace/email-test-lists"] = { routes: [], orphans: [] };
});
afterEach(cleanup);

describe("EmailSendBlockers", () => {
  it("fades in the first time it shows and not again when Overview is opened a second time", async () => {
    const first = render(<EmailSendBlockers />);
    const box = await screen.findByTestId("email-send-blockers");
    expect(box.className).toContain("animate-fade-in");
    expect(box.className).toContain("motion-reduce:animate-none");
    first.unmount();
    render(<EmailSendBlockers />);
    const again = await screen.findByTestId("email-send-blockers");
    expect(again.className).not.toMatch(/\banimate-/);
  });

  it("renders the blockers from template, domain and tools without ever reading the channel settings", async () => {
    render(<EmailSendBlockers />);
    await waitFor(() => expect(screen.getAllByTestId("email-send-blocker").map((b) => b.getAttribute("data-blocker"))).toEqual(["postal", "domain"]));
    expect(screen.getByText("mail.acme.test failed its DNS check")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event(EMAIL_FOOTER_SAVED_EVENT));
    });
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/workspace/email-template").length).toBe(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.includes("/api/channels/"))).toEqual([]);
    expect(new Set(calls)).toEqual(new Set(["GET /api/workspace/email-template", "GET /api/workspace/sending-domain", "GET /api/workspace/email-test-lists"]));
  });

  const KLAVIYO_ROW = "Klaviyo test emails need a verified sending domain or SendGrid";
  const tool = (route: string, status: string) => ({ route, label: route, status, error: null, lists: [] });
  const shown = async () => {
    render(<EmailSendBlockers />);
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/workspace/email-test-lists").length).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    return screen.queryAllByTestId("email-send-blocker").map((b) => [b.getAttribute("data-blocker"), b.textContent]);
  };

  it("a Klaviyo-only workspace with no sending domain is told it must verify one before testing and approving", async () => {
    routes["/api/workspace/email-template"] = { template: { postal_address: "1 Main St, Springfield, IL 62701" }, fonts: [], can_edit: true };
    routes["/api/workspace/sending-domain"] = { domain: null, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [tool("klaviyo", "complete"), tool("mailchimp", "not_connected"), tool("sendgrid", "not_connected"), tool("zavi_list", "complete")], orphans: [] };
    expect(await shown()).toEqual([["klaviyo-domain", `${KLAVIYO_ROW}Verify it in Sending`]]);
  });

  it.each([["complete"], ["partial"]])("Klaviyo with a %s SendGrid raises no domain row, because the test goes through the founder's own SendGrid", async (status) => {
    routes["/api/workspace/email-template"] = { template: { postal_address: "1 Main St, Springfield, IL 62701" }, fonts: [], can_edit: true };
    routes["/api/workspace/sending-domain"] = { domain: null, suggested_domain: null, can_manage: true, bulk_email_ready: false, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [tool("klaviyo", "complete"), tool("sendgrid", status), tool("mailchimp", "complete"), tool("zavi_list", "unreadable")], orphans: [] };
    expect(await shown()).toEqual([]);
  });

  it("a half-finished domain is no blocker for Klaviyo with SendGrid, but stays one for a Klaviyo-only workspace", async () => {
    routes["/api/workspace/email-template"] = { template: { postal_address: "1 Main St, Springfield, IL 62701" }, fonts: [], can_edit: true };
    routes["/api/workspace/sending-domain"] = { domain: { domain: "brightloop.test", status: "pending" }, suggested_domain: null, can_manage: true, bulk_email_ready: false, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [tool("klaviyo", "complete"), tool("sendgrid", "complete")], orphans: [] };
    expect(await shown()).toEqual([]);
  });

  it("Klaviyo with a verified domain is not blocked by Zavi's own bulk sender setting, which the founder cannot fix", async () => {
    routes["/api/workspace/email-template"] = { template: { postal_address: "1 Main St, Springfield, IL 62701" }, fonts: [], can_edit: true };
    routes["/api/workspace/sending-domain"] = { domain: { domain: "mail.acme.test", status: "verified" }, suggested_domain: null, can_manage: true, bulk_email_ready: false, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [tool("klaviyo", "partial")], orphans: [] };
    expect(await shown()).toEqual([]);
  });

  it.each([
    ["pending", "mail.acme.test is not verified yet"],
    ["failed", "mail.acme.test failed its DNS check"],
  ])("Klaviyo with a %s domain shows the one domain row, not a second Klaviyo row", async (status, text) => {
    routes["/api/workspace/email-template"] = { template: { postal_address: "1 Main St, Springfield, IL 62701" }, fonts: [], can_edit: true };
    routes["/api/workspace/sending-domain"] = { domain: { domain: "mail.acme.test", status }, suggested_domain: null, can_manage: true, bulk_email_ready: false, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [tool("klaviyo", "complete"), tool("zavi_list", "complete")], orphans: [] };
    expect(await shown()).toEqual([["domain", `${text}Verify it in Sending`]]);
  });

  it("a Mailchimp-only workspace with no sending domain shows no domain blocker, as before", async () => {
    routes["/api/workspace/email-template"] = { template: { postal_address: "1 Main St, Springfield, IL 62701" }, fonts: [], can_edit: true };
    routes["/api/workspace/sending-domain"] = { domain: null, suggested_domain: null, can_manage: true, bulk_email_ready: false, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [tool("mailchimp", "complete"), tool("klaviyo", "not_connected"), tool("sendgrid", "not_connected")], orphans: [] };
    expect(await shown()).toEqual([]);
  });

  const NO_DOMAIN_ROW = ["domain", "No sending domain yet, so Zavi can't send to your lists" + "Add one in Sending"];

  it("a connected Gmail does not stand in for a list sender: with no domain the no-domain blocker still shows", async () => {
    routes["/api/workspace/email-template"] = { template: { postal_address: "1 Main St, Springfield, IL 62701" }, fonts: [], can_edit: true };
    routes["/api/workspace/sending-domain"] = { domain: null, suggested_domain: null, can_manage: true, bulk_email_ready: false, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = {
      routes: [tool("sendgrid", "not_connected"), tool("mailchimp", "not_connected"), tool("klaviyo", "not_connected"), tool("zavi_list", "complete")],
      orphans: [],
      gmail: { status: "connected" },
    };
    expect(await shown()).toEqual([NO_DOMAIN_ROW]);
  });

  it("a connected SendGrid with no domain still hides the no-domain blocker, Gmail connected or not", async () => {
    routes["/api/workspace/email-template"] = { template: { postal_address: "1 Main St, Springfield, IL 62701" }, fonts: [], can_edit: true };
    routes["/api/workspace/sending-domain"] = { domain: null, suggested_domain: null, can_manage: true, bulk_email_ready: false, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [tool("sendgrid", "complete"), tool("mailchimp", "not_connected"), tool("klaviyo", "not_connected"), tool("zavi_list", "complete")], orphans: [], gmail: { status: "connected" } };
    expect(await shown()).toEqual([]);
    cleanup();
    calls.length = 0;
    forgetEmailTestLists();
    routes["/api/workspace/email-test-lists"] = { routes: [tool("sendgrid", "partial"), tool("zavi_list", "complete")], orphans: [], gmail: { status: "not_connected" } };
    expect(await shown()).toEqual([]);
  });
  const OK_TEMPLATE = { template: { postal_address: "1 Main St, Springfield, IL 62701" }, fonts: [], can_edit: true };

  it("a SendGrid key that only sends one-to-one mail (needs permissions) raises a reconnect blocker", async () => {
    routes["/api/workspace/email-template"] = OK_TEMPLATE;
    routes["/api/workspace/sending-domain"] = { domain: { domain: "mail.acme.test", status: "verified" }, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [{ route: "sendgrid", label: "SendGrid", status: "needs_permissions", error: "missing permissions", lists: [] }], orphans: [] };
    expect(await shown()).toEqual([["key:sendgrid", "SendGrid's saved key is missing permissions campaigns needReconnect in Sending"]]);
  });

  it.each([["mailchimp"], ["sendgrid"]])("a %s workspace whose Zavi lists could not be read is not shown a red domain row, since Settings calls the domain optional", async (route) => {
    routes["/api/workspace/email-template"] = OK_TEMPLATE;
    routes["/api/workspace/sending-domain"] = { domain: { domain: "mail.acme.test", status: "pending" }, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [tool(route, "complete"), tool("zavi_list", "unreadable")], orphans: [] };
    expect(await shown()).toEqual([]);
  });

  it.each([
    ["mailchimp", "complete", "pending", "mail.acme.test is not verified yet"],
    ["sendgrid", "complete", "failed", "mail.acme.test failed its DNS check"],
    ["sendgrid", "partial", "pending", "mail.acme.test is not verified yet"],
    ["mailchimp", "partial", "failed", "mail.acme.test failed its DNS check"],
  ])("a %s (%s) workspace that can also send to its Zavi lists keeps the %s domain row, since a Zavi list send is refused until it verifies", async (route, status, domainStatus, text) => {
    routes["/api/workspace/email-template"] = OK_TEMPLATE;
    routes["/api/workspace/sending-domain"] = { domain: { domain: "mail.acme.test", status: domainStatus }, suggested_domain: null, can_manage: true, bulk_email_ready: false, postal_address_set: true };
    routes["/api/workspace/email-test-lists"] = { routes: [tool(route, status), tool("klaviyo", "not_connected"), tool("zavi_list", "complete")], orphans: [] };
    expect(await shown()).toEqual([["domain", `${text}Verify it in Sending`]]);
  });

  const NEEDS_PERMS = ["key:sendgrid", "SendGrid's saved key is missing permissions campaigns needReconnect in Sending"];
  const PARTIAL_SENDGRID = { route: "sendgrid", label: "SendGrid", status: "needs_permissions", error: "missing permissions", lists: [] };
  const VERIFIED = { domain: { domain: "mail.acme.test", status: "verified" }, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };

  it.each([
    ["klaviyo", "complete"],
    ["klaviyo", "partial"],
    ["mailchimp", "complete"],
    ["mailchimp", "partial"],
  ])("a SendGrid key missing campaign permissions raises no reconnect row when %s (%s) already sends campaigns", async (route, status) => {
    routes["/api/workspace/email-template"] = OK_TEMPLATE;
    routes["/api/workspace/sending-domain"] = VERIFIED;
    routes["/api/workspace/email-test-lists"] = { routes: [PARTIAL_SENDGRID, tool(route, status), tool("zavi_list", "complete")], orphans: [] };
    expect(await shown()).toEqual([]);
  });

  it.each([["not_connected"], ["unreadable"]])("a SendGrid key missing campaign permissions still raises the reconnect row when Klaviyo and Mailchimp are %s", async (status) => {
    routes["/api/workspace/email-template"] = OK_TEMPLATE;
    routes["/api/workspace/sending-domain"] = VERIFIED;
    routes["/api/workspace/email-test-lists"] = { routes: [PARTIAL_SENDGRID, tool("klaviyo", status), tool("mailchimp", status), tool("zavi_list", "complete")], orphans: [] };
    expect(await shown()).toEqual([NEEDS_PERMS]);
  });

  it("when a read fails the section says so and offers Try again instead of vanishing, and Try again re-reads", async () => {
    routes["/api/workspace/email-template"] = OK_TEMPLATE;
    routes["/api/workspace/email-test-lists"] = { routes: [], orphans: [] };
    routes["/api/workspace/sending-domain"] = { domain: null, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };
    failures.add("/api/workspace/sending-domain");
    render(<EmailSendBlockers />);
    const row = await screen.findByTestId("email-send-blockers-unchecked");
    expect(row.textContent).toContain("could not check");
    failures.clear();
    looksLikeButton(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("email-send-blockers-unchecked")).toBeNull());
    expect(calls.filter((c) => c === "GET /api/workspace/sending-domain").length).toBe(2);
  });
});
