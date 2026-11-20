// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};

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
const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: { add: (o: unknown) => toastAdd(o) } }));
const toastTitles = () => toastAdd.mock.calls.map((c) => (c[0] as { title: string }).title);
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: () => Promise.resolve(true) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { EmailComingUpBlock, wallParts } from "../EmailComingUpBlock";
import { ChannelOverviewPanels } from "../EmailSettingsPanels";
import { longDay } from "../../ugc/DatePicker";
import { clockLabel } from "../TimePicker";

const chooseDay = (iso: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Day" }));
  const name = longDay(iso)!;
  const step = (dir: "Next month" | "Previous month") => {
    const b = screen.getByRole("button", { name: dir }) as HTMLButtonElement;
    if (!b.disabled) fireEvent.click(b);
  };
  if (!screen.queryByRole("button", { name })) step("Next month");
  if (!screen.queryByRole("button", { name })) {
    step("Previous month");
    if (!screen.queryByRole("button", { name })) step("Previous month");
  }
  fireEvent.click(screen.getByRole("button", { name }));
};
const chooseClock = (hhmm: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Time" }));
  fireEvent.click(screen.getByRole("option", { name: clockLabel(hhmm) }));
};
const zoneLine = () => screen.getByTestId("coming-up-move-summary").textContent ?? "";
const dayShown = () => screen.getByRole("button", { name: "Day" }).textContent;
const timeShown = () => screen.getByRole("button", { name: "Time" }).textContent;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const item = (over: Record<string, unknown>) => ({
  id: A,
  route: "mailchimp",
  list_id: "L1",
  list_name: "Paying customers",
  planned_at: "2026-10-21T16:00:00Z",
  planned_label: "Wed, Oct 21, 09:00",
  timezone: "America/Los_Angeles",
  angle: "Product news: shared calendars",
  why: "Product news beat tips 3 times out of 4 for this list.",
  source: "email_agent",
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
const view = (items: unknown[], role = "owner") => ({ ok: true, role, timezone: "America/Los_Angeles", next_plan_at: "2026-10-26T15:00:00Z", next_plan_label: "Mon, Oct 26, 08:00", items });
const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  calls.length = 0;
  toastAdd.mockClear();
  for (const k of Object.keys(routes)) delete routes[k];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pick = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
};

describe("Coming up", () => {
  it("shows each planned email with its time, list, angle, why and state; who asked; sent and skipped below", async () => {
    set(
      "GET /api/workspace/email-plan",
      view([
        item({}),
        item({ id: B, status: "ready", card: { rail: "channel_actions", id: C }, source: "growth_agent", list_name: "Trial users" }),
        item({ id: C, status: "skipped", status_reason: "not_approved_in_time", reason: "Not approved by the planned time. The draft is still there.", card: { rail: "channel_actions", id: A } }),
      ]),
    );
    set(`GET /api/email-cards/channel_actions/${C}`, { card: { open: true, list: { name: "L", people: 1 }, viewer_can_approve: true, can_approve: [true], chosen_variant: null, versions: [{ variant: 1, subject: "S", preview_text: null, tested_by_approver: true }] } });
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("coming-up-item").length).toBe(3));
    expect(screen.getAllByText("Planned")[0]).toBeDefined();
    expect(screen.getAllByText("Needs approval")[0]).toBeDefined();
    expect(screen.getByText("Suggested by your growth plan")).toBeDefined();
    expect(screen.getByText("Sent and skipped")).toBeDefined();
    expect(screen.getByText("Not approved by the planned time. The draft is still there.")).toBeDefined();
    expect((await screen.findByRole("link", { name: "Approve and schedule" })).getAttribute("href")).toBe(`/workspace/email-cards/channel_actions/${C}`);
    expect(screen.getByRole("link", { name: /approve and send now/ }).getAttribute("href")).toBe(`/workspace/email-cards/channel_actions/${A}`);
  });

  it("Notion Flow 36: skipping an email planned for later this week does not file it under a past-days heading", async () => {
    const future = item({ planned_at: "2026-10-30T09:00:00Z", planned_label: "Fri, Oct 30, 09:00", timezone: "UTC" });
    set("GET /api/workspace/email-plan", { ...view([future]), timezone: "UTC" });
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "Skip" }));
    set("GET /api/workspace/email-plan", { ...view([{ ...future, status: "skipped", status_reason: "skipped_by_founder", reason: "Skipped." }]), timezone: "UTC" });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(toastTitles()).toContain("Skipped."));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`/api/workspace/email-plan/${A}/skip`]);
    const block = screen.getByTestId("coming-up");
    expect(block.textContent ?? "").not.toMatch(/last \d+ days|past week|already (went|sent)/i);
    const heading = screen.getByText("Sent and skipped");
    const card = screen.getByTestId("coming-up-item");
    expect(card.textContent).toContain("Skipped");
    expect(heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("waiting-on-you")).toBeNull();
  });

  it("a member reads the plan but gets no buttons", async () => {
    set("GET /api/workspace/email-plan", view([item({ status: "ready", card: { rail: "channel_actions", id: C } })], "member"));
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getByText("Only an owner or admin can change the plan or approve an email.")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plan an email" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Review draft" })).toBeNull();
  });

  it("Move sends the wall time on the workspace's clock with the generation it saw; a refusal shows the server's words", async () => {
    set("GET /api/workspace/email-plan", view([item({ schedule_gen: 4 })]));
    set(`POST /api/workspace/email-plan/${A}/move`, { error: { code: "list_spacing", message: "That list already has an email planned within 7 days of that time." } }, 409);
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    expect(dayShown()).toContain("Wed 21 Oct 2026");
    expect(timeShown()).toContain("9:00 AM");
    chooseDay("2026-10-23");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("within 7 days"));
    expect(calls.find((c) => c.method === "POST")).toEqual({
      url: `/api/workspace/email-plan/${A}/move`,
      method: "POST",
      body: { date: "2026-10-23", time: "09:00", schedule_gen: 4, timezone: "America/Los_Angeles" },
    });
  });

  it("the move form's zone follows the day typed, not the item's current date, across the DST change", async () => {
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    set("GET /api/workspace/email-plan", view([item({ planned_at: "2026-10-27T12:00:00Z", planned_label: "Tue, Oct 27, 05:00" })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    expect(zoneLine()).toMatch(/ PDT(\.|$)/);
    chooseDay("2026-11-03");
    expect(zoneLine()).toMatch(/ PST(\.|$)/);
    expect(zoneLine()).not.toMatch(/ PDT(\.|$)/);
    chooseDay("2026-10-27");
    expect(zoneLine()).toMatch(/ PDT(\.|$)/);
    expect(screen.getByTestId("coming-up-item").textContent).toContain("PDT");
    expect(screen.getByTestId("coming-up-item").textContent).not.toContain("PST");
  });

  it("the move form's zone for a fall-back wall time east of UTC is the first occurrence, as the server keeps", async () => {
    set("GET /api/workspace/email-plan", { ...view([item({ timezone: "Europe/Berlin", planned_at: "2026-10-21T08:00:00Z", planned_label: "Wed, Oct 21, 10:00" })]), timezone: "Europe/Berlin" });
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    expect(zoneLine()).toMatch(/ CEST(\.|$)/);
    chooseDay("2026-10-25");
    chooseClock("02:30");
    expect(zoneLine()).toMatch(/ CEST(\.|$)/);
    expect(zoneLine()).not.toMatch(/ CET(\.|$)/);
    chooseClock("03:30");
    expect(zoneLine()).toMatch(/ CET(\.|$)/);
    chooseDay("2026-10-26");
    chooseClock("02:30");
    expect(zoneLine()).toMatch(/ CET(\.|$)/);
  });

  it("must catch N5: the move form shows and sends the item's own zone, not the workspace's current one", async () => {
    set("GET /api/workspace/email-plan", { ...view([item({ timezone: "Europe/London", planned_at: "2026-10-21T08:00:00Z" })]), timezone: "America/Denver" });
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    expect(zoneLine()).toMatch(/ BST(\.|$)/);
    expect(timeShown()).toContain("9:00 AM");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(zoneLine()).toContain("Pick a new day or time to move it.");
    fireEvent.click(save);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    chooseDay("2026-10-22");
    chooseClock("10:30");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ time: "10:30", timezone: "Europe/London" });
  });

  it("fd10 #5: a new generation at the OLD time (a Don't send or an angle change) does not confirm a move", async () => {
    set("GET /api/workspace/email-plan", view([item({ schedule_gen: 1 })]));
    set(`POST /api/workspace/email-plan/${A}/move`, null, 502);
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    chooseClock("11:00");
    set("GET /api/workspace/email-plan", view([item({ schedule_gen: 2 })]));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => screen.getByText("Zavi could not confirm this went through. Refresh to check."));
    expect(screen.queryByText(/^Moved\./)).toBeNull();
  });

  it("must catch N7 + fd9 #6: an accepted change is said only once a read shows it; a failed re-read is 'could not confirm' + Refresh", async () => {
    set("GET /api/workspace/email-plan", view([item({})]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "Skip" }));
    set("GET /api/workspace/email-plan", { error: { code: "internal_error", message: "That did not work. Try again." } }, 500);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => screen.getByText("Zavi could not confirm this went through. Refresh to check."));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(screen.queryByText("Skipped.")).toBeNull();
    set("GET /api/workspace/email-plan", view([item({ status: "skipped", status_reason: "skipped_by_founder", reason: "Skipped." })]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(toastTitles()).toContain("Skipped."));
  });

  it("fd9 #6: an accepted change whose read does not show it (here, the plan unchanged) is not called done", async () => {
    set("GET /api/workspace/email-plan", view([item({})]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => screen.getByText("Zavi could not confirm this went through. Refresh to check."));
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("fd9 #7: Move is confirmed only by the time it asked for (and a new generation); Draft now by a queued draft", async () => {
    set("GET /api/workspace/email-plan", view([item({ schedule_gen: 1 })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    chooseDay("2026-10-23");
    set("GET /api/workspace/email-plan", view([item({ schedule_gen: 2, planned_at: "2026-10-24T16:00:00Z" })]));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => screen.getByText("Zavi could not confirm this went through. Refresh to check."));
    set("GET /api/workspace/email-plan", view([item({ schedule_gen: 2, planned_at: "2026-10-23T16:00:00Z" })]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(toastTitles().join(" | ")).toContain("Moved."));
    cleanup();
    calls.length = 0;
    set("GET /api/workspace/email-plan", view([item({})]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "Draft now" }));
    looksLikeButton(screen.getByRole("button", { name: "Draft now" }));
    set("GET /api/workspace/email-plan", view([item({ status: "skipped" })]));
    fireEvent.click(screen.getByRole("button", { name: "Draft now" }));
    await waitFor(() => screen.getByText("Zavi could not confirm this went through. Refresh to check."));
    set("GET /api/workspace/email-plan", view([item({ draft_requested: true })]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(toastTitles().join(" | ")).toContain("drafting it now"));
  });

  it("must catch N9: the plan shows a real error with Retry, never loading forever", async () => {
    set("GET /api/workspace/email-plan", { error: { code: "internal_error", message: "Zavi could not read the plan." } }, 500);
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByText("Zavi could not read the plan."));
    set("GET /api/workspace/email-plan", view([]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => screen.getByTestId("coming-up-empty"));
  });

  it("an approved-for-its-time email can be stopped with Don't send; Skip and Draft now post once", async () => {
    set("GET /api/workspace/email-plan", view([item({ status: "scheduled", card: { rail: "channel_actions", id: C }, scheduled: { variant: 1, count: 610, by: "u", at: "x" } })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "Don't send" }));
    set("GET /api/workspace/email-plan", view([item({ status: "ready", vetoed: true, schedule_gen: 2, card: { rail: "channel_actions", id: C } })]));
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    await waitFor(() => expect(toastTitles().join(" | ")).toContain("Not sending"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual([`/api/workspace/email-plan/${A}/withdraw`]);
  });

  it("Notion Flow 83: an email approved for its time does not offer Edit on its box; one waiting for approval does", async () => {
    const draft = (variant: number) => ({ variant, subject: `Shared calendars ${variant}`, preview_text: "Plan the week together", content: { subject: `Shared calendars ${variant}`, preview_text: "Plan the week together", paragraphs: ["Hi there"] }, tested_by_me: true, tested_by_approver: true });
    const cardView = { versions: [draft(1), draft(2)], chosen_variant: 1, viewer_can_approve: true, can_approve: [true, true], test_list: false, test_list_unknown: false, list: { people: 610 } };
    set(`GET /api/email-cards/channel_actions/${C}`, { card: cardView });
    set(`GET /api/email-cards/decisions/${B}`, { card: cardView });
    set(
      "GET /api/workspace/email-plan",
      view([
        item({ id: A, status: "scheduled", card: { rail: "channel_actions", id: C }, scheduled: { variant: 1, count: 610, by: "u", at: "x" } }),
        item({ id: B, status: "ready", planned_at: "2026-10-22T16:00:00Z", card: { rail: "decisions", id: B } }),
      ]),
    );
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("email-box-subject")).toHaveLength(2));
    const rows = screen.getAllByTestId("coming-up-item");
    const row = (status: string) => rows.find((r) => r.getAttribute("data-status") === status)!;
    const boxButtons = (r: HTMLElement) => Array.from(r.querySelectorAll("button")).filter((b) => b.closest("li") === r && b.parentElement?.querySelector('[data-testid="email-box-subject"]'));
    const scheduled = boxButtons(row("scheduled"));
    expect(scheduled.map((b) => b.textContent?.trim())).toEqual(["Open"]);
    expect(Array.from(row("scheduled").querySelectorAll("button")).some((b) => /edit/i.test(b.textContent ?? ""))).toBe(false);
    expect(boxButtons(row("ready")).map((b) => b.textContent?.trim())).toEqual(["Edit"]);
  });

  it("a send Zavi could not confirm shows the list on hold; the owner says it was not sent with what they checked", async () => {
    set(
      "GET /api/workspace/email-plan",
      view([item({ status: "reconciling", status_reason: "outcome_unknown", reason: "Zavi could not tell whether this went out. Check your email tool.", card: { rail: "channel_actions", id: C }, hold: { since: "x", unresolved: true } })]),
    );
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByText("List on hold"));
    expect(screen.getByText("Checking")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "I checked my email tool: this was not sent" }));
    const confirm = screen.getByRole("button", { name: "Confirm not sent" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What you checked"), { target: { value: "Mailchimp shows it as a draft" } });
    set("GET /api/workspace/email-plan", { ...view([item({ status: "skipped", status_reason: "not_sent_confirmed", card: { rail: "channel_actions", id: C } })]), released: [C] });
    fireEvent.click(confirm);
    await waitFor(() => expect(toastTitles().join(" | ")).toContain("The list is free"));
    expect(calls.filter((c) => c.method === "POST")).toEqual([
      { url: `/api/workspace/email-plan/holds/channel_actions/${C}/not-sent`, method: "POST", body: { reason: "Mailchimp shows it as a draft" } },
    ]);
  });

  describe("G2: only a refusal says it did not happen; no answer re-reads", () => {
    it("Skip with no answer whose re-read shows it skipped says Skipped", async () => {
      set("GET /api/workspace/email-plan", view([item({})]));
      set(`POST /api/workspace/email-plan/${A}/skip`, null, 502);
      render(<EmailComingUpBlock />);
      await waitFor(() => screen.getByRole("button", { name: "Skip" }));
      set("GET /api/workspace/email-plan", view([item({ status: "skipped", status_reason: "skipped_by_founder", reason: "Skipped." })]));
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      await waitFor(() => expect(toastTitles()).toContain("Skipped."));
      expect(screen.queryByText(/could not reach Zavi/)).toBeNull();
    });

    it("Skip with no answer whose re-read still shows it planned is unknown with Refresh; Refresh that shows it settles it", async () => {
      set("GET /api/workspace/email-plan", view([item({})]));
      set(`POST /api/workspace/email-plan/${A}/skip`, { error: { code: "internal_error", message: "x" } }, 500);
      render(<EmailComingUpBlock />);
      await waitFor(() => screen.getByRole("button", { name: "Skip" }));
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      await waitFor(() => screen.getByText("Zavi could not confirm this went through. Refresh to check."));
      set("GET /api/workspace/email-plan", view([item({ status: "skipped", status_reason: "skipped_by_founder", reason: "Skipped." })]));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(toastTitles()).toContain("Skipped."));
    });

    it("a refusal with its reason says so and re-reads nothing", async () => {
      set("GET /api/workspace/email-plan", view([item({})]));
      set(`POST /api/workspace/email-plan/${A}/skip`, { error: { code: "not_skippable", message: "This email can no longer be skipped." } }, 409);
      render(<EmailComingUpBlock />);
      await waitFor(() => screen.getByRole("button", { name: "Skip" }));
      const before = calls.filter((c) => c.method === "GET" && c.url === "/api/workspace/email-plan").length;
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      await waitFor(() => screen.getByText("This email can no longer be skipped."));
      expect(calls.filter((c) => c.method === "GET" && c.url === "/api/workspace/email-plan").length).toBe(before);
    });

    it("fd9 #3: this-was-not-sent: a hold that merely disappears is not proof (it may have been confirmed SENT); only the release record is", async () => {
      const held = view([item({ status: "reconciling", card: { rail: "channel_actions", id: C }, hold: { since: "x", unresolved: true } })]);
      set("GET /api/workspace/email-plan", held);
      set(`POST /api/workspace/email-plan/holds/channel_actions/${C}/not-sent`, null, 504);
      render(<EmailComingUpBlock />);
      await waitFor(() => screen.getByText("List on hold"));
      fireEvent.click(screen.getByRole("button", { name: "I checked my email tool: this was not sent" }));
      fireEvent.change(screen.getByLabelText("What you checked"), { target: { value: "Draft in Mailchimp" } });
      set("GET /api/workspace/email-plan", view([item({ status: "sent", card: { rail: "channel_actions", id: C }, hold: null })]));
      fireEvent.click(screen.getByRole("button", { name: "Confirm not sent" }));
      await waitFor(() => screen.getByText("Zavi could not confirm this went through. Refresh to check."));
      expect(screen.queryByText(/The list is free/)).toBeNull();
    });

    it("this-was-not-sent with no answer: the re-read listing it as released says it went through", async () => {
      const held = view([item({ status: "reconciling", card: { rail: "channel_actions", id: C }, hold: { since: "x", unresolved: true } })]);
      set("GET /api/workspace/email-plan", held);
      set(`POST /api/workspace/email-plan/holds/channel_actions/${C}/not-sent`, null, 504);
      render(<EmailComingUpBlock />);
      await waitFor(() => screen.getByText("List on hold"));
      fireEvent.click(screen.getByRole("button", { name: "I checked my email tool: this was not sent" }));
      fireEvent.change(screen.getByLabelText("What you checked"), { target: { value: "Draft in Mailchimp" } });
      set("GET /api/workspace/email-plan", { ...view([item({ status: "skipped", status_reason: "not_sent_confirmed", card: { rail: "channel_actions", id: C }, hold: null })]), released: [C] });
      fireEvent.click(screen.getByRole("button", { name: "Confirm not sent" }));
      await waitFor(() => expect(toastTitles().join(" | ")).toContain("The list is free"));
    });

  });

  it("a hold something will still settle offers nothing; a member sees a held send that is not planned, without the button", async () => {
    set("GET /api/workspace/email-plan", view([item({ status: "sending", card: { rail: "channel_actions", id: C }, hold: { since: "x", unresolved: false } })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByText("Sending"));
    expect(screen.queryByTestId("not-sent")).toBeNull();
    cleanup();
    set("GET /api/workspace/email-plan", { ...view([], "member"), holds: [{ rail: "decisions", card_id: B, list_key: "zavi_list:x", since: "x", since_label: "Mon, Oct 19, 10:00" }] });
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByTestId("held-send"));
    expect(screen.getByText("An email from Mon, Oct 19, 10:00")).toBeDefined();
    expect(screen.getByRole("link", { name: "Open the email" }).getAttribute("href")).toBe(`/workspace/email-cards/decisions/${B}`);
    expect(screen.queryByRole("button", { name: /this was not sent/ })).toBeNull();
  });

  it("is an Overview panel by id", async () => {
    set("GET /api/workspace/email-plan", view([]));
    render(<ChannelOverviewPanels panels={["email_coming_up"]} />);
    await waitFor(() => expect(screen.getByTestId("coming-up")).toBeDefined());
  });

  it("wall time is read on the zone's clock", () => {
    expect(wallParts("2026-10-21T16:00:00Z", "America/Los_Angeles")).toEqual({ date: "2026-10-21", time: "09:00" });
    expect(wallParts("2026-10-21T03:30:00Z", "America/Los_Angeles")).toEqual({ date: "2026-10-20", time: "20:30" });
  });
});

describe("a send refused at its planned time keeps the way back to its draft", () => {
  const refused: Array<[string, string]> = [
    ["list_send_in_flight", "Another email to this list is still going out, or Zavi is still checking whether it went. Wait for it to finish before sending another one to the same list."],
    ["email_paused", "Email is paused for this workspace. Resume email in Email campaigns settings, then approve again."],
    ["zz_unheard_of_refusal", "This email did not go out at its planned time."],
  ];

  it.each(refused)("%s shows the sentence, no code, and Open the draft", async (code, words) => {
    set("GET /api/workspace/email-plan", view([item({ status: "skipped", status_reason: code, reason: words, unattended: true, card: { rail: "decisions", id: B } })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getByText(words)).toBeDefined());
    const row = screen.getByTestId("coming-up-item");
    expect(row.textContent).not.toContain(code);
    expect(screen.getByRole("link", { name: "Open the draft to approve and send now" }).getAttribute("href")).toBe(`/workspace/email-cards/decisions/${B}`);
  });

  it.each(["card_rejected", "skipped_by_founder", "not_sent_confirmed", "may_have_sent", "outcome_unknown", "not_open", "redraft_required"])("%s still offers no draft link", async (code) => {
    set("GET /api/workspace/email-plan", view([item({ status: "skipped", status_reason: code, reason: "Skipped.", card: { rail: "decisions", id: B } })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getByText("Skipped.")).toBeDefined());
    expect(screen.queryByRole("link", { name: /approve and send now/ })).toBeNull();
  });

  it("Notion Flow 73: list_sent_recently opens the draft without promising a send now; not_approved_in_time still offers it", async () => {
    const recent = "Another email went to this list within 7 days, so this one did not go. The draft is still there.";
    const late = "Not approved by the planned time. The draft is still there.";
    set(
      "GET /api/workspace/email-plan",
      view([
        item({ id: A, status: "skipped", status_reason: "list_sent_recently", reason: recent, card: { rail: "decisions", id: B } }),
        item({ id: B, status: "skipped", status_reason: "not_approved_in_time", reason: late, card: { rail: "channel_actions", id: C } }),
      ]),
    );
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getByText(recent)).toBeDefined());
    const [first, second] = screen.getAllByTestId("coming-up-item");
    const recentRow = first.textContent?.includes(recent) ? first : second;
    const lateRow = recentRow === first ? second : first;
    const recentLinks = within(recentRow).getAllByRole("link");
    expect(recentLinks.map((l) => l.textContent)).toEqual(["Open the draft"]);
    expect(recentLinks[0].getAttribute("href")).toBe(`/workspace/email-cards/decisions/${B}`);
    expect(recentRow.textContent).not.toMatch(/send now/i);
    expect(within(lateRow).getByRole("link", { name: "Open the draft to approve and send now" }).getAttribute("href")).toBe(`/workspace/email-cards/channel_actions/${C}`);
    expect(screen.getAllByRole("link", { name: /approve and send now/ })).toHaveLength(1);
  });
});

describe("Coming up review fixes", () => {
  it("Change topic with the topic unchanged cannot be saved and posts nothing", async () => {
    set("GET /api/workspace/email-plan", view([item({})]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Change topic");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Product news: shared calendars  " } });
    expect(save.disabled).toBe(true);
    await Promise.resolve();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Something new" } });
    expect(save.disabled).toBe(false);
  });

  it("must catch: a topic that differs only in case cannot be saved either", async () => {
    set("GET /api/workspace/email-plan", view([item({})]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Change topic");
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: " PRODUCT NEWS: Shared Calendars" } });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    await Promise.resolve();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("Move is one panel: the zone sits with the time, Save posts the typed time, Cancel brings Skip and the menu back", async () => {
    set("GET /api/workspace/email-plan", view([item({ schedule_gen: 4 })]));
    set(`POST /api/workspace/email-plan/${A}/move`, { error: { code: "list_spacing", message: "Too close." } }, 409);
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("button", { name: "Skip" })).toBeDefined();
    pick("Move");
    const panel = screen.getByTestId("coming-up-move");
    expect(panel.contains(screen.getByTestId("coming-up-move-summary"))).toBe(true);
    expect(zoneLine()).toMatch(/ PDT(\.|$)/);
    expect(within(panel).getByRole("button", { name: "Save" })).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Cancel" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    chooseDay("2026-10-23");
    chooseClock("14:15");
    expect(screen.getByTestId("coming-up-move-summary").textContent).toContain("Oct 23");
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ date: "2026-10-23", time: "14:15", schedule_gen: 4 });
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("coming-up-move")).toBeNull();
    expect(screen.getByRole("button", { name: "Skip" })).toBeDefined();
    expect(screen.getByRole("button", { name: "More actions" })).toBeDefined();
  });

  it("Move names the month in words, cannot be typed into, and the calendar stops at the backend window so Dec 11 is never picked by mistake", async () => {
    set("GET /api/workspace/email-plan", view([item({ schedule_gen: 4 })]));
    const { container } = render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(container.querySelector('input[type="time"]')).toBeNull();
    expect(dayShown()).toContain("Oct 2026");
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.getByText("October 2026")).toBeDefined();
    expect((screen.getByRole("button", { name: longDay("2026-10-20")! }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous month" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("November 2026")).toBeDefined();
    expect((screen.getByRole("button", { name: longDay("2026-11-03")! }) as HTMLButtonElement).disabled).toBe(false);
    const past = screen.getByRole("button", { name: longDay("2026-11-04")! }) as HTMLButtonElement;
    expect(past.disabled).toBe(true);
    fireEvent.click(past);
    expect((screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("December 2026")).toBeNull();
    expect(screen.queryByRole("button", { name: longDay("2026-12-11")! })).toBeNull();
    expect(dayShown()).toContain("Wed 21 Oct 2026");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("Save is off, with a plain reason inside the form, when nothing changed or the time is outside the window; the note keeps its place", async () => {
    set("GET /api/workspace/email-plan", view([item({ planned_at: "2026-12-11T17:00:00Z", planned_label: "Fri, Dec 11, 09:00", schedule_gen: 4 })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    const panel = screen.getByTestId("coming-up-move");
    const save = within(panel).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    const note = screen.getByTestId("coming-up-move-summary");
    expect(save.disabled).toBe(true);
    expect(note.textContent).toContain("Pick a new day or time to move it.");
    chooseClock("10:30");
    expect(screen.getByTestId("coming-up-move-summary")).toBe(note);
    expect(note.textContent).toBe("An email is planned at most 14 days ahead.");
    expect(note.className).toContain("text-danger");
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.getByRole("button", { name: "Day" }).getAttribute("aria-invalid")).toBe("true");
    expect(save.getAttribute("aria-describedby")).toBe(note.id);
  });

  it("a server refusal appears inside the Move form in the same note, not above it, and clears when the time changes", async () => {
    set("GET /api/workspace/email-plan", view([item({ schedule_gen: 4 })]));
    set(`POST /api/workspace/email-plan/${A}/move`, { error: { code: "list_spacing", message: "That list already has an email planned within 7 days of that time." } }, 409);
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    chooseClock("11:00");
    const panel = screen.getByTestId("coming-up-move");
    const note = within(panel).getByTestId("coming-up-move-summary");
    expect(note.textContent).toMatch(/^Sends .* PDT$/);
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(note.textContent).toContain("within 7 days"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(panel.contains(screen.getByRole("alert"))).toBe(true);
    expect(screen.getByRole("alert")).toBe(note);
    chooseClock("12:00");
    expect(note.textContent).toMatch(/^Sends .* PDT$/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Move and Change topic each have a Cancel that closes the form and drops what was typed", async () => {
    set("GET /api/workspace/email-plan", view([item({})]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    chooseDay("2026-10-23");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Day" })).toBeNull();
    pick("Move");
    expect(dayShown()).toContain("Wed 21 Oct 2026");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    pick("Change topic");
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Other" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Topic")).toBeNull();
    pick("Change topic");
    expect((screen.getByLabelText("Topic") as HTMLInputElement).value).toBe("Product news: shared calendars");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("moving a drafted email does not say Zavi will draft it again", async () => {
    const card = { rail: "channel_actions", id: C };
    set("GET /api/workspace/email-plan", view([item({ status: "ready", card, schedule_gen: 1 })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "More actions" }));
    pick("Move");
    chooseDay("2026-10-23");
    set("GET /api/workspace/email-plan", view([item({ status: "ready", card, schedule_gen: 2, planned_at: "2026-10-23T16:00:00Z" })]));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastTitles().join(" | ")).toContain("Moved."));
    expect(toastTitles().join(" | ")).not.toMatch(/drafts it/);
  });

  it("confirmations are success toasts, not a line left on the page, and the week strip and test-gate line are gone", async () => {
    const future = item({ planned_at: "2026-10-30T09:00:00Z", planned_label: "Fri, Oct 30, 09:00", timezone: "UTC" });
    set("GET /api/workspace/email-plan", { ...view([future]), timezone: "UTC" });
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByRole("button", { name: "Skip" }));
    set("GET /api/workspace/email-plan", { ...view([{ ...future, status: "skipped", status_reason: "skipped_by_founder" }]), timezone: "UTC" });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Skipped." })));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("coming-up-week")).toBeNull();
    expect(screen.queryByTestId("coming-up-gate")).toBeNull();
  });
});
