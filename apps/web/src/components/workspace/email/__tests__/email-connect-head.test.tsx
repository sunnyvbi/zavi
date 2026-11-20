// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};
import { useState } from "react";

type Call = { url: string; method: string; body?: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown; wait?: Promise<void>; offline?: boolean }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: { ok: true } };
    if (r.wait) await r.wait;
    if (r.offline) throw new TypeError("Failed to fetch");
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));
const composio = vi.hoisted(() => ({ start: vi.fn(() => Promise.resolve()) }));
vi.mock("@/app/connectors/composioConnect", () => ({ startComposioConnect: composio.start }));
vi.mock("../../settings/SendgridKeyForm", () => ({
  SendgridKeyForm: ({ onConnected }: { onConnected?: () => void }) => (
    <button type="button" onClick={onConnected}>
      Save SendGrid key
    </button>
  ),
}));
const lock = vi.hoisted(() => ({ value: null as null | { tierName: string | null; upgrade: () => void } }));
vi.mock("../../actions/channelPlanLock", () => ({ useChannelPlanLock: () => lock.value, upgradeOnPlanRefusal: () => false }));

import { EmailConnectTiles, forgetConnected } from "../EmailConnectTiles";
import { EmailSendingSwitch, forgetPaused } from "../EmailSendingSwitch";
import { EmailHeadTools } from "../EmailHeadTools";
import { ChannelPageHeaderSlotProvider } from "../../layout/ChannelHeaderRow";
import { EMAIL_SETTINGS_GOTO_EVENT } from "../emailSettingsNav";
import { EmailTestListsBlock } from "../EmailTestListsBlock";
import { NewCampaignDialog } from "../NewCampaignDialog";
import { longDay } from "../../ugc/DatePicker";
import { EMAIL_TEST_LISTS_FRESH_MS, forgetEmailTestLists, getEmailTestLists, SENDGRID_CONNECTED_EVENT } from "@/lib/workspace/emailCampaignSettingsApi";

