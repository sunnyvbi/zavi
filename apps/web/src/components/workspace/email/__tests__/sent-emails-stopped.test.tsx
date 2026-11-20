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

const NOTE = "Zavi's sender stopped making progress on this send and could not restart it, so the rest of the list was not emailed. 2 of the 3 people on the list were not emailed, and Zavi will not send it to them on its own.";
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
  people: { sent: 1, total: 3, stopped: true },
  as_of: null,
  delivered: cell(1),
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

describe("Bug 81ac: a send the recovery sweep gave up on, in the Campaigns table", () => {
  it("reads Stopped with the stalled reason and how many were not emailed, never a clean Sent, while a finished send beside it still reads Sent", async () => {
    routes["GET /api/email-results"] = {
      status: 200,
      body: { more: false, emails: [row("Stalled", { stop_note: NOTE }), row("Clean", { people: { sent: 40, total: null, stopped: false }, stop_note: null })] },
    };
    render(<SentEmailsBlock />);
    await screen.findByTestId("stat-strip");
    const pills = screen.getAllByTestId("status-pill").map((p) => [p.getAttribute("data-tone"), p.textContent]);
    expect(pills).toEqual([
      ["stopped", "Stopped"],
      ["sent", "Sent"],
    ]);
    const stalledPill = screen.getAllByTestId("status-pill")[0];
    expect(stalledPill.className).toContain("text-danger");
    expect(stalledPill.className).not.toContain("text-success");
    const notes = screen.getAllByTestId("stop-note");
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toBe(NOTE);
    const stalledRow = notes[0].closest("tr") ?? notes[0].parentElement!.parentElement!;
    expect(within(stalledRow as HTMLElement).getByText("Stalled")).toBeTruthy();
    expect(screen.getByText("1 of 3")).toBeTruthy();
  });
});
