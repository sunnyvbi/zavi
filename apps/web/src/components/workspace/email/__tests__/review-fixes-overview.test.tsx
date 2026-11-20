// @vitest-environment jsdom
import { forgetConnected } from "../EmailConnectTiles";
import { forgetPaused } from "../EmailSendingSwitch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EMAIL_FOOTER_SAVED_EVENT, forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";
import { EMAIL_SETTINGS_GOTO_EVENT } from "../emailSettingsNav";

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: { ok: true } };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
const composio = vi.hoisted(() => ({ start: vi.fn(() => Promise.resolve()) }));
vi.mock("@/app/connectors/composioConnect", () => ({ startComposioConnect: composio.start }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { ChannelChatProvider } from "../../actions/channelChat";
import { ChannelOverviewPanels } from "../EmailSettingsPanels";
import { EmailComingUpBlock, comingUpPoll } from "../EmailComingUpBlock";
import { SentEmailsBlock } from "../SentEmailsBlock";
import { EmailSendingSwitch } from "../EmailSendingSwitch";
import { ChannelPageHeaderSlotProvider } from "../../layout/ChannelHeaderRow";
import { EMAIL_PLAN_CHANGED_EVENT } from "../NewCampaignDialog";

const A = "11111111-1111-4111-8111-111111111111";
const C = "33333333-3333-4333-8333-333333333333";
const item = (over: Record<string, unknown> = {}) => ({
  id: A,
  route: "mailchimp",
  list_id: "L1",
  list_name: "Paying customers",
  planned_at: "2026-10-21T16:00:00Z",
  planned_label: "Wed, Oct 21, 09:00",
  timezone: "America/Los_Angeles",
  angle: "Product news: shared calendars",
  why: "Product news beat tips 3 times out of 4 for this list.",
  source: "growth_agent",
  status: "planned",
  status_reason: null,
  reason: null,
  content_version: 1,
  schedule_gen: 1,
  card: null,
  vetoed: false,
  scheduled: null,
  unattended: false,
  sent_at: null,
  ...over,
});
const view = (items: unknown[]) => ({ ok: true, role: "owner", timezone: "America/Los_Angeles", next_plan_at: null, next_plan_label: null, items, holds: [], released: [] });
const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};
const count = (key: string) => calls.filter((c) => `${c.method} ${c.url}` === key).length;
const TOOLS = ["mailchimp", "klaviyo", "gmail", "sendgrid"];
const toolsSettled = async (connected: string[]) => {
  await waitFor(() => {
    const section = screen.getByTestId("email-connect");
    expect(section.getAttribute("data-mode")).toBe("tiles");
    expect(TOOLS.filter((t) => within(section).getByTestId(`email-connect-${t}`).getAttribute("data-state") === "connected")).toEqual(connected);
    for (const t of connected) expect(within(section).getByTestId(`email-connect-${t}-state`).textContent).toBe("Connected");
  });
  expect(screen.queryByTestId("email-sending-with")).toBeNull();
};
const headings = (root: HTMLElement) => Array.from(root.querySelectorAll("h2, h3, h4")).map((h) => h.textContent);

beforeEach(() => {
  forgetConnected();
  forgetPaused();
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  ws.role = "owner";
  comingUpPoll.ms = 15_000;
  set("GET /api/workspace/email-pause", { paused: false });
  set("GET /api/workspace/email-plan", view([]));
  set("GET /api/workspace/email-test-lists", {
    routes: [
      { route: "mailchimp", label: "Mailchimp", status: "complete", error: null, lists: [{ id: "L1", name: "Paying customers", people: 300, marked: false, looks_like_test: false }, { id: "T1", name: "Staff test", people: 2, marked: true, looks_like_test: true }] },
      { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] },
    ],
    orphans: [],
  });
});
afterEach(cleanup);

