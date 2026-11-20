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

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  routes["GET /api/workspace/email-plan"] = { status: 200, body: { ok: true, role: "owner", timezone: "America/Los_Angeles", next_plan_at: null, next_plan_label: null, autopilot_on: null, items: [], released: [], holds: [] } };
});
afterEach(() => cleanup());

describe("Flow 39: campaigns table scrolls sideways instead of collapsing (structural only, jsdom has no layout)", () => {
  it("keeps the table in its own scroll box with a minimum table and campaign column width", async () => {
    routes["GET /api/email-results"] = { status: 200, body: { more: false, emails: [sent({ numbers_note: "Opens stopped at 1 hour." })] } };
    render(<SentEmailsBlock />);
    const box = await screen.findByTestId("campaign-table-box");
    const table = screen.getByTestId("campaign-table");
    expect(box.className).toContain("overflow-x-auto");
    expect(box.className).toContain("max-w-full");
    expect(box.contains(table)).toBe(true);
    expect(table.className).toMatch(/min-w-\[[6-9]\d\dpx\]/);
    const th = screen.getByRole("columnheader", { name: "Campaign" });
    expect(th.className).toContain("min-w-[220px]");
    expect(screen.getByTestId("row-sent").querySelector("td")!.className).toContain("min-w-[220px]");
    expect(screen.getByRole("columnheader", { name: "Status" }).className).toContain("whitespace-nowrap");
    expect(screen.getByTestId("status-pill").className).toContain("whitespace-nowrap");
    const note = screen.getByTestId("numbers-note");
    expect(note.closest("div")!.className).not.toContain("overflow-wrap:anywhere");
  });
});
