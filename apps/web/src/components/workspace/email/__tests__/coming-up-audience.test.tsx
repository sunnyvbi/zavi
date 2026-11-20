// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const r = routes[`${method} ${url}`] ?? { status: 200, body: { ok: true } };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body), clone() { return this; } });
  },
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: () => Promise.resolve(true) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { EmailComingUpBlock } from "../EmailComingUpBlock";
import { forgetEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";

const ITEM = "11111111-1111-4111-8111-111111111111";
const CARD = "33333333-3333-4333-8333-333333333333";
const LIST = "44444444-4444-4444-8444-444444444444";

const item = (route: string) => ({
  id: ITEM,
  route,
  list_id: LIST,
  list_name: "Newsletter",
  planned_at: "2099-10-30T05:00:00Z",
  planned_label: "Fri, Oct 30, 05:00",
  timezone: "UTC",
  angle: "Fresh from the oven today",
  why: null,
  source: "email_agent",
  status: "ready",
  status_reason: null,
  reason: null,
  content_version: 1,
  schedule_gen: 1,
  card: { rail: "decisions", id: CARD },
  vetoed: false,
  scheduled: null,
  unattended: false,
  sent_at: null,
});

const cardView = (route: string, people: number) => ({
  rail: "decisions",
  id: CARD,
  class: route === "zavi_list" ? "bulk_outbound.send" : "email_campaign.create_and_send",
  status: "proposed",
  open: true,
  route,
  list: { name: "Newsletter", people },
  versions: [{ variant: 1, subject: "Fresh from the oven today", preview_text: "Chocolate cake box", content: { subject: "Fresh from the oven today", preview_text: "Chocolate cake box", paragraphs: ["Hi"] }, tested_by_me: false, tested_by_approver: false }],
  chosen_variant: null,
  viewer_can_approve: true,
  can_approve: [false],
  test_list: false,
  test_list_unknown: false,
});

const serve = (route: string, sealed: number, listNow: number) => {
  routes["GET /api/workspace/email-plan"] = { status: 200, body: { ok: true, role: "owner", timezone: "UTC", next_plan_at: null, next_plan_label: null, items: [item(route)] } };
  routes[`GET /api/email-cards/decisions/${CARD}`] = { status: 200, body: { card: cardView(route, sealed) } };
  routes["GET /api/workspace/email-test-lists"] = {
    status: 200,
    body: { routes: [{ route, label: "Lists", status: "ok", error: null, lists: [{ id: LIST, name: "Newsletter", people: listNow, marked: false, looks_like_test: false }] }], orphans: [] },
  };
};

const rowText = () => screen.getByTestId("coming-up-item").textContent ?? "";

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  forgetEmailTestLists();
});
afterEach(cleanup);

describe("Coming up: the audience on a planned email's row", () => {
  it("Notion Flow 97: a Zavi list imported again after the draft shows the draft's sealed count, the one the card shows and the send reaches", async () => {
    serve("zavi_list", 3, 6);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("email-box-subject")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(rowText()).toContain("Newsletter");
    expect(rowText()).toContain("3 people");
    expect(rowText()).not.toContain("6 people");
  });

  it("an email tool's audience keeps the size read just now, since the tool sends to whoever is on it then", async () => {
    serve("mailchimp", 3, 6);
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("email-box-subject")).toHaveLength(1));
    await waitFor(() => expect(rowText()).toContain("6 people"));
    expect(rowText()).not.toContain("3 people");
  });
});
