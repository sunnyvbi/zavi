// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body: unknown; idempotent?: boolean };
const calls: Call[] = [];
const routes: Record<string, Array<{ status: number; body: unknown }>> = {};
const gates: Partial<Record<string, Promise<void>>> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string, init?: { method?: string; body?: string; idempotent?: boolean }) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url}`;
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined, idempotent: init?.idempotent });
    if (gates[key]) await gates[key];
    const queue = routes[key];
    const r = queue && queue.length > 1 ? queue.shift()! : (queue?.[0] ?? { status: 200, body: { ok: true } });
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));
const lock = vi.hoisted(() => ({ value: null as null | { tierName: string | null; upgrade: (t?: unknown) => void } }));
vi.mock("../../actions/channelPlanLock", () => ({
  useChannelPlanLock: () => lock.value,
  upgradeOnPlanRefusal: (l: { upgrade: () => void } | null, e: { status?: number; body?: { error?: { code?: string } } }) => {
    if (l && e?.status === 403 && e.body?.error?.code === "plan_upgrade_required") {
      l.upgrade();
      return true;
    }
    return false;
  },
}));

import { EmailHeadTools } from "../EmailHeadTools";
import { ChannelPageHeaderSlotProvider } from "../../layout/ChannelHeaderRow";
import { SENDGRID_SETUP_COPY, NewCampaignDialog, PLAN_DROPS_LINES, DONE_CLOSE_MS, EMAIL_PLAN_CHANGED_EVENT, HELD_LIST_GONE, PASTE_DONE, newCampaignSession } from "../NewCampaignDialog";
import { CHANNEL_ACTIONS_CHANGED_EVENT, CHANNEL_RUN_STARTED_EVENT } from "../../actions/topActions/api";
import { EMAIL_SETTINGS_GOTO_EVENT } from "../emailSettingsNav";
import { longDay } from "../../ugc/DatePicker";
import { clockLabel } from "../TimePicker";

const START = "POST /api/channels/email_marketing/top-actions/new_email";
const PASTE = "POST /api/email-cards/paste";
const SENDING = "GET /api/workspace/sending-domain";
const senderState = (ready: boolean, status: "pending" | "verified" | "failed" | null) => ({
  domain: status ? { domain: "acme.com", status, from_address: "hi@acme.com", dns_records: [], last_error: null, verified_at: status === "verified" ? "2026-10-01T00:00:00Z" : null } : null,
  suggested_domain: null,
  can_manage: true,
  bulk_email_ready: ready,
  postal_address_set: true,
});
const CARD_LINK = "/w/acme/channels/email_marketing?card=card-7";
const set = (key: string, body: unknown, status = 200) => {
  routes[key] = [{ status, body }];
};
const queue = (key: string, ...answers: Array<{ status: number; body: unknown }>) => {
  routes[key] = answers;
};
const sent = (key: string) => calls.filter((c) => `${c.method} ${c.url}` === key);
const BODY = "Hi there,\n\nOur spring sale starts Friday. Every plan is 20% off until Sunday.\n\nSee you soon.";

function open(onClose = vi.fn()) {
  render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={onClose} />);
  return onClose;
}
const primary = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
async function pickList(name: RegExp) {
  const radio = (await screen.findByRole("radio", { name })) as HTMLInputElement;
  fireEvent.click(radio);
  return radio;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayButton = () => screen.getByRole("button", { name: "Day" }) as HTMLButtonElement;
function calendar() {
  if (dayButton().getAttribute("aria-expanded") !== "true") fireEvent.click(dayButton());
  return within(screen.getByRole("dialog", { name: "Choose a day" }));
}
function showMonth(iso: string) {
  const cal = calendar();
  const [y, m] = iso.split("-").map(Number);
  for (let i = 0; i < 60; i++) {
    const [name, year] = cal.getByText(/^[A-Z][a-z]+ \d{4}$/).textContent!.split(" ");
    const diff = (y - Number(year)) * 12 + (m - 1 - MONTHS.indexOf(name));
    if (diff === 0) return cal;
    const step = cal.getByRole("button", { name: diff > 0 ? "Next month" : "Previous month" }) as HTMLButtonElement;
    if (step.disabled) throw new Error(`cannot reach ${iso}: ${step.getAttribute("aria-label")} is off`);
    fireEvent.click(step);
  }
  throw new Error(`cannot reach ${iso}`);
}
const dayCell = (iso: string) => showMonth(iso).getByRole("button", { name: longDay(iso)! }) as HTMLButtonElement;
function pickDay(iso: string) {
  const cell = dayCell(iso);
  expect(cell.disabled).toBe(false);
  fireEvent.click(cell);
  expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
  expect(dayButton().textContent).toBe(longDay(iso));
}
function pickClock(hhmm: string) {
  const trigger = screen.getByRole("button", { name: "Time" });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole("listbox", { name: "Time" })).getByRole("option", { name: clockLabel(hhmm) }));
  expect(screen.queryByRole("listbox", { name: "Time" })).toBeNull();
}
function closeCalendar() {
  if (screen.queryByRole("dialog", { name: "Choose a day" })) fireEvent.click(dayButton());
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  for (const k of Object.keys(gates)) delete gates[k];
  ws.role = "owner";
  lock.value = null;
  set("GET /api/workspace/email-test-lists", {
    routes: [
      {
        route: "mailchimp",
        label: "Mailchimp",
        status: "complete",
        error: null,
        lists: [
          { id: "L1", name: "Paying customers", people: 300, marked: false, looks_like_test: false },
          { id: "T1", name: "Staff test", people: 2, marked: true, looks_like_test: true },
          { id: "E1", name: "Empty list", people: 0, marked: false, looks_like_test: false },
        ],
      },
      { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] },
    ],
    orphans: [],
  });
  set("GET /api/workspace/email-template", { template: { postal_address: "1 Main St, Springfield, IL 62701", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true });
  set("GET /api/channels/email_marketing/settings", { fields: {} });
  set(SENDING, senderState(true, "verified"));
  set(START, { run_id: "run-1" });
  set(PASTE, { ok: true, card: { rail: "decisions", id: "card-7" }, link: CARD_LINK, route: "mailchimp", versions: 1 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("New campaign builder", () => {
  it("shows the four steps; test lists are visible but cannot be picked", async () => {
    open();
    for (const step of ["To", "Email", "Zavi checks", "When"]) expect(screen.getByRole("region", { name: step })).toBeTruthy();
    const test = (await screen.findByRole("radio", { name: /Staff test/ })) as HTMLInputElement;
    expect(test.disabled).toBe(true);
    fireEvent.click(test);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    expect(screen.getByRole("region", { name: "To" }).textContent).toMatch(/not done/);
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    expect(sent(START)).toHaveLength(0);
  });

  it("Zavi writes it: sends the brief, the founder's subject and preview, to exactly the picked list, then tells the lane a run started", async () => {
    const started = vi.fn();
    window.addEventListener(CHANNEL_RUN_STARTED_EVENT, started);
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "  Spring sale: 20% off every plan until Sunday  " } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: "Spring sale" } });
    fireEvent.change(screen.getByLabelText(/Preview text/), { target: { value: "20% off until Sunday" } });
    fireEvent.click(primary(/Write it/));
    await screen.findByText(/Zavi is writing it/);
    expect(sent(START)).toHaveLength(1);
    const body = sent(START)[0].body as { request_id: string; inputs: unknown };
    expect(body.inputs).toEqual({ route: "zavi_list", list_id: "Z1", brief: "Spring sale: 20% off every plan until Sunday", subject: "Spring sale", preview_text: "20% off until Sunday" });
    expect(typeof body.request_id).toBe("string");
    expect(started).toHaveBeenCalledTimes(1);
    expect((started.mock.calls[0][0] as CustomEvent).detail).toEqual({ slug: "email_marketing" });
    window.removeEventListener(CHANNEL_RUN_STARTED_EVENT, started);
  });

  it("Paste my email: posts the pasted email word for word to the paste route, never starts the new_email action, and needs a subject", async () => {
    const started = vi.fn();
    window.addEventListener(CHANNEL_RUN_STARTED_EVENT, started);
    open();
    await pickList(/Paying customers/);
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    const promise = screen.getByRole("dialog").textContent ?? "";
    expect(promise).not.toMatch(/word for word/i);
    expect(promise).toMatch(/subject as the heading/);
    expect(promise).toMatch(/Read more button/);
    expect(promise).toMatch(/or to your website/);
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: `  ${BODY}  ` } });
    fireEvent.change(screen.getByLabelText(/Preview text/), { target: { value: "  20% off until Sunday " } });
    expect(primary(/Add it for approval/).disabled).toBe(true);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe("Add a subject to continue");
    fireEvent.click(primary(/Add it for approval/));
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "   " } });
    expect(primary(/Add it for approval/).disabled).toBe(true);
    fireEvent.click(primary(/Add it for approval/));
    expect(sent(PASTE)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: " Spring sale " } });
    fireEvent.click(primary(/Add it for approval/));
    expect(await screen.findByText(PASTE_DONE)).toBeTruthy();
    expect(PASTE_DONE).not.toMatch(/word for word/i);
    expect(PASTE_DONE).toMatch(/subject as the heading/);
    expect(PASTE_DONE).toMatch(/Read more button/);
    expect(sent(PASTE)).toHaveLength(1);
    expect(sent(PASTE)[0].body).toEqual({ inputs: { route: "mailchimp", list_id: "L1", pasted: { subject: "Spring sale", preview_text: "20% off until Sunday", body: BODY } } });
    expect(sent(PASTE)[0].idempotent).toBe(true);
    expect(sent(START)).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/top-actions/"))).toEqual([]);
    expect(started).not.toHaveBeenCalled();
    const openEmail = screen.getByRole("link", { name: "Open the email" }) as HTMLAnchorElement;
    expect(openEmail.getAttribute("href")).toBe(CARD_LINK);
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    window.removeEventListener(CHANNEL_RUN_STARTED_EVENT, started);
  });

  it("a paste is free: no credits are mentioned or reserved and no run starts, even when the run route would say out of credits", async () => {
    set(START, { error: { message: "You are out of credits." } }, 402);
    const started = vi.fn();
    window.addEventListener(CHANNEL_RUN_STARTED_EVENT, started);
    open();
    await pickList(/Paying customers/);
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring sale" } });
    expect(document.body.textContent).not.toMatch(/credit/i);
    fireEvent.click(primary(/Add it for approval/));
    await screen.findByRole("link", { name: "Open the email" });
    expect(document.body.textContent).not.toMatch(/credit|top up/i);
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`)).toEqual([PASTE]);
    expect(calls.some((c) => /top-actions|credit|reserve/.test(c.url))).toBe(false);
    expect(started).not.toHaveBeenCalled();
    window.removeEventListener(CHANNEL_RUN_STARTED_EVENT, started);
  });

  it("Write it never shows a credit estimate, even when every estimate source answers 120, and never asks for one", async () => {
    set("GET /api/channels/email_marketing/top-actions/new_email/context", { credits: 120, currency: "USD" });
    set("GET /api/channels", { channels: [{ channel_slug: "email_marketing", run_reserve_credits: 120, work_state: "idle" }] });
    set("GET /api/billing/credits", { credits_remaining: 5000, period_end: "2026-11-01T00:00:00Z" });
    const noCredit = () => {
      expect(document.body.textContent).not.toMatch(/credit/i);
      expect(document.body.textContent).not.toMatch(/\b120\b/);
    };
    open();
    noCredit();
    await pickList(/Members/);
    noCredit();
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale: 20% off every plan until Sunday" } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(primary(/Write it/).disabled).toBe(false);
    noCredit();
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    noCredit();
    fireEvent.click(screen.getByRole("button", { name: "Zavi writes it" }));
    noCredit();
    fireEvent.click(primary(/Write it/));
    await screen.findByText(/Zavi is writing it/);
    noCredit();
    expect(calls.filter((c) => c.method === "GET" && /\/context$|^\/api\/channels$|\/api\/billing\/credits|reserve/.test(c.url))).toEqual([]);
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`)).toEqual([START]);
  });

  it("a paste refused by the plan opens the upgrade and closes; any other paste error shows its message and keeps the email", async () => {
    const upgrade = vi.fn();
    lock.value = { tierName: null, upgrade };
    set(PASTE, { error: { code: "plan_upgrade_required", message: "Pasting needs Pro", required_tier: "pro" } }, 403);
    const onClose = open();
    await pickList(/Paying customers/);
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Add it for approval/));
    await waitFor(() => expect(upgrade).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
    expect(sent(START)).toHaveLength(0);
    cleanup();
    calls.length = 0;
    set(PASTE, { error: { code: "list_cooldown", message: "This list got an email 2 days ago." } }, 409);
    const onClose2 = open();
    await pickList(/Paying customers/);
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Add it for approval/));
    expect((await screen.findByRole("alert")).textContent).toBe("This list got an email 2 days ago.");
    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(onClose2).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Open the email" })).toBeNull();
    expect((screen.getByLabelText("Email body") as HTMLTextAreaElement).value).toBe(BODY);
    expect(primary(/Add it for approval/).disabled).toBe(false);
    expect(sent(START)).toHaveLength(0);
  });

  it("a pasted email tells this channel's lane to re-read its cards once it is saved, and never when the paste fails", async () => {
    const changed = vi.fn();
    window.addEventListener(CHANNEL_ACTIONS_CHANGED_EVENT, changed);
    const pasteOnce = async () => {
      await pickList(/Paying customers/);
      fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
      fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
      fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring sale" } });
      fireEvent.click(primary(/Add it for approval/));
    };
    set(PASTE, { error: { code: "list_cooldown", message: "This list got an email 2 days ago." } }, 409);
    open();
    await pasteOnce();
    await screen.findByRole("alert");
    expect(changed).not.toHaveBeenCalled();
    cleanup();
    let release!: () => void;
    gates[PASTE] = new Promise<void>((r) => (release = r));
    set(PASTE, { ok: true, card: { rail: "decisions", id: "card-7" }, link: CARD_LINK, route: "mailchimp", versions: 1 });
    open();
    await pasteOnce();
    await waitFor(() => expect(sent(PASTE)).toHaveLength(2));
    expect(changed).not.toHaveBeenCalled();
    release();
    await screen.findByRole("link", { name: "Open the email" });
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual({ slug: "email_marketing" });
    window.removeEventListener(CHANNEL_ACTIONS_CHANGED_EVENT, changed);
  });

  it("a two-line subject or a too-short paste never reaches the server", async () => {
    open();
    await pickList(/Paying customers/);
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring\u0007sale" } });
    expect(primary(/Add it for approval/).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring sale" } });
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: "Too short" } });
    expect(primary(/Add it for approval/).disabled).toBe(true);
    fireEvent.click(primary(/Add it for approval/));
    expect(sent(START)).toHaveLength(0);
  });

  it("with no saved template row, a real old footer setting lets the send go, and a failed setting read blocks and says so", async () => {
    set("GET /api/workspace/email-template", { template: null, fonts: [], can_edit: true });
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "  ", status: null }, { item: "  1 Main St, Springfield, IL 62701  ", status: null }] } });
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    expect(within(screen.getByTestId("new-campaign-checks")).queryByRole("button", { name: "Add it in Settings" })).toBeNull();
    cleanup();
    calls.length = 0;
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "1 Main St, Springfield, IL 62701", status: "dismissed" }] } });
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    await within(screen.getByTestId("new-campaign-checks")).findByRole("button", { name: "Add it in Settings" });
    expect(primary(/Write it/).disabled).toBe(true);
    cleanup();
    calls.length = 0;
    set("GET /api/channels/email_marketing/settings", { error: { message: "down" } }, 500);
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    expect(await screen.findByText(/could not read your footer/)).toBeTruthy();
    expect(primary(/Write it/).disabled).toBe(true);
  });

  it("a saved template row with no postal address blocks the send and points to Settings > Footer, whatever the old channel setting holds", async () => {
    set("GET /api/workspace/email-template", { template: null, fonts: [], can_edit: true });
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    const onClose = open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    const link = await within(screen.getByTestId("new-campaign-checks")).findByRole("button", { name: "Add it in Settings" });
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    expect(sent(START)).toHaveLength(0);
    fireEvent.click(link);
    expect(onClose).toHaveBeenCalled();
    expect((goto.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: "footer" });
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    cleanup();
    calls.length = 0;
    set("GET /api/workspace/email-template", { template: { postal_address: "   ", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true });
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "1 Main St, Springfield, IL 62701", status: null }] } });
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    await within(screen.getByTestId("new-campaign-checks")).findByRole("button", { name: "Add it in Settings" });
    await new Promise((r) => setTimeout(r, 30));
    expect(primary(/Write it/).disabled).toBe(true);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe("Add your postal address to continue");
    fireEvent.click(primary(/Write it/));
    expect(sent(START)).toHaveLength(0);
    cleanup();
    set("GET /api/workspace/email-template", { template: { postal_address: "1 Main St, Springfield, IL 62701", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true });
    set("GET /api/channels/email_marketing/settings", { fields: {} });
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
  });

  it("a footer that could not be read blocks Write it, Plan it and Paste, sends nothing, and Try again re-reads and unblocks each", async () => {
    const TEMPLATE = "GET /api/workspace/email-template";
    const PLAN = "POST /api/workspace/email-plan";
    set(TEMPLATE, { error: { message: "down" } }, 500);
    set("GET /api/channels/email_marketing/settings", { error: { message: "down" } }, 500);
    set(PLAN, { ok: true, id: "p1", label: "Mon", timezone: "UTC", list_name: "Paying customers", replayed: false });
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    expect(await screen.findByText(/could not read your footer/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(primary(/Write it/).disabled).toBe(true);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe("Check your footer again to continue");
    fireEvent.click(primary(/Write it/));
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: "Spring sale" } });
    expect(primary(/Add it for approval/).disabled).toBe(true);
    fireEvent.click(primary(/Add it for approval/));
    fireEvent.click(screen.getByRole("button", { name: "Zavi writes it" }));
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    pickDay("2026-11-02");
    expect(primary(/Plan it/).disabled).toBe(true);
    fireEvent.click(primary(/Plan it/));
    expect(sent(START)).toHaveLength(0);
    expect(sent(PASTE)).toHaveLength(0);
    expect(sent(PLAN)).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const reads = sent(TEMPLATE).length;
    set(TEMPLATE, { template: { postal_address: "1 Main St, Springfield, IL 62701", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true });
    fireEvent.click(within(screen.getByTestId("new-campaign-checks")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(sent(TEMPLATE).length).toBe(reads + 1));
    await waitFor(() => expect(primary(/Plan it/).disabled).toBe(false));
    expect(screen.queryByText(/could not read your footer/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    await waitFor(() => expect(primary(/Add it for approval/).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Zavi writes it" }));
    fireEvent.click(screen.getByRole("radio", { name: /As soon as it's approved/ }));
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    expect(sent(START)).toHaveLength(0);
    fireEvent.click(primary(/Write it/));
    await waitFor(() => expect(sent(START)).toHaveLength(1));
  });

  it("an unread footer offers Try again, and the retry re-reads and clears the message", async () => {
    set("GET /api/workspace/email-template", { error: { message: "down" } }, 500);
    set("GET /api/channels/email_marketing/settings", { error: { message: "down" } }, 500);
    open();
    await pickList(/Members/);
    expect(await screen.findByText(/could not read your footer/)).toBeTruthy();
    set("GET /api/workspace/email-template", { template: { postal_address: "1 Main St, Springfield, IL 62701", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true });
    fireEvent.click(within(screen.getByTestId("new-campaign-checks")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(/could not read your footer/)).toBeNull());
  });

  it("past sends that could not be checked show the 7-day row as needing attention, not passed, and do not block", async () => {
    set("GET /api/email-results", { error: { message: "down" } }, 500);
    open();
    await pickList(/Paying customers/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    const checks = within(screen.getByTestId("new-campaign-checks"));
    expect(await checks.findByText("Zavi could not check past sends just now")).toBeTruthy();
    const row = checks.getByText("One email per list in 7 days").closest("li")!;
    expect(row.textContent).toMatch(/needs attention/);
    expect(row.textContent).not.toMatch(/passed/);
    expect(row.querySelector("svg.text-success")).toBeNull();
    expect(row.querySelector("svg.text-warn")).not.toBeNull();
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    expect(sent("GET /api/email-results").length).toBeGreaterThan(0);
    cleanup();
    set("GET /api/email-results", { emails: [] });
    open();
    await pickList(/Paying customers/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    const fresh = within(screen.getByTestId("new-campaign-checks"));
    await waitFor(() => expect(fresh.queryByText("One email per list in 7 days")).toBeNull());
    expect(fresh.queryByText("Zavi could not check past sends just now")).toBeNull();
  });

  it("while past sends are still loading the 7-day row is not flagged and never says it could not check; only a failed read flags it", async () => {
    const PAST = "GET /api/email-results";
    const hold = () => {
      let release!: () => void;
      gates[PAST] = new Promise<void>((r) => (release = r));
      return () => act(async () => release());
    };
    const rowOf = () => within(screen.getByTestId("new-campaign-checks")).getByText("One email per list in 7 days").closest("li")!;
    let release = hold();
    set(PAST, { error: { message: "down" } }, 500);
    open();
    await pickList(/Paying customers/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    await waitFor(() => expect(sent(PAST).length).toBeGreaterThan(0));
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    expect(rowOf().textContent).toMatch(/checking/);
    expect(rowOf().textContent).not.toMatch(/needs attention/);
    expect(rowOf().querySelector("svg.text-warn")).toBeNull();
    expect(rowOf().querySelector("svg.animate-spin")).not.toBeNull();
    expect(rowOf().textContent).toMatch(/Checking…/);
    expect(screen.queryByText("Zavi could not check past sends just now")).toBeNull();
    await release();
    expect(await screen.findByText("Zavi could not check past sends just now")).toBeTruthy();
    expect(rowOf().textContent).toMatch(/needs attention/);
    expect(rowOf().querySelector("svg.text-warn")).not.toBeNull();
    expect(rowOf().textContent).not.toMatch(/Checking…/);
    expect(primary(/Write it/).disabled).toBe(false);
    cleanup();
    release = hold();
    set(PAST, { emails: [] });
    open();
    await pickList(/Paying customers/);
    await waitFor(() => expect(sent(PAST).length).toBeGreaterThan(1));
    expect(rowOf().querySelector("svg.text-warn")).toBeNull();
    expect(screen.queryByText("Zavi could not check past sends just now")).toBeNull();
    await release();
    await waitFor(() => expect(within(screen.getByTestId("new-campaign-checks")).queryByText("One email per list in 7 days")).toBeNull());
    expect(screen.queryByText("Zavi could not check past sends just now")).toBeNull();
  });

  it("the 7-day check matches past sends by list id, so a same-named list in the same tool is not flagged and the list that got one is", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [
        {
          route: "mailchimp",
          label: "Mailchimp",
          status: "complete",
          error: null,
          lists: [
            { id: "L1", name: "Customers", people: 300, marked: false, looks_like_test: false },
            { id: "L2", name: "Customers", people: 120, marked: false, looks_like_test: false },
            { id: "L3", name: "Old buyers", people: 50, marked: false, looks_like_test: false },
          ],
        },
        { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Customers", people: 40, marked: false, looks_like_test: false }] },
      ],
      orphans: [],
    });
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    set("GET /api/email-results", {
      emails: [
        { route: "mailchimp", list_id: "L2", list_name: "Customers", started_at: day(1) },
        { route: "mailchimp", list_id: null, list_name: "Old buyers", started_at: day(2) },
      ],
      more: false,
    });
    open();
    const radios = (await screen.findAllByRole("radio", { name: /Customers/ })) as HTMLInputElement[];
    const byValue = (v: string) => radios.find((r) => r.value === v)!;
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    const rowOf = () => within(screen.getByTestId("new-campaign-checks")).getByText("One email per list in 7 days").closest("li")!;
    await waitFor(() => expect(sent("GET /api/email-results").length).toBeGreaterThan(0));
    fireEvent.click(byValue("mailchimp:L2"));
    await waitFor(() => expect(rowOf().textContent).toMatch(/This list got one on/));
    expect(rowOf().textContent).toMatch(/needs attention/);
    fireEvent.click(byValue("mailchimp:L1"));
    await waitFor(() => expect(within(screen.getByTestId("new-campaign-checks")).queryByText("One email per list in 7 days")).toBeNull());
    fireEvent.click(byValue("zavi_list:Z1"));
    expect(within(screen.getByTestId("new-campaign-checks")).queryByText("One email per list in 7 days")).toBeNull();
    fireEvent.click(await screen.findByRole("radio", { name: /Old buyers/ }));
    expect(rowOf().textContent).toMatch(/This list got one on/);
  });

  it("an empty list cannot be sent to", async () => {
    open();
    await pickList(/Empty list/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    expect(await screen.findByText("This list has no one on it")).toBeTruthy();
    expect(primary(/Write it/).disabled).toBe(true);
  });

  it("a double press starts one run", async () => {
    let release: () => void = () => undefined;
    gates[START] = new Promise((r) => (release = r));
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    const button = primary(/Write it/);
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: /Starting/ }));
    await act(async () => release());
    await screen.findByText(/Zavi is writing it/);
    expect(sent(START)).toHaveLength(1);
  });

  it("a retry after a lost answer reuses the request id; a changed email gets a new one", async () => {
    queue(START, { status: 500, body: { error: { message: "Lost" } } }, { status: 500, body: { error: { message: "Lost again" } } }, { status: 200, body: { run_id: "run-2" } });
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Write it/));
    expect(await screen.findByText("Lost")).toBeTruthy();
    fireEvent.click(primary(/Write it/));
    expect(await screen.findByText("Lost again")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Summer sale" } });
    fireEvent.click(primary(/Write it/));
    await screen.findByText(/Zavi is writing it/);
    const ids = sent(START).map((c) => (c.body as { request_id: string }).request_id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it("a refused request (4xx) starts fresh, so the next press is a new request", async () => {
    queue(START, { status: 409, body: { error: { message: "Busy" } } }, { status: 200, body: { run_id: "run-3" } });
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Write it/));
    expect(await screen.findByText("Busy")).toBeTruthy();
    fireEvent.click(primary(/Write it/));
    await screen.findByText(/Zavi is writing it/);
    const ids = sent(START).map((c) => (c.body as { request_id: string }).request_id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("out of credits shows the server's top-up sentence once, not a second Top up after it", async () => {
    const SERVER = "You're out of credits. Top up in Billing to keep your agents running.";
    set(START, { error: { code: "insufficient_credits", message: SERVER, action: "top_up" } }, 402);
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Write it/));
    const alert = await screen.findByText(/out of credits/);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(SERVER);
    expect(document.body.textContent!.match(/top up/gi)).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/then try again/);
    expect(sent(START)).toHaveLength(1);
  });

  it("a plan refusal opens the upgrade instead of a credits message", async () => {
    const upgrade = vi.fn();
    lock.value = { tierName: null, upgrade };
    set(START, { error: { code: "plan_upgrade_required", message: "Pro" } }, 403);
    const onClose = open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Write it/));
    await waitFor(() => expect(upgrade).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("Pick a time plans it through the plan, not a run, within the plan's 120 characters", async () => {
    set("POST /api/workspace/email-plan", { ok: true, id: "p1", label: "Wed, Oct 21, 09:00 PDT", timezone: "America/Los_Angeles", list_name: "Members", replayed: false });
    const changed = vi.fn();
    window.addEventListener(EMAIL_PLAN_CHANGED_EVENT, changed);
    open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "x".repeat(121) } });
    pickDay("2026-10-21");
    expect(primary(/Plan it/).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Wed, Oct 21, 09:00 PDT")).toBeTruthy();
    expect(sent(START)).toHaveLength(0);
    const plan = sent("POST /api/workspace/email-plan")[0].body as Record<string, unknown>;
    expect(plan).toMatchObject({ route: "zavi_list", list_id: "Z1", date: "2026-10-21", time: "09:00", angle: "Holiday hours" });
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(EMAIL_PLAN_CHANGED_EVENT, changed);
  });

  it("a subject typed before picking a time is never shown as the planned email's subject, because the plan cannot carry it", async () => {
    set("POST /api/workspace/email-plan", { ok: true, id: "p1", label: "Wed, Oct 21, 09:00 PDT", timezone: "America/Los_Angeles", list_name: "Members", replayed: false });
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    fireEvent.change(document.querySelector('[data-field="subject"] input, input[data-field="subject"]') as HTMLInputElement, { target: { value: "Typed then dropped" } });
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    pickDay("2026-10-21");
    fireEvent.click(primary(/Plan it/));
    const panel = await screen.findByTestId("new-campaign-started");
    expect(sent("POST /api/workspace/email-plan")[0].body).not.toHaveProperty("subject");
    expect(panel.textContent).not.toContain("Typed then dropped");
    expect(panel.textContent).not.toContain("Subject");
    expect(panel.textContent).toContain("Members");
    expect(panel.textContent).toContain("Wed, Oct 21, 09:00 PDT");
    expect(panel.textContent).toContain("Holiday hours");
  });

  it("a planned campaign closes the dialog on its own once the plan is confirmed, once, and only after the founder had time to read it", async () => {
    set("POST /api/workspace/email-plan", { ok: true, id: "p1", label: "Wed, Oct 21, 09:00 PDT", timezone: "America/Los_Angeles", list_name: "Members", replayed: false });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onClose = open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    pickDay("2026-10-21");
    fireEvent.click(primary(/Plan it/));
    const done = await screen.findByRole("button", { name: "Done" });
    expect(done.className.split(/\s+/)).toEqual(expect.arrayContaining(["inline-flex", "items-center", "justify-center"]));
    expect(screen.getByText("Email planned")).toBeTruthy();
    await act(async () => {});
    expect(onClose).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(DONE_CLOSE_MS - 50));
    expect(onClose).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(100));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(DONE_CLOSE_MS * 3));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a failed plan never closes the dialog, so the founder still sees why", async () => {
    set("POST /api/workspace/email-plan", { error: { code: "bad", message: "That list is gone." } }, 422);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onClose = open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    pickDay("2026-10-21");
    fireEvent.click(primary(/Plan it/));
    await screen.findByRole("alert");
    act(() => void vi.advanceTimersByTime(DONE_CLOSE_MS * 4));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("As soon as it's approved closes on its own after Zavi starts writing it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onClose = open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Write it/));
    await screen.findByRole("button", { name: "Done" });
    expect(screen.getByText(/Zavi is writing it/)).toBeTruthy();
    await act(async () => {});
    expect(onClose).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(DONE_CLOSE_MS + 50));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a pasted email stays open on its Open the email link instead of closing under the founder", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onClose = open();
    await pickList(/Paying customers/);
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Add it for approval/));
    expect(await screen.findByText(PASTE_DONE)).toBeTruthy();
    act(() => void vi.advanceTimersByTime(DONE_CLOSE_MS * 4));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open the email" })).toBeTruthy();
  });

  it("closing the dialog before the auto-close fires leaves no stray close behind", async () => {
    set("POST /api/workspace/email-plan", { ok: true, id: "p1", label: "Wed, Oct 21, 09:00 PDT", timezone: "America/Los_Angeles", list_name: "Members", replayed: false });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onClose = open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    pickDay("2026-10-21");
    fireEvent.click(primary(/Plan it/));
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    act(() => void vi.advanceTimersByTime(DONE_CLOSE_MS * 2));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the When options are 56px selectable cards with a 20px radio, and the selected one reads as selected", async () => {
    open();
    await pickList(/Members/);
    const approve = screen.getByRole("radio", { name: "As soon as it's approved" });
    const time = screen.getByRole("radio", { name: "Pick a time" });
    const approveCard = approve.closest("label")!;
    expect(approveCard.className).toContain("border-ink");
    expect(approveCard.className).toContain("bg-creamDeep");
    expect(approveCard.className).toContain("min-h-[56px]");
    expect(approve.nextElementSibling!.className).toContain("h-5 w-5");
    fireEvent.click(time);
    const timeCard = time.closest("label")!.parentElement!;
    expect(timeCard.className).toContain("border-ink");
    expect(timeCard.className).toContain("bg-creamDeep");
    expect(approveCard.className.split(" ")).not.toContain("bg-creamDeep");
    expect(approveCard.className).toContain("border-rule");
    expect(screen.getByRole("button", { name: "Day" }).className).toContain("h-11");
    expect(screen.getByRole("button", { name: "Time" }).className).toContain("h-11");
  });

  it("Pick a time does not check a hidden subject it will not send, and the subject comes back for approval", async () => {
    set("POST /api/workspace/email-plan", { ok: true, id: "p1", label: "Wed, Oct 21, 09:00 PDT", timezone: "America/Los_Angeles", list_name: "Members", replayed: false });
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: "Q".repeat(70) } });
    const checks = screen.getByTestId("new-campaign-checks");
    expect(within(checks).getByText("Subject under 60 characters")).toBeTruthy();
    expect(within(checks).getByText("70 characters")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    expect(screen.queryByLabelText(/Subject/)).toBeNull();
    expect(within(checks).queryByText(/Subject under/)).toBeNull();
    expect(within(checks).queryByText("70 characters")).toBeNull();
    pickDay("2026-10-21");
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Wed, Oct 21, 09:00 PDT")).toBeTruthy();
    const plan = sent("POST /api/workspace/email-plan")[0].body as Record<string, unknown>;
    expect(plan).not.toHaveProperty("subject");
    expect(plan).not.toHaveProperty("preview_text");
    expect(sent(START)).toHaveLength(0);
  });

  it("switching back to As soon as it's approved checks and sends the typed subject again", async () => {
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: "Q".repeat(70) } });
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.click(screen.getByRole("radio", { name: /As soon as it/ }));
    const checks = screen.getByTestId("new-campaign-checks");
    expect(within(checks).getByText("Subject under 60 characters")).toBeTruthy();
    expect(within(checks).getByText("70 characters")).toBeTruthy();
    fireEvent.click(primary(/Write it/));
    await screen.findByText(/Zavi is writing it/);
    expect((sent(START)[0].body as { inputs: Record<string, unknown> }).inputs).toMatchObject({ brief: "Holiday hours", subject: "Q".repeat(70) });
  });

  it("a pasted email can only go out on approval", async () => {
    open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    const pick = screen.getByRole("radio", { name: /Pick a time/ }) as HTMLInputElement;
    expect(pick.disabled).toBe(true);
    expect((screen.getByRole("radio", { name: /As soon as it/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("a member cannot start a campaign", async () => {
    ws.role = "member";
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    expect(screen.getByText("Only an owner or admin can start a campaign.")).toBeTruthy();
    expect(primary(/Write it/).disabled).toBe(true);
  });

  it("with no list anywhere it points to Contacts instead of an empty picker", async () => {
    set("GET /api/workspace/email-test-lists", { routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] }], orphans: [] });
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    open();
    fireEvent.click(await within(await screen.findByTestId("new-campaign-no-lists")).findByRole("button", { name: /upload contacts/ }));
    expect((goto.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: "contacts" });
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  async function planFor(angle: string) {
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: angle } });
    pickDay("2026-10-21");
  }

  it("a plan with no answer freezes the email, so pressing again can only resend the same request", async () => {
    const PLAN = "POST /api/workspace/email-plan";
    queue(PLAN, { status: 503, body: { error: { message: "gone" } } }, { status: 200, body: { ok: true, id: "p1", label: "Wed, Oct 21, 09:00 PDT", timezone: "America/Los_Angeles", list_name: "Members", replayed: true } });
    open();
    await planFor("Holiday hours");
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText(/same request, so it cannot be planned twice/)).toBeTruthy();
    const brief = screen.getByLabelText("What should this email do?") as HTMLTextAreaElement;
    expect(brief.disabled).toBe(true);
    expect(dayButton().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Time" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: /Paying customers/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: /As soon as it/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Paste my email" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    const bodies = sent(PLAN).map((c) => c.body as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("a refused plan unfreezes and the next try is a new request", async () => {
    const PLAN = "POST /api/workspace/email-plan";
    queue(PLAN, { status: 409, body: { error: { code: "list_cooldown", message: "This list got an email 2 days ago." } } }, { status: 200, body: { ok: true, id: "p2", label: "Thu", timezone: "UTC", list_name: "Members", replayed: false } });
    open();
    await planFor("Holiday hours");
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText(/got an email 2 days ago/)).toBeTruthy();
    expect((screen.getByLabelText("What should this email do?") as HTMLTextAreaElement).disabled).toBe(false);
    pickDay("2026-10-28");
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    const ids = sent(PLAN).map((c) => (c.body as { request_id: string }).request_id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each([
    [
      "the footer is now a placeholder",
      "zavi_list:Z1",
      () => set("GET /api/workspace/email-template", { template: { postal_address: "Street, city, state, ZIP", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true }),
    ],
    ["Zavi's sender is no longer ready", "zavi_list:Z1", () => set(SENDING, senderState(false, "pending"))],
  ])("a held plan that can no longer be confirmed (%s) can be dropped, and the next plan is a new request to a list the founder picks", async (_name, key, arrange) => {
    arrange();
    const PLAN = "POST /api/workspace/email-plan";
    set(PLAN, { ok: true, id: "p9", label: "Wed, Oct 21, 09:00 PDT", timezone: "UTC", list_name: "Paying customers", replayed: false });
    const session = newCampaignSession();
    const heldId = session.planId;
    session.planPending = { key, angle: "Holiday hours", date: "2026-10-21", time: "09:00" };
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} session={session} />);
    const paying = (await screen.findByRole("radio", { name: /Paying customers/ })) as HTMLInputElement;
    await waitFor(() => expect(screen.queryAllByText(/Checking…/)).toHaveLength(0));
    expect(primary(/Plan it/).disabled).toBe(true);
    expect(paying.disabled).toBe(true);
    const repair = screen.getAllByRole("button", { name: /in Settings/ }) as HTMLButtonElement[];
    expect(repair.length).toBeGreaterThan(0);
    for (const r of repair) expect(r.disabled).toBe(false);
    fireEvent.click(primary(/Plan it/));
    expect(sent(PLAN)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(session.planPending).toBeNull();
    expect(session.planId).not.toBe(heldId);
    expect(screen.getByRole("alert").textContent).toMatch(/Check Coming up before you plan it again/);
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
    expect(paying.disabled).toBe(false);
    for (const b of screen.queryAllByRole("button", { name: /in Settings/ })) expect((b as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("What should this email do?") as HTMLTextAreaElement).disabled).toBe(false);
    if (_name === "the footer is now a placeholder") return;
    fireEvent.click(paying);
    expect(primary(/Plan it/).disabled).toBe(false);
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    const body = sent(PLAN)[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ route: "mailchimp", list_id: "L1", angle: "Holiday hours", date: "2026-10-21", time: "09:00" });
    expect(body.request_id).not.toBe(heldId);
  });

  it.each([
    ["its list is gone", "zavi_list:GONE"],
    ["its list is now a test list", "mailchimp:T1"],
  ])("a held plan whose list is no longer pickable (%s) is dropped on open: new request id, list picker unlocked, and the founder is told to pick a list", async (_name, key) => {
    const PLAN = "POST /api/workspace/email-plan";
    set(PLAN, { ok: true, id: "p9", label: "Wed, Oct 21, 09:00 PDT", timezone: "UTC", list_name: "Paying customers", replayed: false });
    const session = newCampaignSession();
    const heldId = session.planId;
    session.planPending = { key, angle: "Holiday hours", date: "2026-10-21", time: "09:00" };
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} session={session} />);
    expect(await screen.findByText(HELD_LIST_GONE)).toBeTruthy();
    expect(HELD_LIST_GONE).toBe("The list from your last try is no longer available. Pick a list to plan again.");
    expect(session.planPending).toBeNull();
    expect(session.planId).not.toBe(heldId);
    expect(screen.queryByText(/same request, so it cannot be planned twice/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
    const paying = screen.getByRole("radio", { name: /Paying customers/ }) as HTMLInputElement;
    expect(paying.disabled).toBe(false);
    expect((screen.getByLabelText("What should this email do?") as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.click(paying);
    await waitFor(() => expect(primary(/Plan it/).disabled).toBe(false));
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    const body = sent(PLAN)[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ route: "mailchimp", list_id: "L1", angle: "Holiday hours" });
    expect(body.request_id).not.toBe(heldId);
  });

  it("a held plan whose list is still there stays held and replays the same request, while its repair buttons stay usable", async () => {
    const PLAN = "POST /api/workspace/email-plan";
    set("GET /api/workspace/email-template", { error: { message: "down" } }, 500);
    set(PLAN, { ok: true, id: "p9", label: "Wed, Oct 21, 09:00 PDT", timezone: "UTC", list_name: "Paying customers", replayed: true });
    const session = newCampaignSession();
    const heldId = session.planId;
    session.planPending = { key: "mailchimp:L1", angle: "Holiday hours", date: "2099-10-21", time: "09:00" };
    render(<NewCampaignDialog slug="email_marketing" channelName="Email campaigns" onClose={vi.fn()} session={session} />);
    const paying = (await screen.findByRole("radio", { name: /Paying customers/ })) as HTMLInputElement;
    expect(await screen.findByText(/could not read your footer/)).toBeTruthy();
    expect(screen.queryByText(HELD_LIST_GONE)).toBeNull();
    expect(session.planPending).not.toBeNull();
    expect(session.planId).toBe(heldId);
    expect(paying.checked).toBe(true);
    expect(paying.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Start over" })).toBeTruthy();
    const retry = within(screen.getByTestId("new-campaign-checks")).getByRole("button", { name: "Try again" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    set("GET /api/workspace/email-template", { template: { postal_address: "1 Main St, Springfield, IL 62701", logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByText(/could not read your footer/)).toBeNull());
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    expect((sent(PLAN)[0].body as { request_id: string }).request_id).toBe(heldId);
  });
});

describe("builder UX fixes", () => {
  const LISTS = "GET /api/workspace/email-test-lists";
  const TEMPLATE = (postal: string | null) => ({ template: { postal_address: postal, logo_url: null, brand_color: "#111111", button_color: "#111111", font_key: "system", sign_off: "", show_cards: false }, fonts: [], can_edit: true });
  const postalRow = () => within(screen.getByTestId("new-campaign-checks")).getByText("Footer has your postal address").parentElement as HTMLElement;
  const missing = () => screen.queryByTestId("new-campaign-missing");
  const markers = () => screen.getAllByTestId("new-campaign-step-marker");
  let scrolled: HTMLElement[] = [];
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    } as Element["scrollIntoView"];
  });

  it.each([
    ["the test-street template", TEMPLATE("123 Test Street, San Francisco, CA 94105, USA"), { fields: {} }],
    ["the yoga studio template", TEMPLATE("Yoga Studio, 123 Test Street, Suite 4, San Francisco, CA 94105"), { fields: {} }],
    ["a placeholder template even when the setting holds a real one", TEMPLATE("Street, city, state, ZIP"), { fields: { postal_address: [{ item: "450 Valencia Street, San Francisco, CA 94103", status: null }] } }],
  ])("a placeholder postal address fails the check and blocks the send: %s", async (_name, template, settings) => {
    set("GET /api/workspace/email-template", template);
    set("GET /api/channels/email_marketing/settings", settings);
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    const onClose = open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    await within(screen.getByTestId("new-campaign-checks")).findByTestId("new-campaign-postal-placeholder");
    expect(postalRow().textContent).toMatch(/needs attention/);
    expect(postalRow().textContent).not.toMatch(/passed/);
    expect(screen.getByRole("region", { name: "Zavi checks" }).textContent).toMatch(/not done/);
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    expect(sent(START)).toHaveLength(0);
    expect(missing()?.textContent).toBe("Replace the placeholder postal address to continue");
    fireEvent.click(within(postalRow()).getByRole("button", { name: "Fix it in Settings" }));
    expect(onClose).toHaveBeenCalled();
    expect((goto.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: "footer" });
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("a real postal address passes the check even when it arrives after the lists", async () => {
    let release: () => void = () => undefined;
    gates["GET /api/workspace/email-template"] = new Promise((r) => (release = r));
    set("GET /api/workspace/email-template", TEMPLATE("Cakely Bakery, 450 Valencia Street, San Francisco, CA 94103"));
    open();
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    await act(async () => release());
    await waitFor(() => expect(screen.queryByText("Footer has your postal address")).toBeNull());
    expect(primary(/Write it/).disabled).toBe(false);
    expect(missing()).toBeNull();
  });

  it("an unreadable tool next to lists that loaded is one quiet line under the picker, not an alert, and Retry reads fresh", async () => {
    queue(
      LISTS,
      {
        status: 200,
        body: {
          routes: [
            { route: "klaviyo", label: "Klaviyo", status: "unreadable", error: "Key rejected", lists: [] },
            { route: "sendgrid", label: "SendGrid", status: "partial", error: "Timed out", lists: [] },
            { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] },
          ],
          orphans: [],
        },
      },
      { status: 200, body: { routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] }], orphans: [] } },
    );
    open();
    const line = await screen.findByTestId("new-campaign-unreadable");
    expect(line.textContent).toMatch(/^Lists from Klaviyo, SendGrid could not be loaded just now\.Retry$/);
    expect(line.getAttribute("role")).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(line.className).toMatch(/text-inkMuted/);
    expect(line.className).not.toMatch(/bg-|danger|#b4232a|#fdebec/);
    const to = screen.getByRole("region", { name: "To" });
    expect(to.contains(line)).toBe(true);
    const picker = within(to).getByRole("radiogroup", { name: "Who gets it" });
    expect(picker.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(/could not be loaded/)).toHaveLength(1);
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("new-campaign-unreadable")).toBeNull());
    expect(sent(LISTS)).toHaveLength(2);
  });

  it("a list read that fails with a bare 500 says the lists could not load, never the generic error, and Retry reads fresh and shows the lists", async () => {
    const ok = { routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] }], orphans: [] };
    queue(LISTS, { status: 500, body: {} }, { status: 200, body: ok });
    open();
    const to = screen.getByRole("region", { name: "To" });
    const alert = await within(to).findByRole("alert");
    expect(alert.textContent).toBe("Could not load your lists.Retry");
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(within(to).queryByRole("radio")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    const members = (await within(to).findByRole("radio", { name: /Members/ })) as HTMLInputElement;
    expect(members.disabled).toBe(false);
    expect(within(to).queryByRole("alert")).toBeNull();
    expect(sent(LISTS)).toHaveLength(2);
  });

  it("a list read that fails with a server reason still leads with the lists and keeps the reason", async () => {
    queue(LISTS, { status: 503, body: { error: { code: "upstream", message: "Mailchimp did not answer." } } });
    open();
    const alert = await within(screen.getByRole("region", { name: "To" })).findByRole("alert");
    expect(alert.textContent).toBe("Could not load your lists. Mailchimp did not answer.Retry");
  });

  it("a SendGrid key the tool rejected says so and points to Sending with no Retry, while a Klaviyo timeout keeps Retry and reads fresh", async () => {
    const rejected = "SendGrid rejected the key Zavi has saved for it (it was revoked or is no longer valid). Waiting will not fix this: go to Connectors, disconnect SendGrid, then reconnect it with a new API key.";
    const members = { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] };
    queue(
      LISTS,
      {
        status: 200,
        body: {
          routes: [
            { route: "sendgrid", label: "SendGrid", status: "unreadable", error: rejected, lists: [] },
            { route: "klaviyo", label: "Klaviyo", status: "unreadable", error: "Klaviyo did not answer in time. Try again in a minute.", lists: [] },
            members,
          ],
          orphans: [],
        },
      },
      {
        status: 200,
        body: {
          routes: [
            { route: "sendgrid", label: "SendGrid", status: "unreadable", error: rejected, lists: [] },
            { route: "klaviyo", label: "Klaviyo", status: "complete", error: null, lists: [{ id: "K1", name: "VIPs", people: 9, marked: false, looks_like_test: false }] },
            members,
          ],
          orphans: [],
        },
      },
    );
    const onClose = open();
    const key = await screen.findByTestId("new-campaign-key-rejected");
    const transient = screen.getByTestId("new-campaign-unreadable");
    expect(key.textContent).toBe("SendGrid rejected the key Zavi has saved, so its lists can't load.Reconnect in Sending");
    expect(transient.textContent).toBe("Lists from Klaviyo could not be loaded just now.Retry");
    expect(within(key).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(within(transient).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Retry" })).toEqual([within(transient).getByRole("button", { name: "Retry" })]);
    expect(screen.queryByText(/SendGrid.*could not be loaded/)).toBeNull();
    const to = screen.getByRole("region", { name: "To" });
    expect(to.contains(key)).toBe(true);

    fireEvent.click(within(transient).getByRole("button", { name: "Retry" }));
    await screen.findByText("VIPs");
    expect(screen.queryByTestId("new-campaign-unreadable")).toBeNull();
    expect(screen.getByTestId("new-campaign-key-rejected").textContent).toBe("SendGrid rejected the key Zavi has saved, so its lists can't load.Reconnect in Sending");
    expect(sent(LISTS)).toHaveLength(2);

    const sections: string[] = [];
    const goto = (e: Event) => sections.push((e as CustomEvent<{ section: string }>).detail.section);
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    fireEvent.click(within(screen.getByTestId("new-campaign-key-rejected")).getByRole("button", { name: "Reconnect in Sending" }));
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    expect(sections).toEqual(["sending"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sent(LISTS)).toHaveLength(2);
  });

  it("a rejected key with no list anywhere is an alert and never claims there is no list yet", async () => {
    set(LISTS, {
      routes: [{ route: "sendgrid", label: "SendGrid", status: "unreadable", error: "SendGrid rejected the key Zavi has saved for it (it was revoked or is no longer valid).", lists: [] }],
      orphans: [],
    });
    open();
    const key = await screen.findByTestId("new-campaign-key-rejected");
    expect(key.getAttribute("role")).toBe("alert");
    expect(screen.queryByTestId("new-campaign-no-lists")).toBeNull();
    expect(screen.queryByTestId("new-campaign-unreadable")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("when no tool loaded any list, the same line is an alert", async () => {
    set(LISTS, { routes: [{ route: "klaviyo", label: "Klaviyo", status: "unreadable", error: "Key rejected", lists: [] }], orphans: [] });
    open();
    const line = await screen.findByTestId("new-campaign-unreadable");
    expect(line.getAttribute("role")).toBe("alert");
    expect(screen.getAllByRole("alert")).toEqual([line]);
  });

  it("step markers are numbers 1 to 4 that turn into a check when done, never an empty circle", async () => {
    open();
    await screen.findByRole("radio", { name: /Members/ });
    const state = () =>
      markers().map((el) => {
        const svg = el.querySelector("svg");
        const text = el.textContent?.trim() ?? "";
        expect(svg !== null || text !== "").toBe(true);
        expect(svg !== null && text !== "").toBe(false);
        expect(el.getAttribute("data-done")).toBe(svg ? "true" : "false");
        return svg ? "done" : text;
      });
    expect(markers()).toHaveLength(4);
    expect(state()).toEqual(["1", "2", "3", "done"]);
    for (const [i, name] of ["To", "Email", "Zavi checks", "When"].entries()) {
      const region = screen.getByRole("region", { name });
      expect(region.contains(markers()[i])).toBe(true);
      expect(region.textContent).toMatch(state()[i] === "done" ? /\(done\)/ : /not done/);
    }
    await pickList(/Members/);
    expect(state()).toEqual(["done", "2", "3", "done"]);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    await waitFor(() => expect(state()).toEqual(["done", "done", "done", "done"]));
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    expect(state()).toEqual(["done", "done", "done", "4"]);
  });

  it("the footer names the first missing requirement in step order, and clicking it scrolls to and focuses that step", async () => {
    open();
    await screen.findByRole("radio", { name: /Members/ });
    expect(missing()?.textContent).toBe("Pick a list to continue");
    expect(primary(/Write it/).getAttribute("aria-describedby")).toBe(missing()!.id);
    fireEvent.click(missing()!);
    expect(scrolled).toEqual([screen.getByRole("region", { name: "To" })]);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Paying customers/ }));
    expect(sent(START)).toHaveLength(0);

    await pickList(/Empty list/);
    expect(missing()?.textContent).toBe("Pick a list with people on it");

    await pickList(/Members/);
    expect(missing()?.textContent).toBe("Say what the email should do");
    fireEvent.click(missing()!);
    expect(scrolled.at(-1)).toBe(screen.getByRole("region", { name: "Email" }));
    expect(document.activeElement).toBe(screen.getByLabelText("What should this email do?"));

    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: "Bad\u0007subject" } });
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    expect(missing()?.textContent).toBe("Fix the subject to continue");
    fireEvent.click(missing()!);
    expect(document.activeElement).toBe(screen.getByLabelText(/Subject/));
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: "" } });
    await waitFor(() => expect(missing()).toBeNull());
    expect(primary(/Write it/).disabled).toBe(false);
    expect(primary(/Write it/).getAttribute("aria-describedby")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    expect(missing()?.textContent).toBe("Pick a day and time to continue");
    fireEvent.click(missing()!);
    expect(scrolled.at(-1)).toBe(screen.getByRole("region", { name: "When" }));
    expect(document.activeElement).toBe(dayButton());

    fireEvent.click(screen.getByRole("radio", { name: /As soon as it/ }));
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    expect(missing()?.textContent).toBe("Paste your email to continue");
    fireEvent.click(missing()!);
    expect(document.activeElement).toBe(screen.getByLabelText("Email body"));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
    expect(missing()?.textContent).toBe("Add a subject to continue");
    fireEvent.click(missing()!);
    expect(document.activeElement).toBe(screen.getByLabelText("Subject"));
  });

  it("the missing postal address is named before anything is written and focuses the Settings link", async () => {
    set("GET /api/workspace/email-template", TEMPLATE(null));
    open();
    await pickList(/Members/);
    await waitFor(() => expect(missing()?.textContent).toBe("Add your postal address to continue"));
    expect((screen.getByLabelText("What should this email do?") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(missing()!);
    expect(scrolled.at(-1)).toBe(screen.getByRole("region", { name: "Zavi checks" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add it in Settings" }));
  });

  it("nothing is named while lists load, for a member, or once the email is ready", async () => {
    let release: () => void = () => undefined;
    gates[LISTS] = new Promise((r) => (release = r));
    open();
    expect(screen.getByText("Loading your lists…")).toBeTruthy();
    expect(missing()).toBeNull();
    await act(async () => release());
    expect(await screen.findByTestId("new-campaign-missing")).toBeTruthy();
    cleanup();
    ws.role = "member";
    open();
    await pickList(/Members/);
    expect(missing()).toBeNull();
  });

  it("the write-or-paste switch is the app's segmented control and its pressed state follows the picked mode", async () => {
    open();
    await screen.findByRole("radio", { name: /Members/ });
    const group = screen.getByRole("group", { name: "How to write the email" });
    const cls = group.className.split(/\s+/);
    expect(cls).toContain("bg-creamDeep");
    expect(cls).not.toContain("bg-white");
    expect(cls).not.toContain("border");
    expect(group.className).not.toMatch(/#[0-9a-f]{6}/i);
    const ai = within(group).getByRole("button", { name: "Zavi writes it" });
    const paste = within(group).getByRole("button", { name: "Paste my email" });
    const state = () => [ai, paste].map((b) => [b.getAttribute("aria-pressed"), b.className.split(/\s+/).includes("bg-white"), b.className.split(/\s+/).includes("text-inkMuted")]);
    expect(state()).toEqual([["true", true, false], ["false", false, true]]);
    fireEvent.click(paste);
    expect(state()).toEqual([["false", false, true], ["true", true, false]]);
    expect(screen.getByLabelText("Email body")).toBeTruthy();
    fireEvent.click(ai);
    expect(state()).toEqual([["true", true, false], ["false", false, true]]);
    expect(screen.getByLabelText("What should this email do?")).toBeTruthy();
  });

  it("the picked list card is marked in ink, never brand blue, and the test chip is muted", async () => {
    open();
    const card = (name: RegExp) => screen.getByRole("radio", { name }).closest("label") as HTMLElement;
    const classes = (el: HTMLElement) => el.className.split(/\s+/);
    await pickList(/Members/);
    expect(classes(card(/Members/))).toEqual(expect.arrayContaining(["border-ink", "bg-creamDeep"]));
    expect(card(/Members/).className).not.toMatch(/brand|blue|#2f62f0/i);
    for (const radio of screen.getAllByRole("radio")) {
      expect(classes(radio as HTMLElement)).toEqual(expect.arrayContaining(["peer", "sr-only"]));
      expect(radio.className).not.toContain("accent-ink");
      const [ring, dot] = Array.from(radio.parentElement!.querySelectorAll("span[aria-hidden]")) as HTMLElement[];
      expect(classes(ring)).toEqual(expect.arrayContaining(["rounded-full", "peer-checked:border-ink"]));
      expect(classes(dot)).toEqual(expect.arrayContaining(["bg-ink", "scale-0", "peer-checked:scale-100"]));
    }
    expect(classes(card(/Members/))).not.toContain("border-rule");
    for (const other of [/Paying customers/, /Empty list/, /Staff test/]) {
      expect(classes(card(other))).toContain("border-rule");
      expect(classes(card(other))).not.toContain("border-ink");
      expect(card(other).className).not.toMatch(/brand|blue|#2f62f0|bg-bone/i);
    }
    await pickList(/Paying customers/);
    expect(classes(card(/Paying customers/))).toContain("border-ink");
    expect(classes(card(/Members/))).not.toContain("border-ink");
    const chip = within(card(/Staff test/)).getByText("Test");
    expect(classes(chip)).toEqual(expect.arrayContaining(["rounded-full", "bg-creamDeep", "text-inkMuted"]));
    expect(chip.className).not.toMatch(/#[0-9a-f]{6}|orange|amber|warn/i);
  });

  it("list cards are roomy tap targets with a ring and fill on the picked one", async () => {
    open();
    const card = (name: RegExp) => screen.getByRole("radio", { name }).closest("label") as HTMLElement;
    const classes = (el: HTMLElement) => el.className.split(/\s+/);
    await pickList(/Members/);
    expect(classes(card(/Members/))).toEqual(expect.arrayContaining(["min-h-[60px]", "items-center", "px-4", "border-ink", "bg-creamDeep", "ring-1", "ring-ink"]));
    expect(classes(card(/Paying customers/))).toEqual(expect.arrayContaining(["min-h-[60px]", "bg-white", "border-rule"]));
    expect(classes(card(/Paying customers/))).not.toContain("ring-1");
  });
});

describe("SendGrid sender and group gate SendGrid lists before any credits are spent", () => {
  const SENDERS = "GET /api/workspace/sendgrid/senders";
  const GROUPS = "GET /api/workspace/sendgrid/suppression-groups";
  const SETTINGS = "GET /api/channels/email_marketing/settings";
  const sender = (id: string, verified = true) => ({ id, from_email: `${id}@acme.com`, from_name: id, verified });
  const group = (id: string, is_default = false) => ({ id, name: id, is_default });
  const checks = () => within(screen.getByTestId("new-campaign-checks"));
  const sendgridList = () =>
    set("GET /api/workspace/email-test-lists", {
      routes: [
        { route: "sendgrid", label: "SendGrid", status: "complete", error: null, lists: [{ id: "S1", name: "Guests", people: 40, marked: false, looks_like_test: false }] },
        { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] },
      ],
      orphans: [],
    });
  async function brief() {
    await pickList(/Guests/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
  }
  async function refused(text: string, missing: string) {
    open();
    await brief();
    expect(await checks().findByText(text)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    await new Promise((r) => setTimeout(r, 30));
    expect(sent(START)).toHaveLength(0);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe(missing);
  }

  beforeEach(sendgridList);

  it("two verified senders and none picked: refused before any run starts, and the button opens Sending", async () => {
    set(SENDERS, { senders: [sender("a"), sender("b")] });
    set(GROUPS, { groups: [group("g", true)] });
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    await refused(SENDGRID_SETUP_COPY.sender, "Pick a SendGrid sender to continue");
    fireEvent.click(screen.getByRole("button", { name: "Set it up in Settings" }));
    expect((goto.mock.calls[0][0] as CustomEvent).detail.section).toBe("sending");
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("no verified sender at all is refused, an unverified one does not count", async () => {
    set(SENDERS, { senders: [sender("a", false)] });
    set(GROUPS, { groups: [group("g", true)] });
    await refused(SENDGRID_SETUP_COPY.sender, "Pick a SendGrid sender to continue");
  });

  it("a picked sender that is no longer verified is refused", async () => {
    set(SENDERS, { senders: [sender("a"), sender("gone", false)] });
    set(GROUPS, { groups: [group("g", true)] });
    set(SETTINGS, { fields: { sendgrid_sender_id: [{ item: "gone" }] } });
    await refused(SENDGRID_SETUP_COPY.sender, "Pick a SendGrid sender to continue");
  });

  it("one sender but no single default group, and none picked, is refused", async () => {
    set(SENDERS, { senders: [sender("a")] });
    set(GROUPS, { groups: [group("g1"), group("g2")] });
    await refused(SENDGRID_SETUP_COPY.group, "Pick a SendGrid unsubscribe group to continue");
  });

  it("a failed read blocks, says so, and Check again clears it", async () => {
    set(SENDERS, { error: { code: "x", message: "down" } }, 500);
    set(GROUPS, { groups: [group("g", true)] });
    await refused(SENDGRID_SETUP_COPY.unknown, "Check SendGrid again to continue");
    set(SENDERS, { senders: [sender("a")] });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
  });

  it("one verified sender and one default group need no picks, matching what the server resolves", async () => {
    set(SENDERS, { senders: [sender("a")] });
    set(GROUPS, { groups: [group("g", true)] });
    open();
    await brief();
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
  });

  it("picked sender and group win with several of each", async () => {
    set(SENDERS, { senders: [sender("a"), sender("b")] });
    set(GROUPS, { groups: [group("g1"), group("g2")] });
    set(SETTINGS, { fields: { sendgrid_sender_id: [{ item: "b" }], sendgrid_suppression_group_id: [{ item: "g2" }] } });
    open();
    await brief();
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
  });

  it("switching to a Zavi list drops the SendGrid check, and it never reads SendGrid for a Zavi list", async () => {
    set(SENDERS, { senders: [sender("a"), sender("b")] });
    set(GROUPS, { groups: [group("g", true)] });
    open();
    await brief();
    expect(await checks().findByText(SENDGRID_SETUP_COPY.sender)).toBeTruthy();
    await pickList(/Members/);
    await waitFor(() => expect(checks().queryByText(SENDGRID_SETUP_COPY.label)).toBeNull());
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
  });
});

describe("Zavi's own sender gates Zavi lists", () => {
  const NOT_READY = "Zavi can't send to your lists yet: finish Sending setup, or connect SendGrid, Mailchimp or Klaviyo.";
  const checks = () => within(screen.getByTestId("new-campaign-checks"));
  async function writeTo(list: RegExp) {
    await pickList(list);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
  }

  it("a Zavi list while Zavi's bulk sender is not set up fails the check, names it in the footer, and no Write it, Add it or Plan it reaches the server", async () => {
    set(SENDING, senderState(false, "verified"));
    const goto = vi.fn();
    window.addEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
    const onClose = open();
    await writeTo(/Members/);
    expect(await checks().findByText(NOT_READY)).toBeTruthy();
    const row = checks().getByText("Zavi can send to this list").closest("li")!;
    expect(row.textContent).toMatch(/needs attention/);
    await new Promise((r) => setTimeout(r, 30));
    expect(primary(/Write it/).disabled).toBe(true);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe("Finish Sending setup or pick a list from your email tool");
    expect(screen.getByRole("region", { name: "Zavi checks" }).textContent).toMatch(/not done/);
    fireEvent.click(primary(/Write it/));
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: "Spring sale" } });
    expect(primary(/Add it for approval/).disabled).toBe(true);
    fireEvent.click(primary(/Add it for approval/));
    fireEvent.click(screen.getByRole("button", { name: "Zavi writes it" }));
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    pickDay("2026-11-02");
    expect(primary(/Plan it/).disabled).toBe(true);
    fireEvent.click(primary(/Plan it/));
    expect(sent(START)).toHaveLength(0);
    expect(sent(PASTE)).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.click(checks().getByRole("button", { name: "Set it up in Settings" }));
    expect(onClose).toHaveBeenCalled();
    expect((goto.mock.calls[0][0] as CustomEvent).detail).toEqual({ section: "sending" });
    window.removeEventListener(EMAIL_SETTINGS_GOTO_EVENT, goto);
  });

  it("a Zavi list whose sending domain is still pending, or missing, is blocked the same way even when bulk email is ready", async () => {
    for (const status of ["pending", "failed", null] as const) {
      cleanup();
      calls.length = 0;
      set(SENDING, senderState(true, status));
      open();
      await writeTo(/Members/);
      expect(await checks().findByText(NOT_READY)).toBeTruthy();
      expect(primary(/Write it/).disabled).toBe(true);
    }
  });

  it("a Zavi list with a ready sender and a verified domain passes and starts the run", async () => {
    open();
    await writeTo(/Members/);
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    expect(checks().queryByText("Zavi can send to this list")).toBeNull();
    expect(checks().queryByText(NOT_READY)).toBeNull();
    fireEvent.click(primary(/Write it/));
    await waitFor(() => expect(sent(START)).toHaveLength(1));
    expect((sent(START)[0].body as { inputs: { route: string; list_id: string } }).inputs).toMatchObject({ route: "zavi_list", list_id: "Z1" });
  });

  it("a tool list is never gated by Zavi's sender and shows no Zavi sender check", async () => {
    set(SENDING, senderState(false, null));
    open();
    await writeTo(/Paying customers/);
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    expect(checks().queryByText("Zavi can send to this list")).toBeNull();
    expect(checks().queryByText(NOT_READY)).toBeNull();
    fireEvent.click(primary(/Write it/));
    await waitFor(() => expect(sent(START)).toHaveLength(1));
  });

  it("a sender read that fails blocks a Zavi list (the server would refuse the run and it would still use credits); Check again reads fresh and unblocks", async () => {
    set(SENDING, { error: { message: "down" } }, 500);
    open();
    await writeTo(/Members/);
    expect(await checks().findByText("Zavi could not check its sender just now")).toBeTruthy();
    const row = checks().getByText("Zavi can send to this list").closest("li")!;
    expect(row.textContent).toMatch(/needs attention/);
    await new Promise((r) => setTimeout(r, 30));
    expect(primary(/Write it/).disabled).toBe(true);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe("Check Zavi's sender again to continue");
    fireEvent.click(primary(/Write it/));
    expect(sent(START)).toHaveLength(0);
    set(SENDING, senderState(true, "verified"));
    fireEvent.click(checks().getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(primary(/Write it/).disabled).toBe(false));
    expect(checks().queryByText("Zavi can send to this list")).toBeNull();
  });

  it("a Write it press on a Zavi list before the sender answers cannot start a run, and an answer of not ready keeps it blocked", async () => {
    let release!: () => void;
    gates[SENDING] = new Promise<void>((r) => (release = r));
    set(SENDING, senderState(false, "verified"));
    open();
    await writeTo(/Members/);
    await new Promise((r) => setTimeout(r, 30));
    expect(primary(/Write it/).disabled).toBe(true);
    fireEvent.click(primary(/Write it/));
    expect(sent(START)).toHaveLength(0);
    await act(async () => {
      release();
    });
    expect(await checks().findByText(NOT_READY)).toBeTruthy();
    expect(primary(/Write it/).disabled).toBe(true);
    expect(sent(START)).toHaveLength(0);
  });
});

describe("a SendGrid key saved with Mail Send only", () => {
  const withSendgrid = (status: string) =>
    set("GET /api/workspace/email-test-lists", {
      routes: [
        { route: "sendgrid", label: "SendGrid", status, error: status === "needs_permissions" ? "The saved SendGrid key sends one-to-one email but is missing the permissions campaigns need." : null, lists: [{ id: "SG1", name: "SendGrid newsletter", people: 50, marked: false, looks_like_test: false }] },
        { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z1", name: "Members", people: 40, marked: false, looks_like_test: false }] },
      ],
      orphans: [],
    });

  it("offers no SendGrid list in New campaign, and does not say SendGrid lists failed to load", async () => {
    withSendgrid("needs_permissions");
    open();
    expect(await screen.findByRole("radio", { name: /Members/ })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /SendGrid newsletter/ })).toBeNull();
    expect(screen.queryByTestId("new-campaign-unreadable")).toBeNull();
  });

  it("a campaign-ready SendGrid still offers its lists", async () => {
    withSendgrid("complete");
    open();
    expect(await screen.findByRole("radio", { name: /SendGrid newsletter/ })).toBeTruthy();
  });

  const NEEDS_KEY = "SendGrid is connected but its key can't run campaigns yet. Paste a key with campaign permissions in Overview → SendGrid.";

  it("with SendGrid the only tool, says its key can't run campaigns instead of telling you to connect a tool", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [
        { route: "sendgrid", label: "SendGrid", status: "needs_permissions", error: "The saved SendGrid key sends one-to-one email but is missing the permissions campaigns need.", lists: [] },
        { route: "mailchimp", label: "Mailchimp", status: "not_connected", error: null, lists: [] },
        { route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] },
      ],
      orphans: [],
    });
    open();
    const to = within(screen.getByRole("region", { name: "To" }));
    expect((await to.findByTestId("new-campaign-needs-key")).textContent).toBe(NEEDS_KEY);
    expect(screen.queryByTestId("new-campaign-no-lists")).toBeNull();
    expect(screen.queryByText(/Connect your email tool/)).toBeNull();
    expect(to.queryByRole("radio")).toBeNull();
    expect(screen.queryByTestId("new-campaign-unreadable")).toBeNull();
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Write it/));
    expect(sent(START)).toHaveLength(0);
  });

  it("with a Zavi list too, offers that list and still notes the SendGrid key once", async () => {
    withSendgrid("needs_permissions");
    open();
    const to = within(screen.getByRole("region", { name: "To" }));
    expect(await to.findByRole("radio", { name: /Members/ })).toBeTruthy();
    expect(to.getAllByTestId("new-campaign-needs-key").map((n) => n.textContent)).toEqual([NEEDS_KEY]);
    expect(screen.queryByRole("radio", { name: /SendGrid newsletter/ })).toBeNull();
    expect(screen.queryByTestId("new-campaign-no-lists")).toBeNull();
  });

  it("a campaign-ready SendGrid gets no key note", async () => {
    withSendgrid("complete");
    open();
    expect(await screen.findByRole("radio", { name: /SendGrid newsletter/ })).toBeTruthy();
    expect(screen.queryByTestId("new-campaign-needs-key")).toBeNull();
  });

  it("a list with one person reads 1 person, never 1 people", async () => {
    set("GET /api/workspace/email-test-lists", {
      routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [{ id: "Z9", name: "QA messy 1026", people: 1, marked: false, looks_like_test: false }, { id: "Z1", name: "Members", people: 1200, marked: false, looks_like_test: false }] }],
      orphans: [],
    });
    open();
    const one = (await screen.findByRole("radio", { name: /QA messy 1026/ })).closest("label")!;
    expect(one.textContent).toContain("1 person · Zavi lists");
    expect(one.textContent).not.toMatch(/1 people/);
    expect(screen.getByRole("radio", { name: /Members/ }).closest("label")!.textContent).toContain("1,200 people · Zavi lists");
  });

  it("before Add it for approval every sr-only span is held by a positioned box inside the scroll body, so nothing can scroll the dialog itself", async () => {
    open();
    await pickList(/Paying customers/);
    fireEvent.click(screen.getByRole("button", { name: "Paste my email" }));
    fireEvent.change(screen.getByLabelText("Email body"), { target: { value: BODY } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Spring sale" } });
    await waitFor(() => expect(primary(/Add it for approval/).hasAttribute("disabled")).toBe(false));
    const dialog = document.querySelector("dialog")!;
    const body = screen.getByTestId("action-modal-body");
    const srOnly = Array.from(dialog.querySelectorAll<HTMLElement>(".sr-only"));
    expect(srOnly.map((s) => s.textContent)).toEqual(expect.arrayContaining([" (done)"]));
    const positioned = /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/;
    const escapes = srOnly.filter((s) => {
      let el = s.parentElement;
      while (el && el !== dialog && !positioned.test(el.className)) el = el.parentElement;
      return !el || el === dialog || !body.contains(el);
    });
    expect(escapes.map((s) => s.textContent)).toEqual([]);
  });
});

describe("Pick a time under 26 hours ahead", () => {
  const PLAN = "POST /api/workspace/email-plan";
  const ZONE = "Pacific/Kiritimati";
  const TOO_SOON = "Pick a time at least 26 hours ahead to continue";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    set("GET /api/workspace/email-plan", { ok: true, role: "owner", timezone: ZONE, next_plan_at: null, next_plan_label: null, autopilot_on: false, items: [], holds: [], released: [] });
    set(PLAN, { ok: true, id: "p1", label: "Tue, Nov 03, 09:00", timezone: ZONE, list_name: "Members", replayed: false });
  });

  async function pickTime() {
    open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    await waitFor(() => expect(dayCell("2026-10-28").disabled).toBe(true));
    expect(dayCell("2026-10-29").disabled).toBe(false);
    closeCalendar();
  }
  const setWhen = (date: string, time: string) => {
    pickDay(date);
    pickClock(time);
  };

  it("a past day or a time under 26 hours ahead on the workspace's clock keeps Plan it off and never reaches the server", async () => {
    await pickTime();
    for (const date of ["2026-10-20", "2026-10-27", "2026-10-28"]) {
      const cell = dayCell(date);
      expect(cell.disabled).toBe(true);
      fireEvent.click(cell);
      expect(dayButton().textContent).toBe("Pick a day");
    }
    expect((showMonth("2026-10-29").getByRole("button", { name: "Previous month" }) as HTMLButtonElement).disabled).toBe(true);
    closeCalendar();
    for (const time of ["00:00", "03:45", "04:00"]) {
      setWhen("2026-10-29", time);
      expect(primary(/Plan it/).disabled).toBe(true);
      expect(screen.getByTestId("new-campaign-missing").textContent).toBe(TOO_SOON);
      expect(screen.getByTestId("new-campaign-too-soon").textContent).toMatch(/at least 26 hours ahead, so Zavi can draft it the day before/);
      expect(dayButton().getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByRole("region", { name: "When" }).textContent).toMatch(/not done/);
      fireEvent.click(primary(/Plan it/));
    }
    expect(sent(PLAN)).toHaveLength(0);
  });

  it("the boundary is 26 hours on the workspace's zone, not the browser's, with a minute to spare: one second past the edge is too close and the edge itself plans it", async () => {
    await pickTime();
    vi.setSystemTime(new Date("2026-10-27T12:14:01Z"));
    setWhen("2026-10-29", "04:15");
    expect(primary(/Plan it/).disabled).toBe(true);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe(TOO_SOON);
    fireEvent.click(primary(/Plan it/));
    expect(sent(PLAN)).toHaveLength(0);
    vi.setSystemTime(new Date("2026-10-27T12:14:00Z"));
    pickClock("04:30");
    pickClock("04:15");
    expect(primary(/Plan it/).disabled).toBe(false);
    expect(screen.queryByTestId("new-campaign-too-soon")).toBeNull();
    expect(screen.queryByTestId("new-campaign-missing")).toBeNull();
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    expect(sent(PLAN)).toHaveLength(1);
    expect(sent(PLAN)[0].body).toMatchObject({ date: "2026-10-29", time: "04:15" });
  });

  it("left open until the chosen time falls under 26 hours ahead, Plan it reads the clock again and never reaches the server", async () => {
    await pickTime();
    setWhen("2026-10-29", "05:00");
    expect(primary(/Plan it/).disabled).toBe(false);
    expect(screen.queryByTestId("new-campaign-too-soon")).toBeNull();
    vi.setSystemTime(new Date("2026-10-27T13:00:30Z"));
    expect(primary(/Plan it/).disabled).toBe(false);
    fireEvent.click(primary(/Plan it/));
    await waitFor(() => expect(screen.getByTestId("new-campaign-too-soon").textContent).toMatch(/at least 26 hours ahead, so Zavi can draft it the day before/));
    expect(primary(/Plan it/).disabled).toBe(true);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe(TOO_SOON);
    expect(screen.queryByText("Email planned")).toBeNull();
    fireEvent.click(primary(/Plan it/));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent(PLAN)).toHaveLength(0);
    setWhen("2026-10-29", "06:00");
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    expect(sent(PLAN)).toHaveLength(1);
    expect(sent(PLAN)[0].body).toMatchObject({ date: "2026-10-29", time: "06:00" });
  });

  it("when the workspace's time zone cannot be read, Plan it stays on and the server's refusal shows", async () => {
    set("GET /api/workspace/email-plan", { error: { message: "down" } }, 500);
    set(PLAN, { error: { code: "too_soon", message: "Plan it at least 26 hours ahead." } }, 400);
    open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    await waitFor(() => expect(sent("GET /api/workspace/email-plan").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(dayCell("2026-10-27").disabled).toBe(false);
    expect((showMonth("2026-10-27").getByRole("button", { name: "Previous month" }) as HTMLButtonElement).disabled).toBe(false);
    setWhen("2026-10-28", "09:00");
    expect(screen.queryByTestId("new-campaign-too-soon")).toBeNull();
    expect(primary(/Plan it/).disabled).toBe(false);
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Plan it at least 26 hours ahead.")).toBeTruthy();
    expect(sent(PLAN)).toHaveLength(1);
    expect(sent(PLAN)[0].body).toMatchObject({ date: "2026-10-28", time: "09:00" });
    expect(primary(/Plan it/).disabled).toBe(false);
  });

  it("when the time zone cannot be read the dialog says so, Try again re-reads it, and the clock line then names the zone", async () => {
    set("GET /api/workspace/email-plan", { error: { message: "down" } }, 500);
    open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    expect(await screen.findByTestId("new-campaign-zone-unread")).toBeTruthy();
    set("GET /api/workspace/email-plan", { ok: true, role: "owner", timezone: "America/Los_Angeles", next_plan_at: null, next_plan_label: null, autopilot_on: false, items: [], holds: [], released: [] });
    fireEvent.click(within(screen.getByTestId("new-campaign-zone-unread")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("new-campaign-zone-unread")).toBeNull());
    expect(await screen.findByText(/On your workspace's clock, (PDT|PST), America\/Los_Angeles\./)).toBeTruthy();
  });

  it("a plan read whose zone came back unread is not taken as UTC: the dialog says so, the Day picker sets no UTC window, and the server's own check decides", async () => {
    set("GET /api/workspace/email-plan", { ok: true, role: "owner", timezone: "UTC", timezone_unread: true, next_plan_at: null, next_plan_label: null, autopilot_on: false, items: [], holds: [], released: [] });
    set(PLAN, { error: { code: "too_soon", message: "Plan it at least 26 hours ahead." } }, 400);
    open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    expect(await screen.findByTestId("new-campaign-zone-unread")).toBeTruthy();
    expect(screen.queryByText(/On your workspace's clock, UTC/)).toBeNull();
    expect(dayCell("2026-10-27").disabled).toBe(false);
    closeCalendar();
    setWhen("2026-10-28", "09:00");
    expect(screen.queryByTestId("new-campaign-too-soon")).toBeNull();
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Plan it at least 26 hours ahead.")).toBeTruthy();
    expect(sent(PLAN)).toHaveLength(1);
  });

  it("the Day picker offers only whole days inside the window: no month before the first day 26 hours out, none past the 14-day edge, and a day inside plans it", async () => {
    await pickTime();
    const cal = showMonth("2026-10-29");
    expect((cal.getByRole("button", { name: "Previous month" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cal.getByRole("button", { name: "Next month" }));
    expect(cal.getByText("November 2026")).toBeTruthy();
    expect((cal.getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(true);
    expect(dayCell("2026-11-11").disabled).toBe(false);
    for (const date of ["2026-11-12", "2026-11-30"]) {
      const cell = dayCell(date);
      expect(cell.disabled).toBe(true);
      fireEvent.click(cell);
      expect(dayButton().textContent).toBe("Pick a day");
    }
    closeCalendar();
    expect(primary(/Plan it/).disabled).toBe(true);
    fireEvent.click(primary(/Plan it/));
    expect(sent(PLAN)).toHaveLength(0);
    setWhen("2026-11-03", "09:00");
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    expect(sent(PLAN)).toHaveLength(1);
    expect(sent(PLAN)[0].body).toMatchObject({ date: "2026-11-03", time: "09:00" });
  });

  it("a day comfortably ahead enables Plan it", async () => {
    await pickTime();
    setWhen("2026-11-03", "09:00");
    expect(primary(/Plan it/).disabled).toBe(false);
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    expect(sent(PLAN)[0].body).toMatchObject({ date: "2026-11-03", time: "09:00" });
  });
});

describe("Pick a time more than 14 days ahead", () => {
  const PLAN = "POST /api/workspace/email-plan";
  const ZONE = "America/New_York";
  const TOO_FAR = "Pick a day at most 14 days ahead to continue";
  const SERVER = "An email is planned at most 14 days ahead.";

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    set("GET /api/workspace/email-plan", { ok: true, role: "owner", timezone: ZONE, next_plan_at: null, next_plan_label: null, autopilot_on: false, items: [], holds: [], released: [] });
    set(PLAN, { ok: true, id: "p1", label: "Tue, Nov 10, 07:00 EST", timezone: ZONE, list_name: "Members", replayed: false });
  });

  async function pickTime() {
    open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    await waitFor(() => expect(dayCell("2026-10-27").disabled).toBe(true));
    expect(dayCell("2026-10-28").disabled).toBe(false);
    closeCalendar();
  }
  const setWhen = (date: string, time: string) => {
    pickDay(date);
    pickClock(time);
  };

  it("the Day picker stops at the last day the server takes, on the workspace's clock", async () => {
    await pickTime();
    expect(dayCell("2026-11-10").disabled).toBe(false);
    expect(dayCell("2026-11-11").disabled).toBe(true);
    expect((showMonth("2026-11-10").getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(true);
    expect(() => showMonth("2026-12-15")).toThrow(/Next month is off/);
  });

  it("a day past 14 days cannot be picked, and a late time on the last day keeps Plan it off, says the server's sentence under When and never reaches the server", async () => {
    await pickTime();
    const late = dayCell("2026-11-11");
    expect(late.disabled).toBe(true);
    fireEvent.click(late);
    expect(dayButton().textContent).toBe("Pick a day");
    closeCalendar();
    setWhen("2026-11-10", "23:45");
    expect(primary(/Plan it/).disabled).toBe(true);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe(TOO_FAR);
    expect(screen.getByTestId("new-campaign-too-far").textContent).toBe(SERVER);
    expect(dayButton().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("region", { name: "When" }).textContent).toMatch(/not done/);
    fireEvent.click(primary(/Plan it/));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent(PLAN)).toHaveLength(0);
  });

  it("across the fall-back change the edge is 14 times 24 hours: 08:00 and 07:15 New York are too far, 07:00 is too far a second early and plans it on the edge", async () => {
    await pickTime();
    for (const time of ["08:00", "07:15"]) {
      setWhen("2026-11-10", time);
      expect(primary(/Plan it/).disabled).toBe(true);
      expect(screen.getByTestId("new-campaign-missing").textContent).toBe(TOO_FAR);
      fireEvent.click(primary(/Plan it/));
    }
    vi.setSystemTime(new Date("2026-10-27T11:59:59Z"));
    pickClock("07:00");
    expect(primary(/Plan it/).disabled).toBe(true);
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe(TOO_FAR);
    fireEvent.click(primary(/Plan it/));
    expect(sent(PLAN)).toHaveLength(0);
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    pickClock("06:45");
    pickClock("07:00");
    expect(screen.queryByTestId("new-campaign-too-far")).toBeNull();
    expect(screen.queryByTestId("new-campaign-missing")).toBeNull();
    expect(primary(/Plan it/).disabled).toBe(false);
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText("Email planned")).toBeTruthy();
    expect(sent(PLAN)).toHaveLength(1);
    expect(sent(PLAN)[0].body).toMatchObject({ date: "2026-11-10", time: "07:00" });
  });

  it("when the time zone cannot be read the picker sets no edge, hands the plan a four-digit day, and the server's too-far refusal shows", async () => {
    set("GET /api/workspace/email-plan", { error: { message: "down" } }, 500);
    set(PLAN, { error: { code: "too_far", message: SERVER } }, 409);
    open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Holiday hours" } });
    await waitFor(() => expect(sent("GET /api/workspace/email-plan").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(dayCell("2027-01-15").disabled).toBe(false);
    closeCalendar();
    setWhen("2027-01-15", "09:00");
    expect(primary(/Plan it/).disabled).toBe(false);
    fireEvent.click(primary(/Plan it/));
    expect(await screen.findByText(SERVER, { selector: '[role="alert"]' })).toBeTruthy();
    expect(sent(PLAN)).toHaveLength(1);
    expect(sent(PLAN)[0].body).toMatchObject({ date: "2027-01-15", time: "09:00" });
  });

  it("a refusal from the server is scrolled into view where the founder is, not left above the fold", async () => {
    const scrolled: Array<{ el: HTMLElement; opts: unknown }> = [];
    const prior = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: HTMLElement, opts?: unknown) {
      scrolled.push({ el: this, opts });
    } as Element["scrollIntoView"];
    try {
      set(PLAN, { error: { code: "too_far", message: SERVER } }, 409);
      await pickTime();
      setWhen("2026-11-05", "09:00");
      expect(primary(/Plan it/).disabled).toBe(false);
      scrolled.length = 0;
      fireEvent.click(primary(/Plan it/));
      const alert = await screen.findByText(SERVER, { selector: '[role="alert"]' });
      expect(sent(PLAN)).toHaveLength(1);
      await waitFor(() => expect(scrolled.some((s) => s.el === alert)).toBe(true));
    } finally {
      Element.prototype.scrollIntoView = prior;
    }
  });
});

describe("the Pick a time pickers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    set("GET /api/workspace/email-plan", { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: false, items: [], holds: [], released: [] });
  });

  it("sit beside the Pick a time radio, not inside its label: the radio's name stays Pick a time with the calendar and the times open, and clicks inside them never reach the radio", async () => {
    open();
    await pickList(/Members/);
    const radio = screen.getByRole("radio", { name: "Pick a time" }) as HTMLInputElement;
    fireEvent.click(radio);
    await waitFor(() => expect(dayCell("2026-10-27").disabled).toBe(true));
    expect(screen.getByRole("radio", { name: "Pick a time" })).toBe(radio);
    const clicks = vi.fn();
    radio.addEventListener("click", clicks);
    const cal = calendar();
    fireEvent.click(cal.getByText("October 2026"));
    fireEvent.click(cal.getByText("Mo"));
    fireEvent.click(dayCell("2026-10-27"));
    expect(clicks).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Choose a day" })).toBeTruthy();
    pickDay("2026-10-30");
    fireEvent.click(screen.getByRole("button", { name: "Time" }));
    expect(screen.getByRole("radio", { name: "Pick a time" })).toBe(radio);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Time" })).getByRole("option", { name: "10:30 AM" }));
    expect(clicks).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Time" }).textContent).toBe("10:30 AM");
    expect(radio.checked).toBe(true);
  });

  it("Escape closes the open calendar or time list and leaves the New campaign dialog open", async () => {
    const onClose = open();
    await pickList(/Members/);
    fireEvent.click(screen.getByRole("radio", { name: "Pick a time" }));
    calendar();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Choose a day" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose a day" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Time" }));
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Time" }), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Time" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-campaign")).toBeTruthy();
  });
});

describe("Zavi checks while they run", () => {
  it("a slow footer read shows Checking, never a warning or a retry, and the check lands only when the read returns", async () => {
    let release = () => {};
    gates["GET /api/workspace/email-template"] = new Promise<void>((r) => (release = r));
    open();
    const checks = await screen.findByTestId("new-campaign-checks");
    const row = within(checks).getByText("Footer has your postal address").closest("li") as HTMLElement;
    await pickList(/Paying customers/);
    expect(row.getAttribute("data-checking")).toBe("true");
    expect(row.textContent).toContain("Checking…");
    expect(row.textContent).toContain("checking");
    expect(row.textContent).not.toContain("needs attention");
    expect(row.textContent).not.toContain("passed");
    expect(screen.queryByText("Zavi could not read your footer just now")).toBeNull();
    expect(document.querySelector('[data-field="footer-retry"]')).toBeNull();
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Tell people about the spring sale this week" } });
    expect(screen.getByTestId("new-campaign-missing").textContent).toBe("Zavi is checking your setup");
    expect(document.querySelector('[data-step="checks"] [data-testid="new-campaign-step-marker"]')?.getAttribute("data-checking")).toBe("true");
    await act(async () => release());
    await waitFor(() => expect(screen.queryByText("Footer has your postal address")).toBeNull());
  });
});

describe("finishing and reopening New campaign", () => {
  const openFromHead = () => fireEvent.click(screen.getByTestId("new-campaign-button"));
  const writeIt = async () => {
    await pickList(/Members/);
    fireEvent.change(screen.getByLabelText("What should this email do?"), { target: { value: "Spring sale" } });
    fireEvent.click(primary(/Write it/));
    return screen.findByTestId("new-campaign-started");
  };

  it("Done leaves the page with no dialog, and the next New campaign starts blank", async () => {
    render(<EmailHeadTools slug="email_marketing" channelName="Email campaigns" />);
    openFromHead();
    await writeIt();
    expect(screen.queryByTestId("new-campaign")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("new-campaign-started")).toBeNull();
    expect(screen.queryByTestId("new-campaign")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    openFromHead();
    expect(((await screen.findByLabelText("What should this email do?")) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByTestId("new-campaign-started")).toBeNull();
  });

  it("the success stays up when the page header is rebuilt behind it, and never falls back to the form", async () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    const at = (el: HTMLElement) => (
      <ChannelPageHeaderSlotProvider element={null} titleElement={el}>
        <EmailHeadTools slug="email_marketing" channelName="Email campaigns" />
      </ChannelPageHeaderSlotProvider>
    );
    const { rerender } = render(at(first));
    openFromHead();
    await writeIt();
    rerender(at(second));
    expect(screen.getByTestId("new-campaign-started")).toBeTruthy();
    expect(screen.queryByTestId("new-campaign")).toBeNull();
    first.remove();
    second.remove();
  });
});

describe("small form details", () => {
  it("a starter keeps what the founder already typed, and a second starter swaps the first", async () => {
    open();
    await pickList(/Members/);
    const box = screen.getByLabelText("What should this email do?") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Diwali 20% off" } });
    fireEvent.click(screen.getByRole("button", { name: "Announce something new" }));
    expect(box.value).toBe("Announce something new: Diwali 20% off");
    fireEvent.click(screen.getByRole("button", { name: "Share a seasonal offer" }));
    expect(box.value).toBe("Share a seasonal offer: Diwali 20% off");
  });

  it("warns that a typed subject will not be kept once a time is picked, before anything is planned", async () => {
    open();
    await pickList(/Members/);
    fireEvent.change(document.querySelector('input[data-field="subject"]') as HTMLInputElement, { target: { value: "My subject" } });
    expect(screen.queryByTestId("new-campaign-plan-drops-lines")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Pick a time/ }));
    expect(screen.getByTestId("new-campaign-plan-drops-lines").textContent).toBe(PLAN_DROPS_LINES);
    expect(sent("POST /api/workspace/email-plan")).toHaveLength(0);
  });
});