describe("fix 2: Email sending switch", () => {
  const sw = () => screen.findByRole("switch", { name: "Email sending" });
  it("on means sending; turning it off asks first and Cancel sends nothing; off pauses; turning it on asks too", async () => {
    render(
      <>
        <ConfirmDialogHost />
        <EmailSendingSwitch />
      </>,
    );
    expect((await sw()).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("On")).toBeTruthy();

    fireEvent.click(await sw());
    let dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/SendGrid, Mailchimp, Klaviyo/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(count("POST /api/workspace/email-pause")).toBe(0);
    expect((await sw()).getAttribute("aria-checked")).toBe("true");

    set("POST /api/workspace/email-pause", { paused: true });
    fireEvent.click(await sw());
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Pause all email" }));
    await waitFor(() => expect(count("POST /api/workspace/email-pause")).toBe(1));
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/workspace/email-pause")!.body).toEqual({ paused: true });
    await waitFor(async () => expect((await sw()).getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("Paused")).toBeTruthy();

    set("POST /api/workspace/email-pause", { paused: false });
    fireEvent.click(await sw());
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(count("POST /api/workspace/email-pause")).toBe(2));
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/workspace/email-pause")[1].body).toEqual({ paused: false });
    await waitFor(async () => expect((await sw()).getAttribute("aria-checked")).toBe("true"));
  });

  it("a refused pause keeps the old state and says why; a member cannot flip it", async () => {
    set("POST /api/workspace/email-pause", { error: { code: "forbidden", message: "Only an owner or admin can pause email." } }, 403);
    render(
      <>
        <ConfirmDialogHost />
        <EmailSendingSwitch />
      </>,
    );
    fireEvent.click(await sw());
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Pause all email" }));
    expect(await screen.findByText(/Only an owner or admin can pause email/)).toBeTruthy();
    expect((await sw()).getAttribute("aria-checked")).toBe("true");
    cleanup();
    ws.role = "member";
    calls.length = 0;
    render(
      <>
        <ConfirmDialogHost />
        <EmailSendingSwitch />
      </>,
    );
    const locked = (await sw()) as HTMLButtonElement;
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(locked.disabled).toBe(false);
    expect(document.getElementById(locked.getAttribute("aria-describedby")!.split(" ")[1])!.textContent).toMatch(/Only a workspace owner or admin/);
    fireEvent.click(locked);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(count("POST /api/workspace/email-pause")).toBe(0);
  });

  it("a lost response rereads the saved state instead of leaving a stale guarantee", async () => {
    set("GET /api/workspace/email-pause", { paused: true });
    set("POST /api/workspace/email-pause", { error: { message: "The reply was lost." } }, 500);
    render(
      <>
        <ConfirmDialogHost />
        <EmailSendingSwitch />
      </>,
    );
    expect((await sw()).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(await sw());
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(count("GET /api/workspace/email-pause")).toBe(2));
    expect((await sw()).getAttribute("aria-checked")).toBe("false");
    expect(await screen.findByText(/saved state is shown/)).toBeTruthy();
  });

  it("an unreadable pause state shows no switch at all, and Retry reads again", async () => {
    set("GET /api/workspace/email-pause", { error: { message: "down" } }, 500);
    render(<EmailSendingSwitch />);
    expect(await screen.findByText(/could not confirm whether email is paused/)).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    set("GET /api/workspace/email-pause", { paused: false });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect((await sw()).getAttribute("aria-checked")).toBe("true");
  });

  it("the Overview no longer carries a pause box", async () => {
    render(<ChannelOverviewPanels panels={["email_coming_up"]} />);
    await screen.findByTestId("coming-up");
    expect(screen.queryByTestId("email-pause")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});

describe("fix 8: Coming up", () => {
  it("Skip asks first; Cancel skips nothing", async () => {
    set("GET /api/workspace/email-plan", view([item()]));
    render(
      <>
        <ConfirmDialogHost />
        <EmailComingUpBlock />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Paying customers/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(count(`POST /api/workspace/email-plan/${A}/skip`)).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Skip this email" }));
    await waitFor(() => expect(count(`POST /api/workspace/email-plan/${A}/skip`)).toBe(1));
  });

  it("Skip on an email with a draft says the draft is closed, never that it stays open", async () => {
    set("GET /api/workspace/email-plan", view([item({ status: "ready", card: { rail: "channel_actions", id: C } })]));
    render(
      <>
        <ConfirmDialogHost />
        <EmailComingUpBlock />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/draft is closed/);
    expect(dialog.textContent).not.toMatch(/stays open|send it later/);
  });

  it("Change topic asks first when a draft would be replaced; Cancel changes nothing", async () => {
    set("GET /api/workspace/email-plan", view([item({ status: "ready", card: { rail: "channel_actions", id: C } })]));
    render(
      <>
        <ConfirmDialogHost />
        <EmailComingUpBlock />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Change topic" }));
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Holiday hours" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/draft/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(count(`POST /api/workspace/email-plan/${A}/angle`)).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Change topic" }));
    await waitFor(() => expect(count(`POST /api/workspace/email-plan/${A}/angle`)).toBe(1));
    expect(calls.find((c) => c.url.endsWith("/angle"))!.body).toEqual({ angle: "Holiday hours", content_version: 1 });
  });

  it("planned times carry a zone abbreviation, never the raw zone name; no 'angle' or 'Growth agent' on screen", async () => {
    set("GET /api/workspace/email-plan", view([item()]));
    const { container } = render(<EmailComingUpBlock />);
    expect(await screen.findByText(/Wed, Oct 21 · 9:00 AM PDT/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move" }));
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/America\/Los_Angeles/);
    expect(text).not.toMatch(/angle/i);
    expect(text).not.toMatch(/Growth agent/);
  });

  it("the empty plan links to Autopilot", async () => {
    set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: false });
    render(
      <ChannelChatProvider open={vi.fn()}>
        <EmailComingUpBlock />
      </ChannelChatProvider>,
    );
    const link = await screen.findByRole("link", { name: "Turn on Autopilot" });
    expect(link.getAttribute("href")).toBe("/workspace?tab=growth-strategy");
  });

  it("Coming up leads with one compact Autopilot row, not a paragraph; How it works opens the rules", async () => {
    set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: true, next_plan_label: "Mon, Oct 26" });
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-autopilot");
    expect((await within(row).findByTestId("coming-up-autopilot-status")).textContent).toBe("Next plan Mon, Oct 26");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(screen.queryByText(/With Autopilot on, Zavi plans next week/)).toBeNull();
    expect(screen.queryByText(/drafts each one the day before/)).toBeNull();
    const how = within(row).getByRole("button", { name: /How it works/ });
    expect(how.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(how);
    expect(how.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(expect.arrayContaining([expect.stringMatching(/drafts each one the day before/), expect.stringMatching(/1,000 people or fewer/)]));
    fireEvent.click(how);
    expect(screen.queryByText(/drafts each one the day before/)).toBeNull();
  });

  it("Flow 38: with Autopilot on the strip says On once, in the pill, and the line under it says what happens next", async () => {
    set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: true, next_plan_label: "Mon, Oct 26" });
    const first = render(<EmailComingUpBlock />);
    const status = await screen.findByTestId("coming-up-autopilot-status");
    const strip = screen.getByTestId("coming-up-autopilot");
    expect(within(strip).getAllByText((_, el) => !!el && el.children.length === 0 && /\bOn\b/.test(el.textContent ?? ""))).toHaveLength(1);
    expect(status.textContent).toBe("Next plan Mon, Oct 26");
    expect(status.textContent).not.toMatch(/\bOn\b/);
    first.unmount();
    set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: true, next_plan_label: null });
    render(<EmailComingUpBlock />);
    const bare = await screen.findByTestId("coming-up-autopilot-status");
    expect(within(screen.getByTestId("coming-up-autopilot")).getAllByText((_, el) => !!el && el.children.length === 0 && /\bOn\b/.test(el.textContent ?? ""))).toHaveLength(1);
    expect(bare.textContent).toBe("Zavi plans next week's emails every Monday.");
  });

  it("with Autopilot on but nowhere to send, the strip asks for a tool or a list and never promises a plan", async () => {
    for (const next_plan_label of ["Mon, Oct 26", null]) {
      set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: true, weekly_eligible: false, next_plan_label });
      const r = render(<EmailComingUpBlock />);
      const status = await screen.findByTestId("coming-up-autopilot-status");
      const strip = screen.getByTestId("coming-up-autopilot");
      expect(status.textContent).toBe("Connect an email tool or add a list so Zavi can plan your emails. A list marked as a test, or one with nobody to send to, does not count.");
      expect(within(strip).getAllByText((_, el) => !!el && el.children.length === 0 && /\bOn\b/.test(el.textContent ?? ""))).toHaveLength(1);
      const text = r.container.textContent ?? "";
      expect(text).not.toMatch(/every Monday/);
      expect(text).not.toMatch(/Next plan/i);
      r.unmount();
    }
  });

  it("with email paused, the strip names the pause instead of asking for a list, and never promises a plan", async () => {
    set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: true, weekly_eligible: false, weekly_block: "paused", next_plan_label: "Mon, Oct 26" });
    const r = render(<EmailComingUpBlock />);
    const status = await screen.findByTestId("coming-up-autopilot-status");
    expect(status.textContent).toBe("Email is paused, so Zavi is not planning emails. Turn email back on and Zavi plans again on Monday.");
    expect(r.container.textContent ?? "").not.toMatch(/Connect an email tool|Next plan/);
    r.unmount();
  });

  it("weekly_eligible true or missing keeps the next plan line", async () => {
    for (const extra of [{ weekly_eligible: true }, {}]) {
      set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: true, next_plan_label: "Mon, Oct 26", ...extra });
      const r = render(<EmailComingUpBlock />);
      expect((await screen.findByTestId("coming-up-autopilot-status")).textContent).toBe("Next plan Mon, Oct 26");
      r.unmount();
    }
  });

  it("Autopilot is one strip: off says so and offers one Turn on button; nothing else under it until an email is planned", async () => {
    set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: false });
    render(<EmailComingUpBlock />);
    const off = await screen.findByTestId("coming-up-autopilot-off");
    const strip = screen.getByTestId("coming-up-autopilot");
    expect(strip.contains(off)).toBe(true);
    expect(screen.getByRole("region", { name: "Autopilot" })).toBe(screen.getByTestId("coming-up"));
    expect(screen.getAllByRole("link", { name: /Turn on Autopilot/ })).toHaveLength(1);
    expect(strip.contains(screen.getByRole("link", { name: /Turn on Autopilot/ }))).toBe(true);
    expect(screen.getByTestId("coming-up").textContent).not.toMatch(/Coming up|Nothing planned|Waiting on you/);
    fireEvent.click(within(strip).getByRole("button", { name: /How it works/ }));
    expect(screen.getAllByRole("listitem").some((li) => /drafts each one the day before/.test(li.textContent ?? ""))).toBe(true);
  });

  it("a planned email sits under Coming up with its count, below the strip", async () => {
    set("GET /api/workspace/email-plan", { ...view([item()]), autopilot_on: false });
    render(<EmailComingUpBlock />);
    const head = await screen.findByRole("heading", { name: /Coming up/ });
    expect(head.textContent).toMatch(/Coming up\s*1$/);
    const strip = screen.getByTestId("coming-up-autopilot");
    expect(strip.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Turn on Autopilot/ })).toHaveLength(1);
  });

  it("with Autopilot on the strip shows the next plan and offers no Turn on link", async () => {
    set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: true, next_plan_label: "Mon, Oct 26" });
    render(<EmailComingUpBlock />);
    await screen.findByText("Next plan Mon, Oct 26");
    expect(screen.queryByRole("link", { name: /Turn on Autopilot/ })).toBeNull();
    expect(screen.queryByTestId("coming-up-autopilot-off")).toBeNull();
  });

  it("the switch only says On or Off; Paused shows as a badge beside the channel title", async () => {
    set("GET /api/workspace/email-pause", { paused: true });
    const badge = document.createElement("span");
    document.body.appendChild(badge);
    render(
      <ChannelPageHeaderSlotProvider element={null} badgeElement={badge}>
        <EmailSendingSwitch />
      </ChannelPageHeaderSlotProvider>,
    );
    await waitFor(() => expect(within(badge).getByTestId("email-paused-badge").textContent).toBe("Paused"));
    const sw = screen.getByTestId("email-sending");
    expect(within(sw).queryByText("Paused")).toBeNull();
    expect(within(sw).getByText("Off").className).toContain("sr-only");
    badge.remove();
  });

  it("with sending on there is no Paused badge and the switch says On", async () => {
    set("GET /api/workspace/email-pause", { paused: false });
    const badge = document.createElement("span");
    document.body.appendChild(badge);
    render(
      <ChannelPageHeaderSlotProvider element={null} badgeElement={badge}>
        <EmailSendingSwitch />
      </ChannelPageHeaderSlotProvider>,
    );
    await waitFor(() => expect(within(screen.getByTestId("email-sending")).getByText("On").className).toContain("sr-only"));
    expect(badge.textContent).toBe("");
    badge.remove();
  });

  it("Autopilot off gets an invitation to turn it on; on shows no invitation", async () => {
    set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: false });
    const first = render(<EmailComingUpBlock />);
    const off = await screen.findByTestId("coming-up-autopilot-off");
    expect(off.textContent).toMatch(/Let Zavi plan your emails/);
    expect(within(screen.getByTestId("coming-up-autopilot")).getByRole("link", { name: /Turn on Autopilot/ }).getAttribute("href")).toBe("/workspace?tab=growth-strategy");
    first.unmount();
    set("GET /api/workspace/email-plan", { ...view([]), autopilot_on: true, next_plan_label: "Mon, Oct 26" });
    render(<EmailComingUpBlock />);
    await screen.findByText("Next plan Mon, Oct 26");
    expect(screen.queryByTestId("coming-up-autopilot-off")).toBeNull();
  });

  it("reads the plan again while an email is drafting, and stops once nothing is moving or it unmounts", async () => {
    comingUpPoll.ms = 30;
    set("GET /api/workspace/email-plan", view([item({ status: "drafting" })]));
    const { unmount } = render(<EmailComingUpBlock />);
    await waitFor(() => expect(count("GET /api/workspace/email-plan")).toBeGreaterThanOrEqual(3));
    set("GET /api/workspace/email-plan", view([item({ status: "ready", card: { rail: "channel_actions", id: C } })]));
    await screen.findByText("Needs approval");
    const settled = count("GET /api/workspace/email-plan");
    await new Promise((r) => setTimeout(r, 150));
    expect(count("GET /api/workspace/email-plan")).toBe(settled);
    set("GET /api/workspace/email-plan", view([item({ status: "sending" })]));
    unmount();
    const atUnmount = count("GET /api/workspace/email-plan");
    await new Promise((r) => setTimeout(r, 150));
    expect(count("GET /api/workspace/email-plan")).toBe(atUnmount);
  });

  it("Coming up has no plan or new email button of its own, and reads the plan again when New campaign plans one", async () => {
    render(
      <ChannelChatProvider open={vi.fn()}>
        <EmailComingUpBlock />
      </ChannelChatProvider>,
    );
    expect(await screen.findByTestId("coming-up-empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan an email" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New email" })).toBeNull();
    const before = count("GET /api/workspace/email-plan");
    set("GET /api/workspace/email-plan", view([item()]));
    window.dispatchEvent(new CustomEvent(EMAIL_PLAN_CHANGED_EVENT));
    expect(await screen.findByText(/Wed, Oct 21 · 9:00 AM PDT/)).toBeTruthy();
    expect(count("GET /api/workspace/email-plan")).toBe(before + 1);
  });
});

