// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown; offline?: boolean }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: {} };
    if (r.offline) return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a data-soft-nav="true" href={href} className={className}>{children}</a> }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { EmailAutoSendBlock, EmailSendgridBlock, EmailTemplateBlock } from "../EmailCampaignSettingsBlocks";
import { EmailTestListsBlock, TEST_LIST_COPY } from "../EmailTestListsBlock";
import { gotoEmailSettings } from "../emailSettingsNav";
import { ChannelSettingsPanels } from "../EmailSettingsPanels";
import { LEARNINGS_COPY } from "../EmailLearningsBlock";
import { EMAIL_CONNECT_COPY, email_marketing } from "../../actions/platforms/email_marketing";

const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};
const posts = (url: string) => calls.filter((c) => c.method === "POST" && c.url === url);
const puts = () => calls.filter((c) => c.method === "PUT");

const route = (r: string, label: string, status: string, lists: unknown[]) => ({ route: r, label, status, error: null, lists });
const list = (id: string, name: string, people: number | null, over: Record<string, unknown> = {}) => ({ id, name, people, marked: false, looks_like_test: false, ...over });

const TEST_LISTS = {
  routes: [
    route("mailchimp", "Mailchimp", "complete", [list("L1", "Customers", 1200), list("L2", "Internal test", 3, { marked: true })]),
    route("klaviyo", "Klaviyo", "not_connected", []),
    route("sendgrid", "SendGrid", "not_connected", []),
    route("zavi_list", "Zavi lists", "complete", [list("Z1", "Members", 40)]),
  ],
  orphans: [],
};

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  ws.role = "owner";
  set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: false }] });
  set("GET /api/workspace/email-test-lists", TEST_LISTS);
  set("GET /api/workspace/email-template", { template: null, fonts: ["system"], can_edit: true });
  set("GET /api/workspace/email-learnings", { items: [], dismissed: 0, state: { last_run_at: null, full_skipped: 0, kept_stronger: 0, sources: {}, seeded_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" } });
  set("GET /api/workspace/sendgrid/senders", { senders: [{ id: "41", from_email: "hello@northwind.test", from_name: "Northwind", verified: true }, { id: "43", from_email: "news@northwind.test", from_name: null, verified: true }] });
  set("GET /api/workspace/sendgrid/suppression-groups", { groups: [{ id: "7", name: "Patient news", is_default: true }, { id: "8", name: "Offers", is_default: false }] });
  set("GET /api/channels/email_marketing/settings", { fields: { sendgrid_sender_id: [{ item: "41" }], sendgrid_suppression_group_id: [{ item: "7" }] } });
  set("GET /api/workspace/email-lists", { lists: [] });
  set("GET /api/workspace/sending-domain", { domain: null, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true });
});
afterEach(cleanup);

describe("fix 1: Auto send asks before it turns on", () => {
  it("names the lists it covers and that unreviewed drafts will send; Cancel sends nothing, confirm turns it on", async () => {
    render(
      <>
        <ConfirmDialogHost />
        <EmailAutoSendBlock />
      </>,
    );
    const sw = (await screen.findByRole("switch")) as HTMLInputElement;
    fireEvent.click(sw);
    const dialog = await screen.findByRole("alertdialog");
    expect(posts("/api/workspace/growth/channels/email_marketing/autorun")).toHaveLength(0);
    const text = dialog.textContent ?? "";
    expect(text).toMatch(/Members/);
    expect(text).toMatch(/Zavi lists/);
    expect(text).toMatch(/nobody has reviewed/);
    expect(text).toMatch(/1,000 people/);
    expect(text).not.toMatch(/Internal test/);
    expect(within(dialog).getByText("Customers").closest("li")!.textContent).toMatch(/over 1,000/i);
    expect(within(within(dialog).getByRole("region", { name: "Waits for your approval" })).getByText("Customers")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(posts("/api/workspace/growth/channels/email_marketing/autorun")).toHaveLength(0);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("switch"));
    const confirmTurnOn = within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Allow Autopilot to send" });
    set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: true }] });
    const before = calls.length;
    fireEvent.click(confirmTurnOn);
    await waitFor(() => expect(posts("/api/workspace/growth/channels/email_marketing/autorun")).toHaveLength(1));
    expect(posts("/api/workspace/growth/channels/email_marketing/autorun")[0].body).toEqual({ autorun: true });
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
    expect(calls.slice(before).map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/workspace/growth/channels/email_marketing/autorun",
      "GET /api/workspace/growth/plan",
    ]);
  });

  it("turning it off needs no confirm", async () => {
    set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: true }] });
    render(
      <>
        <ConfirmDialogHost />
        <EmailAutoSendBlock />
      </>,
    );
    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() => expect(posts("/api/workspace/growth/channels/email_marketing/autorun")).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts("/api/workspace/growth/channels/email_marketing/autorun")[0].body).toEqual({ autorun: false });
  });
});

