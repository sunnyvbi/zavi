// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: async (url: string) => {
    const r = routes[`GET ${url}`] ?? { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) };
  },
}));
vi.mock("@/app/connectors/GoogleAnalyticsConnectButton", () => ({ startGoogleAnalyticsConnect: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { SentEmailsBlock } from "../SentEmailsBlock";
import type { SentEmail } from "@/lib/workspace/emailResultsApi";

const cell = (value: number | null) => ({ value, why: null });
const sent = (over: Partial<SentEmail>): SentEmail =>
  ({
    card: { rail: "decisions", id: "a", link: "" },
    route: "zavi_list",
    sent_with: "Zavi",
    subject: "Launch",
    list_name: "Members",
    started_at: "2026-11-02T07:46:00Z",
    finished_at: "2026-11-02T07:46:00Z",
    spanned: false,
    stage: "h1_due",
    people: { sent: 3, total: 3, stopped: false },
    as_of: null,
    delivered: cell(3),
    opens: cell(null),
    opens_label: "Opens",
    clicks: cell(null),
    unsubscribes: cell(null),
    visitors: cell(null),
    win_line: null,
    verdict: null,
    verdict_text: "",
    d7_due_at: null,
    note: null,
    timezone: "America/Los_Angeles",
    ...over,
  }) as SentEmail;

const savedTz = process.env.TZ;
beforeEach(() => {
  process.env.TZ = "Asia/Kolkata";
  for (const k of Object.keys(routes)) delete routes[k];
  routes["GET /api/workspace/email-plan"] = { status: 200, body: { ok: true, role: "owner", timezone: "America/Los_Angeles", next_plan_at: null, next_plan_label: null, autopilot_on: null, items: [], released: [], holds: [] } };
});
afterEach(() => {
  cleanup();
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("Flow 56: one send, one date", () => {
  it("shows the sent date in the viewer's time zone, not the campaign's", async () => {
    routes["GET /api/email-results"] = { status: 200, body: { more: false, emails: [sent({})] } };
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    const viewer = new Date("2026-11-02T07:46:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    expect(viewer).toBe("Nov 2");
    expect(screen.getByTestId("campaign-meta").textContent).toBe("Members · Nov 2");
  });

  it("near midnight a sent row follows the viewer while a planned row keeps the campaign's day", async () => {
    const lateAt = "2026-10-21T17:00:00Z";
    routes["GET /api/email-results"] = { status: 200, body: { more: false, emails: [sent({ timezone: "Asia/Tokyo", started_at: lateAt, finished_at: lateAt })] } };
    routes["GET /api/workspace/email-plan"] = {
      status: 200,
      body: {
        ok: true, role: "owner", timezone: "Asia/Tokyo", next_plan_at: null, next_plan_label: null, autopilot_on: null, holds: [], released: [],
        items: [{ id: "p1", route: "mailchimp", list_id: "L1", angle: "Plan", why: null, source: "email_agent", status: "scheduled", status_reason: null, reason: null, content_version: 1, planned_at: lateAt, planned_label: "x", timezone: "Asia/Tokyo", list_name: "Members", vetoed: false }],
      },
    };
    render(<SentEmailsBlock />);
    const sentRow = await screen.findByTestId("row-sent");
    const planRow = await screen.findByTestId("row-scheduled");
    expect(within(sentRow).getByTestId("campaign-meta").textContent).toContain("Oct 21");
    expect(within(planRow).getByTestId("campaign-meta").textContent).toContain("Oct 22");
  });
});