describe("fix 10: Sent emails load error has Retry", () => {
  it("Retry reads again", async () => {
    set("GET /api/email-results", { error: { message: "Sent emails could not be loaded. Try again." } }, 500);
    render(<SentEmailsBlock />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(count("GET /api/email-results")).toBe(2));
    set("GET /api/email-results", { emails: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("sent-emails-empty")).toBeTruthy();
  });
});

describe("Before you send strip", () => {
  const PLACEHOLDER = "123 Test Street, San Francisco, CA 94105, USA";
  const REAL = "Cakely Bakery, 450 Valencia Street, San Francisco, CA 94103, USA";
  const template = (postal: string | null) => ({ template: { logo_url: null, brand_color: "#000000", button_color: "#000000", font_key: "inter", sign_off: "", postal_address: postal, show_cards: true }, fonts: [], can_edit: true });
  const verified = { domain: { domain: "cakely.com", status: "verified", from_address: "hi@cakely.com", dns_records: [], last_error: null, verified_at: "2026-10-01T00:00:00Z" }, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true };
  const tools = (over: Record<string, { status: string; error: string | null }> = {}) => ({
    routes: [
      ...["mailchimp", "klaviyo", "sendgrid"].map((r) => ({ route: r, label: r, status: over[r]?.status ?? (r === "mailchimp" ? "complete" : "not_connected"), error: over[r]?.error ?? null, lists: [] })),
      { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] },
    ],
    orphans: [],
  });
  const settled = async () => {
    await waitFor(() => {
      expect(count("GET /api/workspace/email-template")).toBeGreaterThan(0);
      expect(count("GET /api/workspace/email-test-lists")).toBeGreaterThan(0);
      expect(count("GET /api/workspace/sending-domain")).toBeGreaterThan(0);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(count("GET /api/channels/email_marketing/settings")).toBe(0);
  };
  const blockers = () => screen.queryAllByTestId("email-send-blocker").map((li) => [li.getAttribute("data-blocker"), li.textContent]);
  const page = () => render(<ChannelOverviewPanels panels={["email_connect", "email_sent_emails"]} />);

  beforeEach(() => {
    forgetEmailTestLists();
    set("GET /api/workspace/email-template", template(REAL));
    set("GET /api/channels/email_marketing/settings", { fields: {} });
    set("GET /api/workspace/sending-domain", verified);
    set("GET /api/workspace/email-test-lists", tools());
    set("GET /api/email-results", { emails: [] });
  });

  it("a saved placeholder address is a blocker at the very top of Overview, above the tool tiles and the results, and its link opens Footer settings", async () => {
    set("GET /api/workspace/email-template", template(PLACEHOLDER));
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    const { container } = page();
    const strip = await screen.findByTestId("email-send-blockers");
    expect(within(strip).getByRole("heading").textContent).toBe("Before you send");
    expect(blockers()).toEqual([["postal", "Your postal address is still a placeholderReplace it in Footer"]]);
    await toolsSettled(["mailchimp"]);
    await screen.findByTestId("email-performance");
    const order = Array.from(container.querySelectorAll("[data-testid='email-send-blockers'], [data-testid='email-connect'], [data-testid='email-performance']")).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["email-send-blockers", "email-connect", "email-performance"]);
    expect(headings(container).filter((h) => ["Before you send", "Your email tools", "How your emails are doing"].includes(h ?? ""))).toEqual(["Before you send", "Your email tools", "How your emails are doing"]);
    fireEvent.click(within(strip).getByRole("button", { name: /placeholder/ }));
    expect(goto).toHaveBeenCalledTimes(1);
    expect((goto.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: "footer" });
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("nothing blocking renders nothing at all: no heading, no empty box", async () => {
    page();
    await settled();
    await toolsSettled(["mailchimp"]);
    expect(screen.queryByTestId("email-send-blockers")).toBeNull();
    expect(screen.queryByText("Before you send")).toBeNull();
  });

  it("with no saved template row, the old footer setting decides: a real one is not a blocker, an empty or placeholder one is, and a failed setting read claims nothing", async () => {
    const noRow = { template: null, fonts: [], can_edit: true };
    const settingsRead = async () => {
      await waitFor(() => {
        expect(count("GET /api/channels/email_marketing/settings")).toBeGreaterThan(0);
        expect(count("GET /api/workspace/email-test-lists")).toBeGreaterThan(0);
        expect(count("GET /api/workspace/sending-domain")).toBeGreaterThan(0);
      });
      await new Promise((r) => setTimeout(r, 30));
    };
    set("GET /api/workspace/email-template", noRow);
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "", status: null }, { item: `  ${REAL}  `, status: null }] } });
    page();
    await settingsRead();
    expect(screen.queryByTestId("email-send-blockers")).toBeNull();
    for (const [rows, line] of [
      [[], "Your email footer has no postal addressAdd it in Footer"],
      [[{ item: "  ", status: null }], "Your email footer has no postal addressAdd it in Footer"],
      [[{ item: REAL, status: "dismissed" }], "Your email footer has no postal addressAdd it in Footer"],
      [[{ item: PLACEHOLDER, status: null }], "Your postal address is still a placeholderReplace it in Footer"],
    ] as const) {
      cleanup();
      forgetEmailTestLists();
      calls.length = 0;
      set("GET /api/channels/email_marketing/settings", { fields: { postal_address: rows } });
      page();
      await screen.findByTestId("email-send-blockers");
      expect(blockers()).toEqual([["postal", line]]);
    }
    cleanup();
    forgetEmailTestLists();
    calls.length = 0;
    set("GET /api/channels/email_marketing/settings", { error: { message: "down" } }, 500);
    page();
    await settingsRead();
    expect(await screen.findByTestId("email-send-blockers-unchecked")).toBeTruthy();
    expect(blockers()).toEqual([]);
    expect(screen.queryByText(/no postal address/i)).toBeNull();
  });

  it("a saved template row decides, so a real address only in the old footer setting is still a blocker and the setting is never read", async () => {
    set("GET /api/workspace/email-template", template("   "));
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: REAL, status: null }] } });
    page();
    await screen.findByTestId("email-send-blockers");
    expect(blockers()).toEqual([["postal", "Your email footer has no postal addressAdd it in Footer"]]);
    cleanup();
    forgetEmailTestLists();
    calls.length = 0;
    set("GET /api/workspace/email-template", template(PLACEHOLDER));
    page();
    await screen.findByTestId("email-send-blockers");
    expect(blockers()).toEqual([["postal", "Your postal address is still a placeholderReplace it in Footer"]]);
    cleanup();
    forgetEmailTestLists();
    calls.length = 0;
    set("GET /api/workspace/email-template", template(REAL));
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "", status: null }] } });
    page();
    await settled();
    expect(screen.queryByTestId("email-send-blockers")).toBeNull();
  });

  it("a pending domain and a rejected tool key each get a line that opens Sending; an unreadable tool that was not rejected is not a blocker", async () => {
    set("GET /api/workspace/sending-domain", { ...verified, domain: { ...verified.domain, status: "pending", verified_at: null } });
    set(
      "GET /api/workspace/email-test-lists",
      tools({ mailchimp: { status: "not_connected", error: null }, klaviyo: { status: "unreadable", error: "Klaviyo rejected the key Zavi has saved for it." }, sendgrid: { status: "unreadable", error: "SendGrid could not be read right now." } }),
    );
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    page();
    await screen.findByTestId("email-send-blockers");
    expect(blockers()).toEqual([
      ["key:klaviyo", "Klaviyo rejected the key Zavi has savedReconnect in Sending"],
      ["domain", "cakely.com is not verified yetVerify it in Sending"],
    ]);
    for (const b of within(screen.getByTestId("email-send-blockers")).getAllByRole("button")) fireEvent.click(b);
    expect(goto.mock.calls.map((c) => (c[0] as CustomEvent).detail)).toEqual([{ section: "sending" }, { section: "sending" }]);
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("no domain is only a blocker when no outside email tool can send", async () => {
    set("GET /api/workspace/sending-domain", { ...verified, domain: null });
    page();
    await settled();
    await toolsSettled(["mailchimp"]);
    expect(screen.queryByTestId("email-send-blockers")).toBeNull();
    cleanup();
    forgetConnected();
    forgetEmailTestLists();
    calls.length = 0;
    set("GET /api/workspace/email-test-lists", tools({ mailchimp: { status: "not_connected", error: null } }));
    page();
    await screen.findByTestId("email-send-blockers");
    expect(blockers()).toEqual([["domain", "No sending domain yet, so Zavi can't send to your listsAdd one in Sending"]]);
  });

  it("one read failing never hides the others' blockers, and a failed address read never claims the address is missing", async () => {
    set("GET /api/workspace/email-template", template(PLACEHOLDER));
    set("GET /api/workspace/sending-domain", { error: { message: "down" } }, 500);
    set("GET /api/workspace/email-test-lists", { error: { message: "down" } }, 500);
    page();
    await screen.findByTestId("email-send-blockers");
    expect(blockers()).toEqual([["postal", "Your postal address is still a placeholderReplace it in Footer"]]);
    cleanup();
    forgetConnected();
    forgetEmailTestLists();
    calls.length = 0;
    set("GET /api/workspace/email-template", { error: { message: "down" } }, 500);
    set("GET /api/channels/email_marketing/settings", { error: { message: "down" } }, 500);
    set("GET /api/workspace/sending-domain", verified);
    set("GET /api/workspace/email-test-lists", tools());
    page();
    await settled();
    expect(await screen.findByTestId("email-send-blockers-unchecked")).toBeTruthy();
    expect(blockers()).toEqual([]);
    expect(screen.queryByText(/no postal address/i)).toBeNull();
  });

  it("a failed template read never claims the address is missing, even when the settings read worked", async () => {
    set("GET /api/workspace/email-template", { error: { message: "down" } }, 500);
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: REAL, status: null }] } });
    set("GET /api/workspace/sending-domain", { ...verified, domain: { ...verified.domain, status: "pending", verified_at: null } });
    set("GET /api/workspace/email-test-lists", tools({ mailchimp: { status: "not_connected", error: null } }));
    page();
    await screen.findByTestId("email-send-blockers");
    await settled();
    expect(blockers()).toEqual([["domain", "cakely.com is not verified yetVerify it in Sending"]]);
    expect(screen.queryByText(/no postal address/i)).toBeNull();
  });

  it("saving the footer reads again and the fixed blocker goes away", async () => {
    set("GET /api/workspace/email-template", template(PLACEHOLDER));
    page();
    await screen.findByTestId("email-send-blockers");
    set("GET /api/workspace/email-template", template(REAL));
    act(() => {
      window.dispatchEvent(new Event(EMAIL_FOOTER_SAVED_EVENT));
    });
    await waitFor(() => expect(screen.queryByTestId("email-send-blockers")).toBeNull());
    expect(count("GET /api/workspace/email-template")).toBe(2);
  });

  it("the strip carries no hover classes and no hex colours", async () => {
    set("GET /api/workspace/email-template", template(null));
    const { container } = page();
    await screen.findByTestId("email-send-blockers");
    const classes = Array.from(container.querySelectorAll("[data-testid='email-send-blockers'] *, [data-testid='email-send-blockers']")).map((el) => el.getAttribute("class") ?? "");
    expect(classes.filter((c) => /(^|\s)(group-)?hover:|dark:|#[0-9a-f]{3,6}/i.test(c))).toEqual([]);
  });
});

