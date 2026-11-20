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

import { SentEmailsBlock, snapshotLine } from "../SentEmailsBlock";
import { HistoryDetailDialog } from "../../actions/history/HistoryDetailDialog";
import { ResultsRow } from "@/components/email/EmailCampaignCard";
import type { SentEmail } from "@/lib/workspace/emailResultsApi";
import type { ChannelClosedRow } from "../../actions/useChannelHistory";

const NOTE = "SendGrid was disconnected; numbers stopped at 1 hour.";
const CARRIED_WHY = "From the 1-hour check: day 7 could not be read";
const CARRIED = { delivered: 5, opens: 0, clicks: 0, bounces: null, why: { delivered: CARRIED_WHY, opens: CARRIED_WHY, clicks: CARRIED_WHY }, note: NOTE };
const cell = (value: number | null, why: string | null = null) => ({ value, why });
const row = (id: string, over: Partial<SentEmail> = {}): SentEmail => ({
  card: { rail: "channel_actions", id, link: "" },
  route: "sendgrid",
  sent_with: "SendGrid",
  subject: id,
  list_name: "Members",
  started_at: "2026-10-12T09:00:00Z",
  finished_at: "2026-10-12T10:00:00Z",
  spanned: false,
  stage: "d7",
  people: { sent: 5, total: null, stopped: false },
  as_of: "d7",
  delivered: cell(5),
  opens: cell(0),
  opens_label: "Opens",
  clicks: cell(0),
  unsubscribes: cell(0),
  visitors: cell(null),
  win_line: { text: "2.0% of delivered visit your site", metric: "visitors", threshold: 0.02, basis: "median" },
  verdict: null,
  verdict_text: "",
  d7_due_at: null,
  note: null,
  ...over,
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
  for (const k of Object.keys(routes)) delete routes[k];
  routes["GET /api/workspace/email-plan"] = { status: 200, body: { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, autopilot_on: null, items: [], released: [], holds: [] } };
});
afterEach(cleanup);

describe("day 7 numbers carried from 1 hour", () => {
  it("the email card line keeps the numbers and puts the note right under them, once", () => {
    render(<ResultsRow label="At day 7:" r={CARRIED} />);
    const box = screen.getByTestId("email-card-results");
    expect(box.textContent).toContain("At day 7: Delivered 5 · Opens 0 · Clicks 0");
    expect(screen.getByTestId("email-card-results-note").textContent).toBe(NOTE);
    expect(box.textContent?.match(/numbers stopped/g)).toHaveLength(1);
    expect(screen.queryByTestId("email-card-results-why")).toBeNull();
  });

  it("the line with real numbers has no note", () => {
    render(<ResultsRow label="At day 7:" r={{ delivered: 5, opens: 3, clicks: 1, why: { delivered: null, opens: null, clicks: null } }} />);
    expect(screen.queryByTestId("email-card-results-note")).toBeNull();
  });

  it("the Done popup shows the 1 hour line clean and the note only on the day 7 line, with one Done and no Close or X", () => {
    const item = {
      source: "action",
      row: {
        id: "ca-1", run_id: "r", position: 1, run_of: 1, action_type: "send_message", title: "Launch", status: "acted", status_at: "2026-10-16T06:31:00Z", note: null,
        proposed_at: "2026-10-16T06:30:46Z", impact: 1, impact_reason: null, score: 1,
        sent: { count: 5, list: "Members", tool: "sendgrid", at: "2026-10-16T06:31:00Z", hour_1: { delivered: 5, opens: 0, clicks: 0, why: { delivered: null, opens: null, clicks: null } }, day_7: CARRIED },
      } as ChannelClosedRow,
    } as const;
    render(<HistoryDetailDialog item={item} onClose={() => undefined} />);
    const [hour, week] = screen.getAllByTestId("email-card-results");
    expect(hour.textContent).toContain("After 1 hour:");
    expect(hour.textContent).not.toContain("numbers stopped");
    expect(week.textContent).toContain("At day 7:");
    expect(within(week).getByTestId("email-card-results-note").textContent).toBe(NOTE);
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Done" })).toHaveLength(1);
  });

  it("the Overview table puts the note on that email only", async () => {
    routes["GET /api/email-results"] = { status: 200, body: { more: false, emails: [row("Carried", { numbers_note: NOTE }), row("Real")] } };
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    const notes = screen.getAllByTestId("numbers-note");
    expect(notes.map((n) => n.textContent)).toEqual([NOTE]);
    expect(within(notes[0].closest("tr") as HTMLElement).getByText("Carried")).toBeTruthy();
  });

  it("the snapshot line stops claiming every number is from 7 days once one was carried", () => {
    expect(snapshotLine([row("Real")])).toBe("Numbers are from 7 days after each send.");
    expect(snapshotLine([row("Real"), row("Carried", { numbers_note: NOTE })])).toBe("Some numbers stopped at 1 hour: see the note on that email.");
  });
});