const headings = (root: HTMLElement) => [...root.querySelectorAll("h3, h4")].map((h) => h.textContent);

const SECTION_KEY: Record<string, string> = { Contacts: "contacts", Sending: "sending", Footer: "footer", Autopilot: "autopilot", Brand: "brand", "Zavi's notes": "notes" };
const navOrder = () => [...document.querySelectorAll<HTMLElement>("[data-settings-section]")].map((el) => Object.keys(SECTION_KEY).find((k) => SECTION_KEY[k] === el.dataset.settingsSection));
const sectionNamed = (name: string) => document.querySelector<HTMLElement>(`[data-settings-section="${SECTION_KEY[name]}"]`)!;
const inSection = (name: string) => headings(sectionNamed(name));
const toolRows = () =>
  within(screen.getByTestId("email-route"))
    .getAllByTestId("email-route-tool")
    .map((li) => [li.querySelector("span.font-semibold")?.textContent, within(li as HTMLElement).getByTestId("email-route-status").textContent]);

const renderAtSending = () => {
  gotoEmailSettings("sending");
  return render(<ChannelSettingsPanels panels={email_marketing.settingsPanels!} />);
};

describe("fix 4: Settings read as sections, only the route in use open", () => {
  const SECTIONS = ["Contacts", "Sending", "Footer", "Autopilot", "Brand", "Zavi's notes"];

  it("a Mailchimp founder: the six sections in order; Sending names the tool and keeps the domain as a quiet Set up row", async () => {
    set("GET /api/workspace/email-test-lists", { routes: [TEST_LISTS.routes[0], TEST_LISTS.routes[1], TEST_LISTS.routes[2], route("zavi_list", "Zavi lists", "complete", [])], orphans: [] });
    renderAtSending();
    const setUp = await screen.findByRole("button", { name: "Set up" });
    for (const c of ["border", "border-rule", "bg-white", "cursor-pointer", "hover:border-inkLight", "hover:bg-creamDeep"]) expect(setUp.classList.contains(c), c).toBe(true);
    expect(navOrder()).toEqual(SECTIONS);
    expect(inSection("Sending")).toEqual(["Email tool", "Sending domain"]);
    expect(toolRows()).toEqual([["Mailchimp", "Sends your campaigns"]]);
    expect(screen.queryByText(/Sending through/)).toBeNull();
    expect(screen.queryByText(/Zavi also sends for you/)).toBeNull();
    expect(inSection("Autopilot")).toEqual(["Send without asking", "Test lists"]);
    expect(inSection("Brand")).toEqual([]);
    expect(within(sectionNamed("Brand")).getByLabelText("Logo link")).toBeTruthy();
    expect(inSection("Zavi's notes")).toEqual([LEARNINGS_COPY.title]);
    expect(screen.queryByRole("heading", { name: "SendGrid sender" })).toBeNull();
    expect(screen.getByText("Only needed when Zavi sends for you.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add domain" })).toBeNull();
    expect(setUp.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(setUp);
    expect(await screen.findByRole("button", { name: "Add domain" })).toBeTruthy();
    expect(screen.queryByText("Only needed when Zavi sends for you.")).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Sending domain" })).toHaveLength(1);
  });

  it("a Klaviyo-only founder: the sending domain sits open in Sending, not folded behind 'Only needed when Zavi sends for you'", async () => {
    set("GET /api/workspace/email-test-lists", { routes: [route("mailchimp", "Mailchimp", "not_connected", []), route("klaviyo", "Klaviyo", "complete", []), route("sendgrid", "SendGrid", "not_connected", []), route("zavi_list", "Zavi lists", "complete", [])], orphans: [] });
    renderAtSending();
    expect(await screen.findByRole("button", { name: "Add domain" })).toBeTruthy();
    expect(toolRows()).toEqual([["Klaviyo", "Sends your campaigns"]]);
    expect(screen.queryByText("Only needed when Zavi sends for you.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
    expect(calls.some((c) => c.url === "/api/workspace/sending-domain")).toBe(true);
  });

  it("Zavi's notes lists Who you email before what Zavi learned, inside the notes card", async () => {
    render(<ChannelSettingsPanels panels={["email_learnings"]} extra={<h4>Who you email</h4>} />);
    await screen.findByRole("heading", { name: LEARNINGS_COPY.title });
    expect(inSection("Zavi's notes")).toEqual(["Who you email", LEARNINGS_COPY.title]);
    expect(screen.getByTestId("email-who-you-email").closest("[data-settings-section]")?.getAttribute("data-settings-section")).toBe("notes");
  });

  it("a founder with no tool: Zavi sends, so the domain sits open in Sending, nothing folded", async () => {
    set("GET /api/workspace/email-test-lists", { routes: [route("mailchimp", "Mailchimp", "not_connected", []), route("sendgrid", "SendGrid", "not_connected", []), route("zavi_list", "Zavi lists", "complete", [])], orphans: [] });
    renderAtSending();
    await waitFor(() => expect(screen.getByRole("button", { name: "Add domain" })).toBeTruthy());
    expect(navOrder()).toEqual(SECTIONS);
    expect(inSection("Sending")).toEqual(["Email tool", "Sending domain"]);
    expect(toolRows()).toEqual([["Zavi", "Sends to the lists in Contacts"]]);
    expect(screen.getByTestId("email-route-tool").querySelector("img")?.getAttribute("src")).toBe("/zavi-icon.svg");
    const connect = within(screen.getByTestId("email-route")).getByRole("link", { name: "Connect it" });
    expect(connect.getAttribute("href")).toBe("/workspace?tab=brain#integrations");
    expect(connect.parentElement?.textContent).toBe("Already use Mailchimp, Klaviyo or SendGrid? Connect it");
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  });

  it("a SendGrid founder sees the SendGrid block in Sending", async () => {
    set("GET /api/workspace/email-test-lists", { routes: [route("sendgrid", "SendGrid", "complete", [list("S1", "Guests", 400)]), route("zavi_list", "Zavi lists", "complete", [])], orphans: [] });
    renderAtSending();
    await waitFor(() => expect(screen.getByRole("heading", { name: "SendGrid sender" })).toBeTruthy());
    expect(inSection("Sending").slice(0, 2)).toEqual(["Email tool", "SendGrid sender"]);
    expect(toolRows()).toEqual([["SendGrid", "Sends your campaigns"]]);
  });

  it("every section is on the page at once, each with one anchor a goto can scroll to", async () => {
    renderAtSending();
    await screen.findByRole("heading", { name: "Footer" });
    expect(document.querySelectorAll("#email-settings-footer")).toHaveLength(1);
    expect(document.querySelectorAll("#email-settings-sending")).toHaveLength(1);
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
    expect(document.querySelector("[data-settings-section][hidden]")).toBeNull();
  });

  it("shows each tool as a compact tile with its logo and a green tick, and a problem with a warning, never a tick", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [route("sendgrid", "SendGrid", "complete", []), { ...route("mailchimp", "Mailchimp", "unreadable", []), error: "down" }, route("zavi_list", "Zavi lists", "complete", [])],
      orphans: [],
    });
    renderAtSending();
    const block = screen.getByTestId("email-route");
    const problem = await within(block).findByTestId("email-route-problem");
    const tiles = within(block).getAllByTestId("email-route-tool");
    const logos = tiles.map((t) => t.querySelector("img")?.getAttribute("src"));
    expect(logos).toEqual(["/logos/sendgrid-icon.svg"]);
    for (const tile of tiles) {
      const status = within(tile).getByTestId("email-route-status");
      expect(status.className).toContain("text-success");
      expect(status.querySelector("svg")).toBeTruthy();
    }
    const bad = within(problem).getByTestId("email-route-status");
    expect(bad.className).toContain("text-danger");
    expect(bad.className).not.toContain("text-success");
    expect(problem.querySelector("img")?.getAttribute("src")).toBe("/logos/mailchimp-icon.svg");
  });

  it("an unreadable provider is not called connected and never hides the Zavi setup path", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [
        { ...route("sendgrid", "SendGrid", "unreadable", []), error: "SendGrid could not be read right now. Try again in a minute." },
        route("zavi_list", "Zavi lists", "complete", []),
      ],
      orphans: [],
    });
    renderAtSending();
    const problem = await within(screen.getByTestId("email-route")).findByTestId("email-route-problem");
    expect(within(problem).getByText("SendGrid")).toBeTruthy();
    expect(within(problem).getByText("Can't reach it right now")).toBeTruthy();
    expect(within(problem).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/Try again in a minute/)).toBeNull();
    expect(within(screen.getByTestId("email-route")).queryAllByTestId("email-route-tool").map((r) => r.textContent)).not.toContain("SendGridSends your campaigns");
    expect(screen.getByRole("heading", { name: "Sending domain" })).toBeTruthy();
  });

  it("a SendGrid key that needs more permissions shows a problem row with Reconnect, not a green Zavi row or the Connect it line", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [route("sendgrid", "SendGrid", "needs_permissions", []), route("zavi_list", "Zavi lists", "complete", [])],
      orphans: [],
    });
    renderAtSending();
    const block = screen.getByTestId("email-route");
    const problem = await within(block).findByTestId("email-route-problem");
    expect(within(problem).getByText("SendGrid")).toBeTruthy();
    expect(within(problem).getByText("Its key is missing permissions campaigns need")).toBeTruthy();
    expect(within(problem).getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe("/workspace?tab=brain#connector-email");
    expect(within(block).queryByTestId("email-route-tool")).toBeNull();
    expect(within(block).queryByText(/Sends to the lists in Contacts/)).toBeNull();
    expect(within(block).queryByRole("link", { name: "Connect it" })).toBeNull();
  });

  it("Reconnect does a full page load, because the workspace reads ?tab= only on load and a soft link leaves the founder where they are", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [{ ...route("sendgrid", "SendGrid", "unreadable", []), error: "SendGrid rejected the key Zavi has saved for this workspace." }, route("zavi_list", "Zavi lists", "complete", [])],
      orphans: [],
    });
    renderAtSending();
    const problem = await within(screen.getByTestId("email-route")).findByTestId("email-route-problem");
    const link = within(problem).getByRole("link", { name: "Reconnect" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=brain#connector-email");
    expect(link.hasAttribute("data-soft-nav")).toBe(false);
  });

  it("every rejected key's Reconnect opens that tool on the live Connectors page, never the retired /connectors", async () => {
    const dead = (id: string, name: string) => ({ ...route(id, name, "unreadable", []), error: `${name} rejected the key Zavi has saved for it (it was revoked or is no longer valid). Waiting will not fix this.` });
    set("GET /api/workspace/email-test-lists", {
      routes: [dead("sendgrid", "SendGrid"), dead("mailchimp", "Mailchimp"), dead("klaviyo", "Klaviyo"), route("zavi_list", "Zavi lists", "complete", [])],
      orphans: [],
    });
    renderAtSending();
    const rows = await within(screen.getByTestId("email-route")).findAllByTestId("email-route-problem");
    const links = rows.map((r) => [r.querySelector("span.font-semibold")?.textContent, within(r).getByRole("link", { name: "Reconnect" }).getAttribute("href")]);
    expect(links).toEqual([
      ["SendGrid", "/workspace?tab=brain#connector-email"],
      ["Mailchimp", "/workspace?tab=brain&q=Mailchimp#integrations"],
      ["Klaviyo", "/workspace?tab=brain&q=Klaviyo#integrations"],
    ]);
    for (const a of within(screen.getByTestId("email-route")).getAllByRole("link")) expect(a.getAttribute("href")).not.toMatch(/^\/connectors/);
  });

  it("two tool problems are two short rows, a rejected key says to reconnect, and one Retry rereads fresh", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [
        { ...route("klaviyo", "Klaviyo", "unreadable", []), error: "Klaviyo could not be read right now. Try again in a minute." },
        { ...route("sendgrid", "SendGrid", "unreadable", []), error: "SendGrid rejected the key Zavi has saved for it (it was revoked or is no longer valid). Waiting will not fix this." },
        route("zavi_list", "Zavi lists", "complete", []),
      ],
      orphans: [],
    });
    renderAtSending();
    const block = screen.getByTestId("email-route");
    const rows = await within(block).findAllByTestId("email-route-problem");
    expect(rows.map((r) => r.textContent)).toEqual(["KlaviyoCan't reach it right nowTry again", "SendGridIts key stopped workingReconnect"]);
    expect(within(block).queryByText(/Waiting will not fix this/)).toBeNull();
    expect(within(rows[1]).queryByRole("button")).toBeNull();
    expect(within(rows[1]).getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe("/workspace?tab=brain#connector-email");
    expect(within(block).queryByRole("button", { name: "Retry" })).toBeNull();
    const retries = within(block).getAllByRole("button", { name: "Try again" });
    expect(retries).toHaveLength(1);
    expect(rows[0].contains(retries[0])).toBe(true);
    const before = calls.filter((c) => c.url.startsWith("/api/workspace/email-test-lists")).length;
    fireEvent.click(retries[0]);
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith("/api/workspace/email-test-lists")).length).toBeGreaterThan(before));
  });

  it("the Zavi row sits between working tools and problem tools", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [
        route("mailchimp", "Mailchimp", "complete", [list("L1", "Customers", 10)]),
        { ...route("klaviyo", "Klaviyo", "unreadable", []), error: "Klaviyo could not be read right now." },
        route("zavi_list", "Zavi lists", "complete", [list("Z1", "Members", 40)]),
      ],
      orphans: [],
    });
    renderAtSending();
    await within(screen.getByTestId("email-route")).findByTestId("email-route-problem");
    expect(within(screen.getByTestId("email-route")).getAllByRole("listitem").map((li) => li.querySelector("span.font-semibold")?.textContent)).toEqual(["Mailchimp", "Zavi", "Klaviyo"]);
  });

  it("a route read failure shows Retry instead of inventing a setup state", async () => {
    set("GET /api/workspace/email-test-lists", { error: { message: "Email setup could not be loaded." } }, 500);
    renderAtSending();
    const routePanel = await screen.findByTestId("email-route");
    const alert = await within(routePanel).findByRole("alert");
    expect(alert.textContent).toMatch(/Email setup could not be loaded/);
    const retry = within(alert).getByRole("button", { name: "Try again" });
    expect(within(routePanel).getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Sending domain" })).toBeNull();
    set("GET /api/workspace/email-test-lists", TEST_LISTS);
    const reads = calls.filter((call) => call.method === "GET" && call.url === "/api/workspace/email-test-lists").length;
    fireEvent.click(retry);
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.url === "/api/workspace/email-test-lists").length).toBeGreaterThan(reads));
    expect(await screen.findByRole("heading", { name: "Sending domain" })).toBeTruthy();
  });

  it("a route read 500 with no readable reason names what failed, with one Try again that reads again and clears it", async () => {
    set("GET /api/workspace/email-test-lists", { error: "boom" }, 500);
    renderAtSending();
    const routePanel = await screen.findByTestId("email-route");
    const alert = await within(routePanel).findByRole("alert");
    expect(alert.textContent).toBe("Could not check which email tool sends your campaigns.Try again");
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(within(routePanel).getAllByRole("button")).toHaveLength(1);
    set("GET /api/workspace/email-test-lists", TEST_LISTS);
    const reads = calls.filter((call) => call.method === "GET" && call.url === "/api/workspace/email-test-lists").length;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(screen.getByTestId("email-route")).getAllByTestId("email-route-tool").map((r) => r.textContent?.split("Sends")[0])).toContain("Mailchimp"));
    expect(calls.filter((call) => call.method === "GET" && call.url === "/api/workspace/email-test-lists").length).toBe(reads + 1);
    expect(within(screen.getByTestId("email-route")).queryByRole("alert")).toBeNull();
  });

  it("a route read network failure still says Zavi could not be reached", async () => {
    routes["GET /api/workspace/email-test-lists"] = { status: 0, body: null, offline: true };
    renderAtSending();
    const alert = await within(await screen.findByTestId("email-route")).findByRole("alert");
    expect(alert.textContent).toBe("We could not reach Zavi. Check your connection and try again.Try again");
  });
});