describe("tools always show as four tiles, above the results", () => {
  beforeEach(() => {
    forgetEmailTestLists();
    set("GET /api/email-results", { emails: [] });
    set("GET /api/workspace/email-template", { template: { postal_address: "Cakely Bakery, 450 Valencia Street, San Francisco, CA 94103" }, fonts: [], can_edit: true });
    set("GET /api/workspace/sending-domain", { domain: null, suggested_domain: null, can_manage: true, bulk_email_ready: true, postal_address_set: true });
  });
  it("with Mailchimp connected all four tiles stay under their heading above the results, Mailchimp says Connected and reconnects through Composio, never Sending settings", async () => {
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    const { container } = render(<ChannelOverviewPanels panels={["email_connect", "email_sent_emails"]} />);
    await toolsSettled(["mailchimp"]);
    await screen.findByTestId("email-performance");
    const section = screen.getByTestId("email-connect");
    expect(within(section).getAllByRole("button").map((b) => b.textContent)).toEqual(["MailchimpConnected", "KlaviyoConnect", "GmailConnectOne-to-one emails only", "SendGridConnect"]);
    expect(screen.queryByTestId("email-connect-manage")).toBeNull();
    expect(headings(container).filter((h) => h !== "Before you send").slice(0, 2)).toEqual(["Your email tools", "How your emails are doing"]);
    composio.start.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Mailchimp, connected. Reconnect Mailchimp" }));
    expect(composio.start).toHaveBeenCalledTimes(1);
    expect(composio.start).toHaveBeenCalledWith("mailchimp");
    expect(goto).not.toHaveBeenCalled();
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("a tool that needs attention shows its reason on its own tile next to the connected one, and acting on it reconnects that tool", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [
        { route: "mailchimp", label: "Mailchimp", status: "complete", error: null, lists: [] },
        { route: "klaviyo", label: "Klaviyo", status: "unreadable", error: "Klaviyo rejected the key Zavi has saved for it.", lists: [] },
        { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] },
      ],
      orphans: [],
    });
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    render(<ChannelOverviewPanels panels={["email_connect"]} />);
    await toolsSettled(["mailchimp"]);
    const section = screen.getByTestId("email-connect");
    const klaviyo = within(section).getByRole("button", { name: "Klaviyo needs attention: key rejected. Reconnect Klaviyo" });
    expect(klaviyo).toBe(within(section).getByTestId("email-connect-klaviyo"));
    expect(klaviyo.getAttribute("data-state")).toBe("attention");
    expect(klaviyo.getAttribute("data-issue")).toBe("rejected");
    expect(klaviyo.textContent).toBe("KlaviyoKey rejected");
    expect(within(klaviyo).getByTestId("email-connect-klaviyo-state").className).toMatch(/\btext-danger\b/);
    expect(within(section).getAllByRole("button")).toHaveLength(4);
    composio.start.mockClear();
    fireEvent.click(klaviyo);
    expect(composio.start).toHaveBeenCalledTimes(1);
    expect(composio.start).toHaveBeenCalledWith("klaviyo");
    expect(goto).not.toHaveBeenCalled();
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("with nothing connected the four tiles stay, under their own heading, above the results", async () => {
    set("GET /api/workspace/email-test-lists", { routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] }], orphans: [] });
    const { container } = render(<ChannelOverviewPanels panels={["email_connect", "email_sent_emails"]} />);
    await screen.findByRole("button", { name: "Connect Mailchimp" });
    await screen.findByTestId("email-performance");
    expect(screen.queryByTestId("email-sending-with")).toBeNull();
    expect(headings(container).filter((h) => h !== "Before you send").slice(0, 2)).toEqual(["Connect your email tool", "How your emails are doing"]);
  });

  it("a tile that could not be reached starts that tool's connection, never only a silent re-read", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [
        { route: "klaviyo", label: "Klaviyo", status: "unreadable", error: "Klaviyo could not be read right now. Try again in a minute.", lists: [] },
        { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] },
      ],
      orphans: [],
    });
    render(<ChannelOverviewPanels panels={["email_connect"]} />);
    const tile = await screen.findByRole("button", { name: "Klaviyo needs attention: couldn't reach it. Reconnect Klaviyo" });
    expect(tile.textContent).toBe("KlaviyoCan't reach");
    composio.start.mockClear();
    fireEvent.click(tile);
    expect(composio.start).toHaveBeenCalledTimes(1);
    expect(composio.start).toHaveBeenCalledWith("klaviyo");
  });
});
