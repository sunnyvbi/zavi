// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const routes: Record<string, unknown> = {};
const posted: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") posted.push(url);
    const body = routes[`${init?.method ?? "GET"} ${url}`] ?? { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: () => Promise.resolve(true) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { EmailComingUpBlock } from "../EmailComingUpBlock";

const item = (over: Record<string, unknown>) => ({
  id: "11111111-1111-4111-8111-111111111111",
  route: "mailchimp",
  list_id: "L1",
  list_name: "Paying customers",
  planned_at: "2026-10-31T16:00:00Z",
  planned_label: "Sat, Oct 31, 09:00",
  timezone: "America/Los_Angeles",
  angle: "Product news: shared calendars",
  why: "Product news beat tips.",
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
const view = (items: unknown[]) => ({ ok: true, role: "owner", timezone: "America/Los_Angeles", next_plan_at: "2026-11-02T15:00:00Z", next_plan_label: "Mon", items });

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  posted.length = 0;
});
afterEach(cleanup);

const REASON = "The list isn't in your Mailchimp account any more, so Zavi could not draft this email. Skip it, and plan one to a list you still have.";

describe("a planned email's run was refused for good, so no card exists", () => {
  const REPEAT = "You already approved a similar email to this list, so Zavi did not draft this one. Change the topic, or skip it.";
  const BUG = "Zavi could not file the draft. Try Draft now again.";
  const row = async (over: Record<string, unknown>) => {
    routes["GET /api/workspace/email-plan"] = view([item({ status: "blocked", ...over })]);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-section")).toBeTruthy());
    return within(screen.getByTestId("waiting-on-you-section")).getByTestId("coming-up-item");
  };
  const stillDrafting = (r: HTMLElement) => {
    expect(within(r).queryByTestId("coming-up-drafting-status")).toBeNull();
    expect(within(r).queryByText("Your draft appears here when it's ready.")).toBeNull();
    expect(within(r).queryByText("Drafting")).toBeNull();
  };

  it("must catch: a repeat shows the reason, no loader, and offers the topic and Skip, not Draft now", async () => {
    const r = await row({ status_reason: "draft_blocked:channel_card_already_done", reason: REPEAT, blocked_fix: "change_topic", draft_requested: true });
    expect(within(r).getByText(REPEAT)).toBeTruthy();
    stillDrafting(r);
    expect(within(r).queryByRole("button", { name: "Draft now" })).toBeNull();
    expect(within(r).getByRole("button", { name: "Skip" })).toBeTruthy();
    fireEvent.click(within(r).getByRole("button", { name: /more/i }));
    fireEvent.click(await within(r).findByRole("menuitem", { name: "Change topic" }));
    expect(within(r).getByLabelText("Topic")).toBeTruthy();
  });

  it("must catch: a Zavi bug refusal shows the reason, no loader, and Draft now asks again", async () => {
    routes["POST /api/workspace/email-plan/11111111-1111-4111-8111-111111111111/draft-now"] = { ok: true };
    const r = await row({ status_reason: "draft_blocked:email_campaign_body_invalid", reason: BUG, blocked_fix: "draft_now" });
    expect(within(r).getByText(BUG)).toBeTruthy();
    stillDrafting(r);
    fireEvent.click(within(r).getByRole("button", { name: "Draft now" }));
    await waitFor(() => expect(posted.some((u) => /draft/.test(u))).toBe(true));
  });

  it("a block the founder fixes elsewhere offers neither", async () => {
    const r = await row({ status_reason: "draft_blocked:email_audience_missing", reason: REASON, blocked_fix: null });
    expect(within(r).queryByRole("button", { name: "Draft now" })).toBeNull();
    expect(within(r).queryByRole("button", { name: /more/i })).toBeNull();
  });
});

describe("a planned email whose draft hit a refusal a retry cannot fix (8186)", () => {
  it("must catch 8186: it waits on the founder with the reason, never the drafting note", async () => {
    routes["GET /api/workspace/email-plan"] = view([
      item({ status: "blocked", status_reason: "draft_blocked:email_audience_missing", reason: REASON, draft_requested: true, list_id: "seed-new-signups" }),
      item({ id: "33333333-3333-4333-8333-333333333333", planned_at: "2026-11-02T16:00:00Z", planned_label: "Mon, Nov 2, 09:00", angle: "Tips" }),
    ]);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getByTestId("waiting-on-you-section")).toBeTruthy());
    const waiting = screen.getByTestId("waiting-on-you-section");
    const rows = within(waiting).getAllByTestId("coming-up-item");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText(REASON)).toBeTruthy();
    expect(within(rows[0]).getByText("Blocked")).toBeTruthy();
    expect(within(rows[0]).queryByText("Your draft appears here when it's ready.")).toBeNull();
    expect(within(rows[0]).queryByRole("status")).toBeNull();
    expect(within(rows[0]).queryByText("Drafting")).toBeNull();
    const coming = screen.getByTestId("coming-up-group-section");
    expect(within(coming).queryByText(REASON)).toBeNull();
    expect(within(coming).getAllByTestId("coming-up-item")).toHaveLength(1);
    expect(screen.queryByText("Your draft appears here when it's ready.")).toBeNull();
  });
});