describe("fix 5: one postal address, no hand-picked sending tool", () => {
  it("the channel row no longer asks for a postal address or 'Where you send from'", () => {
    const ids = (email_marketing.settings ?? []).map((s) => s.id);
    expect(ids).not.toContain("postal_address");
    expect(ids).not.toContain("esp");
  });
});

describe("fix 3: test-list picker keeps real audiences apart", () => {
  const SG = {
    routes: [
      route("sendgrid", "SendGrid", "complete", [
        list("G1", "guests_only_prod", 11388),
        list("G2", "qa_seed", 3, { looks_like_test: true }),
        list("G3", "staff", 12),
      ]),
    ],
    orphans: [],
  };

  it("groups test-looking lists apart from real audiences, with the size shown on its own", async () => {
    set("GET /api/workspace/email-test-lists", SG);
    render(<EmailTestListsBlock />);
    const real = await screen.findByRole("group", { name: /Real audiences/ });
    const test = screen.getByRole("group", { name: /Look like test lists/ });
    expect(within(real).getByText("guests_only_prod")).toBeTruthy();
    expect(within(real).getByText("11,388 people")).toBeTruthy();
    expect(within(real).queryByText("qa_seed")).toBeNull();
    expect(within(test).getByText("qa_seed")).toBeTruthy();
  });

  it("marking a real audience asks first, whatever its size; Cancel leaves it a real audience; a test-looking list marks at once", async () => {
    set("GET /api/workspace/email-test-lists", SG);
    set("POST /api/workspace/email-test-lists", { ok: true, changed: true, marked: true });
    render(
      <>
        <ConfirmDialogHost />
        <EmailTestListsBlock />
      </>,
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: /guests_only_prod/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/11,388/);
    expect(posts("/api/workspace/email-test-lists")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(posts("/api/workspace/email-test-lists")).toHaveLength(0);
    expect((screen.getByRole("checkbox", { name: /guests_only_prod/ }) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("checkbox", { name: /qa_seed/ }));
    await waitFor(() => expect(posts("/api/workspace/email-test-lists")).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts("/api/workspace/email-test-lists")[0].body).toEqual({ route: "sendgrid", list_id: "G2", marked: true });

    fireEvent.click(screen.getByRole("checkbox", { name: /guests_only_prod/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Mark as a test list" }));
    await waitFor(() => expect(posts("/api/workspace/email-test-lists")).toHaveLength(2));
    expect(posts("/api/workspace/email-test-lists")[1].body).toEqual({ route: "sendgrid", list_id: "G1", marked: true });
  });
});

describe("fix 9: SendGrid sender and group", () => {
  it("a failed group save reloads the authoritative saved values instead of claiming a rollback", async () => {
    set("PUT /api/channels/email_marketing/settings/sendgrid_suppression_group_id", { error: { message: "down" } }, 500);
    render(<EmailSendgridBlock />);
    const sender = (await screen.findByLabelText("Send from")) as HTMLSelectElement;
    await waitFor(() => expect(sender.value).toBe("41"));
    fireEvent.change(sender, { target: { value: "43" } });
    fireEvent.change(screen.getByLabelText("Unsubscribe group"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts().map((c) => [c.url.split("/").pop(), c.body])).toEqual([
      ["sendgrid_sender_id", { items: ["43"] }],
      ["sendgrid_suppression_group_id", { items: ["8"] }],
    ]);
    expect(await screen.findByText(/current saved sender and group are shown/)).toBeTruthy();
    expect((screen.getByLabelText("Send from") as HTMLSelectElement).value).toBe("41");
    expect(screen.queryByText(/^Saved/)).toBeNull();
  });

  it("while the role is still loading nothing can be edited", async () => {
    ws.role = null;
    render(<EmailSendgridBlock />);
    const sender = (await screen.findByLabelText("Send from")) as HTMLSelectElement;
    expect(sender.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("not connected: a plain state with a Connect link, not the raw error", async () => {
    set("GET /api/workspace/sendgrid/senders", { error: { code: "sendgrid_not_connected", message: "sendgrid_not_connected: no key row" } }, 409);
    render(<EmailSendgridBlock />);
    expect(await screen.findByText("SendGrid is not connected.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect SendGrid" }).getAttribute("href")).toBe("/workspace?tab=brain#connector-email");
    expect(screen.queryByText(/no key row/)).toBeNull();
  });
});

describe("fix 10: every settings load error has Retry", () => {
  const cases: Array<[string, string, () => React.ReactElement<any>, RegExp]> = [
    ["SendGrid", "GET /api/workspace/sendgrid/senders", () => <EmailSendgridBlock />, /Send from/],
    ["template", "GET /api/workspace/email-template", () => <EmailTemplateBlock />, /Brand color/],
    ["Auto send", "GET /api/workspace/growth/plan", () => <EmailAutoSendBlock />, /^Off$/],
    ["test lists", "GET /api/workspace/email-test-lists", () => <EmailTestListsBlock />, /Members/],
  ];
  for (const [name, key, el, after] of cases) {
    it(`${name}: Retry reads again and shows the block`, async () => {
      const good = routes[key];
      set(key, { error: { message: "Zavi could not load this." } }, 500);
      render(el());
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
      await waitFor(() => expect(calls.filter((c) => `${c.method} ${c.url}` === key).length).toBeGreaterThanOrEqual(2));
      routes[key] = good;
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
      expect(await screen.findByText(after)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
  }
});

describe("fix 11: plain words", () => {
  it("test lists: no 'on any route', no raw list ids", async () => {
    expect(TEST_LIST_COPY.intro).not.toMatch(/route/);
    set("GET /api/workspace/email-test-lists", { routes: [route("mailchimp", "Mailchimp", "complete", [])], orphans: [{ route: "mailchimp", list_id: "a8f3c2e1d0", reason: "not_found", can_unmark: true, note: "Not found in the account connected now." }] });
    const { container } = render(<EmailTestListsBlock />);
    await screen.findByText(/Not found in the account connected now/);
    expect(container.textContent).not.toMatch(/a8f3c2e1d0/);
    expect(container.textContent).toMatch(/no longer in Mailchimp/);
  });

  it("learnings: no 'compared by code'; the connect blurb offers the three real choices", () => {
    expect(LEARNINGS_COPY.intro).not.toMatch(/by code/);
    expect(EMAIL_CONNECT_COPY.blurb).toMatch(/SendGrid, Mailchimp or Klaviyo/);
    expect(EMAIL_CONNECT_COPY.blurb).toMatch(/Zavi send it for you/);
    expect(EMAIL_CONNECT_COPY.blurb).toMatch(/copy/);
    expect(EMAIL_CONNECT_COPY.blurb).not.toMatch(/Gmail/);
  });
});

describe("Sending row at phone width", () => {
  it("a SendGrid problem's reason wraps below sm instead of cutting off, and only truncates from sm up", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [
        { ...route("sendgrid", "SendGrid", "unreadable", []), error: "SendGrid rejected the key Zavi has saved for it (it was revoked or is no longer valid). Waiting will not fix this." },
        route("zavi_list", "Zavi lists", "complete", []),
      ],
      orphans: [],
    });
    renderAtSending();
    const row = await within(screen.getByTestId("email-route")).findByTestId("email-route-problem");
    const reason = within(row).getByText("Its key stopped working");
    const cls = reason.className.split(/\s+/);
    expect(cls).not.toContain("truncate");
    expect(cls).not.toContain("whitespace-nowrap");
    expect(cls).toContain("break-words");
    expect(cls).toContain("min-w-0");
    expect(cls.filter((c) => /truncate|nowrap|overflow-hidden|text-ellipsis/.test(c)).every((c) => c.startsWith("sm:"))).toBe(true);
  });
});