const lists = (connected: string[]) => ({
  routes: [
    ...["sendgrid", "mailchimp", "klaviyo"].map((r) => ({ route: r, label: r, status: connected.includes(r) ? "complete" : "not_connected", error: null, lists: [] })),
    { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] },
  ],
  orphans: [],
});
const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};
const reads = () => calls.filter((c) => c.url === "/api/workspace/email-test-lists").length;
const TOOLS = ["mailchimp", "klaviyo", "gmail", "sendgrid"];
const tilesIn = (root: HTMLElement) => TOOLS.map((t) => within(root).getByTestId(`email-connect-${t}`));
const expectConnected = (root: HTMLElement, ids: string[]) => {
  expect(root.getAttribute("data-mode")).toBe("tiles");
  expect(tilesIn(root).filter((b) => b.getAttribute("data-state") === "connected").map((b) => b.getAttribute("data-testid"))).toEqual(ids.map((id) => `email-connect-${id}`));
  for (const id of ids) expect(within(root).getByTestId(`email-connect-${id}-state`).textContent).toBe("Connected");
};
const connectedTools = async (ids: string[], root?: () => HTMLElement) => {
  await waitFor(() => {
    for (const section of root ? [root()] : screen.getAllByTestId("email-connect")) expectConnected(section, ids);
  });
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  forgetConnected();
  forgetPaused();
  composio.start.mockClear();
  ws.role = "owner";
  lock.value = null;
  set("GET /api/workspace/email-test-lists", lists(["klaviyo"]));
  set("GET /api/workspace/email-pause", { paused: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const pickDayIn = (iso: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Day" }));
  const cell = within(screen.getByRole("dialog", { name: "Choose a day" })).getByRole("button", { name: longDay(iso)! }) as HTMLButtonElement;
  expect(cell.disabled).toBe(false);
  fireEvent.click(cell);
  expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
  expect(screen.getByRole("button", { name: "Day" }).textContent).toBe(longDay(iso));
};
const later = (ms: number) => {
  const real = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => real() + ms);
};

describe("Connect your email tool", () => {
  it("with no tool connected, shows Mailchimp, Klaviyo, Gmail and SendGrid in that order with logos and no subtitle", async () => {
    set("GET /api/workspace/email-test-lists", lists([]));
    render(<EmailConnectTiles />);
    const section = screen.getByTestId("email-connect");
    expect(within(section).getByRole("heading").textContent).toBe("Connect your email tool");
    expect(section.querySelectorAll("p").length).toBe(0);
    const mailchimp = await screen.findByRole("button", { name: "Connect Mailchimp" });
    expect(screen.getByTestId("email-connect").getAttribute("data-mode")).toBe("tiles");
    expect(mailchimp.querySelector("svg.lucide-arrow-up-right")).not.toBeNull();
    expect(mailchimp.querySelector("img")?.getAttribute("src")).toBe("/logos/mailchimp-icon.svg");
    const gmail = screen.getByRole("button", { name: "Connect Gmail" });
    expect(gmail.querySelector("img")?.getAttribute("src")).toBe("/logos/gmail-icon.svg");
    expect(gmail.querySelector("svg.lucide-arrow-up-right")).not.toBeNull();
    expect(gmail.textContent).toBe("GmailConnectOne-to-one emails only");
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("data-testid"))).toEqual(["email-connect-mailchimp", "email-connect-klaviyo", "email-connect-gmail", "email-connect-sendgrid"]);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["MailchimpConnect", "KlaviyoConnect", "GmailConnectOne-to-one emails only", "SendGridConnect"]);
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("Gmail reads Connected only when the backend found this workspace's Gmail, a connected Gmail reconnects through Composio, and Connect starts its Composio sign-in", async () => {
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    set("GET /api/workspace/email-test-lists", { ...lists([]), gmail: { status: "connected" } });
    render(<EmailConnectTiles />);
    await connectedTools(["gmail"]);
    fireEvent.click(screen.getByRole("button", { name: "Gmail, connected. Reconnect Gmail" }));
    expect(composio.start).toHaveBeenCalledTimes(1);
    expect(composio.start).toHaveBeenCalledWith("gmail");
    expect(goto).not.toHaveBeenCalled();
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    composio.start.mockClear();
    cleanup();
    forgetConnected();
    forgetEmailTestLists();
    set("GET /api/workspace/email-test-lists", { ...lists([]), gmail: { status: "not_connected" } });
    render(<EmailConnectTiles />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Gmail" }));
    expect(composio.start).toHaveBeenCalledWith("gmail");
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("a Gmail list read is never a Gmail tile: a response without a Gmail answer leaves Gmail as Connect, not Connected", async () => {
    set("GET /api/workspace/email-test-lists", { routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] }], orphans: [] });
    render(<EmailConnectTiles />);
    expect((await screen.findByTestId("email-connect-gmail-state")).textContent).toBe("Connect");
  });
});

describe("connected tools keep the full tiles", () => {
  it("with tools connected there is no one-line summary and no Manage link: the section stays in tiles mode with all four tile buttons", async () => {
    set("GET /api/workspace/email-test-lists", { ...lists(["mailchimp", "sendgrid"]), gmail: { status: "connected" } });
    render(<EmailConnectTiles withBlockers />);
    await connectedTools(["mailchimp", "gmail", "sendgrid"]);
    const section = screen.getByTestId("email-connect");
    expect(screen.queryByTestId("email-sending-with")).toBeNull();
    expect(screen.queryByTestId("email-connect-manage")).toBeNull();
    expect(screen.queryByText(/Sending with/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Manage/ })).toBeNull();
    expect(section.getAttribute("data-mode")).toBe("tiles");
    expect(within(section).getByRole("heading").textContent).toBe("Your email tools");
    expect(within(section).getAllByRole("button").map((b) => b.getAttribute("data-testid"))).toEqual(TOOLS.map((t) => `email-connect-${t}`));
    expect(within(section).getAllByRole("button").map((b) => b.textContent)).toEqual(["MailchimpConnected", "KlaviyoConnect", "GmailConnectedOne-to-one emails only", "SendGridConnected"]);
  });
});

