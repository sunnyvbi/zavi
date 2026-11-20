// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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

const MAY_HAVE = "Zavi stopped this send. 3 people got it, and 2 more may have: their email provider never confirmed. Zavi will not send it to them again.";
const STALE = "Zavi stopped this send. 7 of the 10 people on the list were not emailed.";
const cell = (value: number | null) => ({ value, why: null });
const row = (id: string, over: Partial<SentEmail>): SentEmail => ({
  card: { rail: "decisions", id, link: "" },
  route: "zavi_list",
  sent_with: "Zavi",
  subject: id,
  list_name: "Members",
  started_at: "2026-10-28T09:00:00Z",
  finished_at: "2026-10-28T10:00:00Z",
  spanned: false,
  stage: "h1_due",
  people: { sent: 3, total: 10, stopped: true },
  as_of: null,
  delivered: cell(3),
  opens: cell(null),
  opens_label: "Opens",
  clicks: cell(null),
  unsubscribes: cell(null),
  visitors: cell(null),
  win_line: { text: "2.0% of delivered visit your site", metric: "visitors", threshold: 0.02, basis: "median" },
  verdict: null,
  verdict_text: "",
  d7_due_at: null,
  note: null,
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  routes["GET /api/workspace/email-plan"] = { status: 200, body: { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: null, items: [], released: [], holds: [] } };
});
afterEach(cleanup);

describe("Sent emails names a may-have-sent send the same way the card does (ROI #4)", () => {
  it("reads Delivery unknown with the outcome reason, never Stopped and never the stale not-emailed note", async () => {
    routes["GET /api/email-results"] = {
      status: 200,
      body: {
        more: false,
        emails: [
          row("Maybe", { stop_note: STALE, outcome: { status: "outcome_unknown", sent: 3, total: 10, unknown: 2, may_have_sent: true, reason: MAY_HAVE, pause_hold: null } }),
          row("Stopped clean", { stop_note: "Stopped after 3 people.", outcome: { status: "stopped", sent: 3, total: 10, unknown: 0, may_have_sent: false, reason: "Stopped after 3 people.", pause_hold: null } }),
        ],
      },
    };
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    const pills = screen.getAllByTestId("status-pill").map((p) => p.textContent);
    expect(pills).toEqual(["Delivery unknown", "Stopped"]);
    const notes = screen.getAllByTestId("stop-note").map((n) => n.textContent);
    expect(notes).toEqual([MAY_HAVE, "Stopped after 3 people."]);
    expect(document.body.textContent).not.toMatch(/were not emailed/);
  });
});