describe("a tool Zavi cannot read never says Connected", () => {
  const view = (over: Record<string, { status: string; error: string | null }>, gmail?: string) => ({
    routes: [
      ...["mailchimp", "klaviyo", "sendgrid"].map((r) => ({ route: r, label: r, status: over[r]?.status ?? "not_connected", error: over[r]?.error ?? null, lists: [] })),
      { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] },
    ],
    orphans: [],
    ...(gmail ? { gmail: { status: gmail } } : {}),
  });
  const REJECTED = "SendGrid rejected the key Zavi has saved for it (it was revoked or is no longer valid). Waiting will not fix this.";

  it("Klaviyo unreadable and SendGrid key rejected: each tile says why and what to do (Try again, Reconnect), in the danger colour, with an arrow, and no Connected anywhere", async () => {
    set("GET /api/workspace/email-test-lists", view({ klaviyo: { status: "unreadable", error: "Klaviyo could not be read right now. Try again in a minute." }, sendgrid: { status: "unreadable", error: REJECTED } }, "unreadable"));
    render(<EmailConnectTiles />);
    const klaviyo = await screen.findByRole("button", { name: "Klaviyo needs attention: couldn't reach it. Reconnect Klaviyo" });
    const sendgrid = screen.getByRole("button", { name: "SendGrid needs attention: key rejected. Reconnect SendGrid" });
    expect(screen.getByRole("button", { name: "Gmail needs attention: couldn't reach it. Reconnect Gmail" })).toBeTruthy();
    expect(screen.getByTestId("email-connect-klaviyo-state").textContent).toBe("Can't reach");
    expect(screen.getByTestId("email-connect-sendgrid-state").textContent).toBe("Key rejected");
    expect(screen.getByTestId("email-connect-gmail-state").textContent).toBe("Can't reach");
    expect(screen.queryByText("Needs attention")).toBeNull();
    for (const tile of [klaviyo, sendgrid]) {
      const state = within(tile).getByTestId(/-state$/);
      expect(state.className).toMatch(/\btext-danger\b/);
      expect(state.className).not.toMatch(/#[0-9a-f]{6}/i);
      expect(tile.querySelector("svg.lucide-arrow-up-right")).not.toBeNull();
      expect(tile.querySelector("svg.lucide-check")).toBeNull();
    }
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByRole("button", { name: /connected\./ })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect Mailchimp" })).toBeTruthy();
  });

  it("a key-rejected SendGrid opens the Connect SendGrid key form on the spot, never Sending settings, and a saved key re-reads it to Connected", async () => {
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    set("GET /api/workspace/email-test-lists", view({ sendgrid: { status: "unreadable", error: REJECTED } }));
    render(<EmailConnectTiles />);
    fireEvent.click(await screen.findByRole("button", { name: "SendGrid needs attention: key rejected. Reconnect SendGrid" }));
    expect(goto).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Connect SendGrid" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Save SendGrid key" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(composio.start).not.toHaveBeenCalled();
    const before = reads();
    set("GET /api/workspace/email-test-lists", lists(["sendgrid"]));
    fireEvent.click(screen.getByRole("button", { name: "Save SendGrid key" }));
    await connectedTools(["sendgrid"]);
    expect(reads()).toBe(before + 1);
    expect(screen.getByRole("button", { name: "Save SendGrid key" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connect SendGrid" })).toBeTruthy();
    expect(goto).not.toHaveBeenCalled();
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("an unreadable Composio tool starts its reconnect, not Sending settings", async () => {
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    set("GET /api/workspace/email-test-lists", view({ klaviyo: { status: "unreadable", error: "Klaviyo rejected the key Zavi has saved for it." } }));
    render(<EmailConnectTiles />);
    fireEvent.click(await screen.findByRole("button", { name: /Klaviyo needs attention/ }));
    expect(composio.start).toHaveBeenCalledTimes(1);
    expect(composio.start).toHaveBeenCalledWith("klaviyo");
    expect(goto).not.toHaveBeenCalled();
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("a partial read still found lists, so the tool is connected", async () => {
    set("GET /api/workspace/email-test-lists", view({ mailchimp: { status: "partial", error: "Mailchimp has more lists than Zavi could read in time." } }));
    render(<EmailConnectTiles />);
    await connectedTools(["mailchimp"]);
    expect(screen.getByTestId("email-connect-mailchimp").getAttribute("data-issue")).toBeNull();
  });

  it("a revisit paints the remembered Needs attention at once, never a remembered Connected", async () => {
    set("GET /api/workspace/email-test-lists", view({ sendgrid: { status: "unreadable", error: REJECTED } }));
    const first = render(<EmailConnectTiles />);
    await screen.findByRole("button", { name: /SendGrid needs attention/ });
    first.unmount();
    render(<EmailConnectTiles />);
    expect(screen.getByTestId("email-connect-sendgrid-state").textContent).toBe("Key rejected");
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("Mailchimp starts its OAuth connect; a connected tile reconnects through Composio, never Sending settings", async () => {
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    render(<EmailConnectTiles />);
    fireEvent.click(await screen.findByRole("button", { name: "Klaviyo, connected. Reconnect Klaviyo" }));
    expect(composio.start).toHaveBeenCalledTimes(1);
    expect(composio.start).toHaveBeenCalledWith("klaviyo");
    expect(goto).not.toHaveBeenCalled();
    composio.start.mockClear();
    cleanup();
    forgetConnected();
    forgetEmailTestLists();
    set("GET /api/workspace/email-test-lists", lists([]));
    render(<EmailConnectTiles />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Mailchimp" }));
    expect(composio.start).toHaveBeenCalledTimes(1);
    expect(composio.start).toHaveBeenCalledWith("mailchimp");
    expect(goto).not.toHaveBeenCalled();
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("no tile in any state ever jumps to Settings: connected, key-rejected, unreachable and off tools all start their connection, and SendGrid always opens its key form", async () => {
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    const dispatched: string[] = [];
    const realDispatch = window.dispatchEvent.bind(window);
    vi.spyOn(window, "dispatchEvent").mockImplementation((e: Event) => {
      dispatched.push(e.type);
      return realDispatch(e);
    });
    const scenarios: Array<{ data: unknown; composio: string[]; rereads: number }> = [
      { data: view({ mailchimp: { status: "complete", error: null }, klaviyo: { status: "unreadable", error: "Klaviyo rejected the key Zavi has saved for it." }, sendgrid: { status: "unreadable", error: REJECTED } }, "connected"), composio: ["mailchimp", "klaviyo", "gmail"], rereads: 0 },
      { data: view({ klaviyo: { status: "complete", error: null }, sendgrid: { status: "complete", error: null } }), composio: ["mailchimp", "klaviyo", "gmail"], rereads: 0 },
      { data: view({ klaviyo: { status: "unreadable", error: "Klaviyo could not be read right now." } }, "unreadable"), composio: ["mailchimp", "klaviyo", "gmail"], rereads: 0 },
    ];
    for (const sc of scenarios) {
      cleanup();
      forgetConnected();
      forgetEmailTestLists();
      composio.start.mockClear();
      set("GET /api/workspace/email-test-lists", sc.data);
      render(<EmailConnectTiles />);
      await waitFor(() => expect(screen.getByTestId("email-connect-sendgrid").getAttribute("data-state")).not.toBeNull());
      const before = reads();
      for (const id of TOOLS) {
        fireEvent.click(screen.getByTestId(`email-connect-${id}`));
        if (id === "sendgrid") {
          expect(screen.getByRole("heading", { name: "Connect SendGrid" })).toBeTruthy();
          expect(screen.getAllByRole("button", { name: "Save SendGrid key" })).toHaveLength(1);
        }
      }
      expect(composio.start.mock.calls.map((c) => (c as unknown[])[0])).toEqual(sc.composio);
      await waitFor(() => expect(reads()).toBe(before + sc.rereads));
      expect(goto).not.toHaveBeenCalled();
      expect(dispatched).not.toContain(EMAIL_SETTINGS_GOTO_EVENT);
    }
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("a connect that cannot start says so", async () => {
    composio.start.mockImplementationOnce(() => Promise.reject(new Error("Composio is down")));
    set("GET /api/workspace/email-test-lists", lists([]));
    render(<EmailConnectTiles />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Mailchimp" }));
    expect(await screen.findByText("Composio is down")).toBeTruthy();
  });

  it("SendGrid opens the key form, and a saved key re-reads and turns the SendGrid tile Connected", async () => {
    set("GET /api/workspace/email-test-lists", lists([]));
    render(<EmailConnectTiles />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect SendGrid" }));
    expect(composio.start).not.toHaveBeenCalled();
    const before = reads();
    set("GET /api/workspace/email-test-lists", lists(["sendgrid"]));
    fireEvent.click(await screen.findByRole("button", { name: "Save SendGrid key" }));
    await connectedTools(["sendgrid"]);
    expect(screen.getByRole("button", { name: "Save SendGrid key" })).toBeTruthy();
    expect(reads()).toBe(before + 1);
  });

  it("an unreadable state never claims Connected, and Try again reads again", async () => {
    set("GET /api/workspace/email-test-lists", { error: { message: "Lists are down" } }, 500);
    render(<EmailConnectTiles />);
    expect(await screen.findByText("Lists are down")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    set("GET /api/workspace/email-test-lists", lists(["mailchimp"]));
    looksLikeButton(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await connectedTools(["mailchimp"]);
    expect(screen.queryByText("Lists are down")).toBeNull();
  });

  it("a 500 with no readable reason says the tool check failed, with one Try again that reads again and clears it", async () => {
    set("GET /api/workspace/email-test-lists", { error: "boom" }, 500);
    render(<EmailConnectTiles />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not check which tools are connected.Try again");
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(within(alert).getAllByRole("button")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    expect(screen.queryByText("Connected")).toBeNull();
    const before = reads();
    set("GET /api/workspace/email-test-lists", lists(["mailchimp"]));
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await connectedTools(["mailchimp"]);
    expect(reads()).toBe(before + 1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a network failure still says Zavi could not be reached", async () => {
    routes["GET /api/workspace/email-test-lists"] = { status: 0, body: null, offline: true };
    render(<EmailConnectTiles />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("We could not reach Zavi. Check your connection and try again.Try again");
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  });
});

function TitleBar() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <ChannelPageHeaderSlotProvider element={null} titleElement={el}>
      <header>
        <h2>Email campaigns</h2>
        <div ref={setEl} data-testid="title-tools" />
      </header>
      <main data-testid="body">
        <EmailHeadTools slug="email_marketing" channelName="Email campaigns" />
      </main>
    </ChannelPageHeaderSlotProvider>
  );
}

describe("Channel header", () => {
  it("shows one New email button and leaves the Email sending switch to Settings", async () => {
    render(<TitleBar />);
    expect(await screen.findAllByRole("button", { name: /New email/ })).toHaveLength(1);
    expect(screen.queryByRole("switch", { name: "Email sending" })).toBeNull();
    expect(within(screen.getByTestId("title-tools")).queryByRole("button")).toBeNull();
  });

  it("New email opens the builder; on a plan without the channel it opens the upgrade instead", async () => {
    set("GET /api/workspace/email-template", { template: null, fonts: [], can_edit: true });
    render(<TitleBar />);
    fireEvent.click(await screen.findByRole("button", { name: /New email/ }));
    expect(await screen.findByTestId("new-campaign")).toBeTruthy();
    cleanup();
    const upgrade = vi.fn();
    lock.value = { tierName: "Pro", upgrade };
    render(<TitleBar />);
    fireEvent.click(await screen.findByRole("button", { name: /New email/ }));
    expect(upgrade).toHaveBeenCalled();
    expect(screen.queryByTestId("new-campaign")).toBeNull();
  });
});

describe("New campaign keeps its request across close and reopen", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const stage = () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] }],
      orphans: [],
    });
    set("GET /api/workspace/email-template", { template: { postal_address: "1 Main St" }, fonts: [], can_edit: true });
    set("GET /api/workspace/sending-domain", {
      domain: { domain: "acme.com", status: "verified", from_address: "hi@acme.com", dns_records: [], last_error: null, verified_at: "2026-10-01T00:00:00Z" },
      suggested_domain: null,
      can_manage: true,
      bulk_email_ready: true,
      postal_address_set: true,
    });
  };

  it("after a plan lands, Done takes the whole dialog out of the page and New campaign opens a fresh one", async () => {
    stage();
    set("POST /api/workspace/email-plan", { ok: true, id: "p1", label: "Wed, Oct 21, 09:00", timezone: "UTC", list_name: "Members", replayed: false });
    render(<TitleBar />);
    fireEvent.click(await screen.findByRole("button", { name: /New email/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /Members/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    pickDayIn("2026-10-21");
    await waitFor(() => expect((screen.getByRole("button", { name: "Plan it" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Plan it" }));
    expect(await screen.findByText("Wed, Oct 21, 09:00")).toBeTruthy();
    expect(document.querySelectorAll("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.querySelectorAll("dialog")).toHaveLength(0));
    expect(screen.queryByTestId("new-campaign")).toBeNull();
    expect(screen.queryByText("Email planned")).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /New email/ }));
    await waitFor(() => expect(document.querySelectorAll("dialog[open]")).toHaveLength(1));
    expect(screen.getByTestId("new-campaign")).toBeTruthy();
    expect(screen.queryByText("Email planned")).toBeNull();
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/workspace/email-plan")).toHaveLength(1);
  });

  it("after a plan with no answer, reopening shows the same email frozen and pressing again resends the same request", async () => {
    stage();
    set("POST /api/workspace/email-plan", { error: { message: "gone" } }, 503);
    render(<TitleBar />);
    fireEvent.click(await screen.findByRole("button", { name: /New email/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /Members/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    pickDayIn("2026-10-21");
    await waitFor(() => expect((screen.getByRole("button", { name: "Plan it" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Plan it" }));
    expect(await screen.findByText(/cannot be planned twice/)).toBeTruthy();
    const first = calls.filter((c) => c.method === "POST" && c.url === "/api/workspace/email-plan").map((c) => c.body as Record<string, unknown>);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ route: "zavi_list", list_id: "Z1", date: "2026-10-21", time: "09:00", angle: "Holiday hours" });
    expect(typeof first[0].request_id).toBe("string");
    expect((first[0].request_id as string).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("new-campaign")).toBeNull());

    set("POST /api/workspace/email-plan", { ok: true, id: "p1", label: "Wed, Oct 21, 09:00", timezone: "UTC", list_name: "Members", replayed: true });
    fireEvent.click(screen.getByRole("button", { name: /New email/ }));
    const brief = (await screen.findByLabelText("What should this email do?")) as HTMLTextAreaElement;
    expect(brief.value).toBe("Holiday hours");
    expect(brief.disabled).toBe(true);
    const day = screen.getByRole("button", { name: "Day" }) as HTMLButtonElement;
    expect(day.textContent).toBe(longDay("2026-10-21"));
    expect(day.disabled).toBe(true);
    await waitFor(() => expect((screen.getByRole("radio", { name: /Members/ }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Plan it" }));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    const plans = calls.filter((c) => c.method === "POST" && c.url === "/api/workspace/email-plan").map((c) => c.body);
    expect(plans).toHaveLength(2);
    expect(plans[1]).toEqual(plans[0]);
  });
});

describe("no flicker between not connected and connected", () => {
  const hold = (key: string, body: unknown) => {
    let release!: () => void;
    routes[key] = { status: 200, body, wait: new Promise<void>((r) => (release = r)) };
    return () => release();
  };

  it("a first visit shows a neutral checking state, never Connect and never an arrow, until the read lands", async () => {
    const release = hold("GET /api/workspace/email-test-lists", lists(["klaviyo"]));
    render(<EmailConnectTiles />);
    const klaviyo = screen.getByTestId("email-connect-klaviyo");
    expect(screen.getByTestId("email-connect-klaviyo-checking")).toBeTruthy();
    expect(klaviyo.textContent).not.toMatch(/Connect|Connected|…/);
    expect(klaviyo.querySelector("svg.lucide-arrow-up-right")).toBeNull();
    expect(klaviyo.getAttribute("aria-busy")).toBe("true");
    release();
    await connectedTools(["klaviyo"]);
    expect(screen.queryByTestId("email-connect-klaviyo-checking")).toBeNull();
    expect(klaviyo.querySelector("svg.lucide-check")).not.toBeNull();
    expect(klaviyo.querySelector("svg.lucide-arrow-up-right")).not.toBeNull();
    expect(klaviyo.querySelector("svg.lucide-chevron-right")).toBeNull();
  });

  it("coming back to the page shows the known state at once while it re-checks in the background", async () => {
    const first = render(<EmailConnectTiles />);
    await connectedTools(["klaviyo"]);
    first.unmount();
    const release = hold("GET /api/workspace/email-test-lists", lists(["klaviyo"]));
    later(EMAIL_TEST_LISTS_FRESH_MS + 1000);
    render(<EmailConnectTiles />);
    expectConnected(screen.getByTestId("email-connect"), ["klaviyo"]);
    expect(screen.queryByTestId("email-connect-klaviyo-checking")).toBeNull();
    expect(screen.getByTestId("email-connect-klaviyo").getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("heading", { name: "Your email tools" })).toBeTruthy();
    release();
    await waitFor(() => expect(reads()).toBe(2));
  });

  it("a re-check that fails drops the remembered state instead of still claiming Connected", async () => {
    const first = render(<EmailConnectTiles />);
    await connectedTools(["klaviyo"]);
    first.unmount();
    set("GET /api/workspace/email-test-lists", { error: { message: "Could not read your email tools." } }, 500);
    later(EMAIL_TEST_LISTS_FRESH_MS + 1000);
    render(<EmailConnectTiles />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("the Sending switch keeps its place while it loads and shows the known state at once on a revisit", async () => {
    const release = hold("GET /api/workspace/email-pause", { paused: false });
    const first = render(<EmailSendingSwitch />);
    expect(screen.getByTestId("email-sending-checking")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    release();
    expect((await screen.findByRole("switch")).getAttribute("aria-checked")).toBe("true");
    first.unmount();
    hold("GET /api/workspace/email-pause", { paused: false });
    render(<EmailSendingSwitch />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("email-sending-checking")).toBeNull();
  });
});

describe("one email-test-lists read per page load", () => {
  const KEY = "GET /api/workspace/email-test-lists";
  const hold = (body: unknown, status = 200) => {
    let release!: () => void;
    routes[KEY] = { status, body, wait: new Promise<void>((r) => (release = r)) };
    return () => release();
  };
  const withList = (status: string) => ({
    routes: [
      { route: "klaviyo", label: "Klaviyo", status, error: status === "complete" ? null : "Klaviyo did not answer in time. Try again in a minute.", lists: status === "complete" ? [{ id: "K1", name: "Regulars", people: 80, marked: false, looks_like_test: false }] : [] },
      { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] },
    ],
    orphans: [],
    gmail: { status: "connected" },
  });
  const page = () => (
    <>
      <EmailConnectTiles />
      <EmailTestListsBlock />
      <NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={() => undefined} />
    </>
  );

  it("three blocks mounted together share one request while it is in flight, and one mounted right after reuses its answer", async () => {
    const release = hold(withList("complete"));
    render(page());
    await waitFor(() => expect(reads()).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(1);
    release();
    await connectedTools(["klaviyo", "gmail"]);
    expect(await screen.findByRole("radio", { name: /Regulars/ })).toBeTruthy();
    expect(await within(screen.getByTestId("email-test-lists")).findByText(/Regulars/)).toBeTruthy();
    render(<EmailConnectTiles />);
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(1);
  });

  it("Gmail never shows up as a list to send a campaign to, and never as a route that failed to load", async () => {
    set(KEY, { ...withList("complete"), gmail: { status: "unreadable" } });
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={() => undefined} />);
    expect(await screen.findByRole("radio", { name: /Regulars/ })).toBeTruthy();
    const to = screen.getByRole("region", { name: "To" });
    expect(to.textContent).not.toMatch(/Gmail/);
    expect(within(to).queryByText(/could not be loaded/)).toBeNull();
  });

  it("the builder's Retry reads again even while a good answer is still fresh", async () => {
    set(KEY, withList("unreadable"));
    render(page());
    const banner = await screen.findByTestId("new-campaign-unreadable");
    expect(banner.textContent).toMatch(/Klaviyo could not be loaded/);
    expect(reads()).toBe(1);
    set(KEY, withList("complete"));
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("radio", { name: /Regulars/ })).toBeTruthy();
    expect(reads()).toBe(2);
  });

  it("a failed read is never cached: the next block to mount asks again, and the tiles' Retry reads again", async () => {
    set(KEY, { error: { message: "Lists are down" } }, 500);
    render(
      <>
        <EmailConnectTiles />
        <EmailConnectTiles />
      </>,
    );
    expect((await screen.findAllByText("Lists are down")).length).toBe(2);
    expect(reads()).toBe(1);
    render(<EmailConnectTiles />);
    await waitFor(() => expect(screen.getAllByText("Lists are down")).toHaveLength(3));
    expect(reads()).toBe(2);
    set(KEY, lists(["mailchimp"]));
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    await connectedTools(["mailchimp"], () => screen.getAllByTestId("email-connect")[0]);
    expect(reads()).toBe(3);
  });

  it("tiles that mount while a good answer is fresh paint it without asking again", async () => {
    set(KEY, lists(["klaviyo"]));
    await getEmailTestLists();
    expect(reads()).toBe(1);
    set(KEY, { error: { message: "Lists are down" } }, 500);
    render(<EmailConnectTiles />);
    await connectedTools(["klaviyo"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(reads()).toBe(1);
  });

  it("a SendGrid key saved anywhere drops the shared answer, so every block re-reads together in one request", async () => {
    set(KEY, lists(["klaviyo"]));
    render(page());
    await connectedTools(["klaviyo"]);
    await waitFor(() => expect(reads()).toBe(1));
    set(KEY, lists(["klaviyo", "sendgrid"]));
    window.dispatchEvent(new Event(SENDGRID_CONNECTED_EVENT));
    await connectedTools(["klaviyo", "sendgrid"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(reads()).toBe(2);
  });

  it("an answer older than the fresh window is read again", async () => {
    await getEmailTestLists();
    await getEmailTestLists();
    expect(reads()).toBe(1);
    later(EMAIL_TEST_LISTS_FRESH_MS + 1000);
    await getEmailTestLists();
    expect(reads()).toBe(2);
  });

  it("a read that lands after a forget never comes back as the cached answer", async () => {
    const release = hold(lists(["klaviyo"]));
    const stale = getEmailTestLists();
    forgetEmailTestLists();
    set(KEY, lists(["sendgrid"]));
    release();
    await stale;
    const next = await getEmailTestLists();
    expect(reads()).toBe(2);
    expect(next.routes.find((r) => r.route === "sendgrid")?.status).toBe("complete");
  });
});

describe("Connect tiles while the tool check has failed", () => {
  const KEY = "GET /api/workspace/email-test-lists";
  const REJECTED = "SendGrid rejected the key Zavi has saved for it (it was revoked or is no longer valid). Waiting will not fix this.";
  const real = {
    routes: [
      { route: "mailchimp", label: "mailchimp", status: "complete", error: null, lists: [] },
      { route: "klaviyo", label: "klaviyo", status: "unreadable", error: "Klaviyo could not be read right now.", lists: [] },
      { route: "sendgrid", label: "sendgrid", status: "unreadable", error: REJECTED, lists: [] },
      { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] },
    ],
    orphans: [],
    gmail: { status: "connected" },
  };
  const expectNoClaim = (root: HTMLElement) => {
    expect(within(root).getByRole("alert").textContent).toBe("Could not check which tools are connected.Try again");
    for (const tile of tilesIn(root)) {
      const id = tile.getAttribute("data-testid");
      expect(tile.textContent).not.toMatch(/Connect|Can't reach|Key rejected/);
      expect(within(root).queryByTestId(`${id}-state`)).toBeNull();
      expect(within(root).queryByTestId(`${id}-checking`)).toBeNull();
      expect(tile.getAttribute("data-state")).toBeNull();
      expect(tile.getAttribute("aria-label")).toMatch(/, connection status unknown$/);
      expect(tile.getAttribute("aria-label")).not.toMatch(/^Connect /);
      fireEvent.click(tile);
    }
    expect(composio.start).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Connect SendGrid" })).toBeNull();
  };
  const expectReal = async (root: () => HTMLElement) => {
    await waitFor(() => expect(within(root()).getByTestId("email-connect-mailchimp-state").textContent).toBe("Connected"));
    const s = root();
    expect(TOOLS.map((t) => within(s).getByTestId(`email-connect-${t}-state`).textContent)).toEqual(["Connected", "Can't reach", "Connected", "Key rejected"]);
    expect(within(s).queryByRole("alert")).toBeNull();
    expect(tilesIn(s).every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  };

  it("cold mount: a 500 shows no Connect on any tile until Retry succeeds, then the real states", async () => {
    set(KEY, { error: "boom" }, 500);
    render(<EmailConnectTiles />);
    await screen.findByRole("alert");
    expectNoClaim(screen.getByTestId("email-connect"));
    set(KEY, real);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await expectReal(() => screen.getByTestId("email-connect"));
  });

  it("warm cache: after a good read, a revisit whose re-check 500s shows no Connect, then Retry restores the real states", async () => {
    set(KEY, real);
    const first = render(<EmailConnectTiles />);
    await expectReal(() => screen.getByTestId("email-connect"));
    first.unmount();
    set(KEY, { error: "boom" }, 500);
    later(EMAIL_TEST_LISTS_FRESH_MS + 1000);
    render(<EmailConnectTiles />);
    await screen.findByRole("alert");
    expectNoClaim(screen.getByTestId("email-connect"));
    set(KEY, real);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await expectReal(() => screen.getByTestId("email-connect"));
  });

  it("same mount: a re-read that 500s after a good read drops to no status, not Connect", async () => {
    set(KEY, real);
    render(<EmailConnectTiles />);
    await expectReal(() => screen.getByTestId("email-connect"));
    set(KEY, { error: "boom" }, 500);
    window.dispatchEvent(new Event(SENDGRID_CONNECTED_EVENT));
    await screen.findByRole("alert");
    expectNoClaim(screen.getByTestId("email-connect"));
    set(KEY, real);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await expectReal(() => screen.getByTestId("email-connect"));
  });
});

describe("the Gmail tile note", () => {
  it("truncates on one line inside the tile instead of wrapping or running past its edge", async () => {
    render(<EmailConnectTiles />);
    const note = await screen.findByTestId("email-connect-gmail-scope");
    expect(note.textContent).toBe("One-to-one emails only");
    const cls = note.className.split(/\s+/);
    expect(cls).toContain("truncate");
    expect(cls).toContain("block");
    expect(note.getAttribute("title")).toBe("One-to-one emails only");
    expect(note.parentElement!.className.split(/\s+/)).toContain("min-w-0");
  });
});
