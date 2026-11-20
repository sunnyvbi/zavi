// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: () => Promise.resolve(true) }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { EmailComingUpBlock, wallParts } from "../EmailComingUpBlock";
import { EMAIL_PLAN_CHANGED_EVENT } from "../NewCampaignDialog";

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
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
});
afterEach(cleanup);

const ids = ["a1111111-1111-4111-8111-111111111111","b2222222-2222-4222-8222-222222222222","c3333333-3333-4333-8333-333333333333","d4444444-4444-4444-8444-444444444444","e5555555-5555-4555-8555-555555555555","f6666666-6666-4666-8666-666666666666"];
const card = (n: number) => ({ rail: "channel_actions", id: ids[n] });
const section = (testId: string) => screen.queryByTestId(`${testId}-section`);
const titles = (el: HTMLElement | null) => within(el as HTMLElement).getAllByTestId("coming-up-item").map((li) => li.getAttribute("data-card-id") ?? li.id);

describe("Coming up groups", () => {
  it("files each item under the heading that matches who it waits on, with matching counts", async () => {
    set(
      "GET /api/workspace/email-plan",
      view([
        item({ id: ids[0], angle: "P-one", status: "planned" }),
        item({ id: ids[1], angle: "N-one", status: "ready", card: card(1) }),
        item({ id: ids[2], angle: "D-one", status: "drafting" }),
        item({ id: ids[3], angle: "V-one", status: "ready", vetoed: true, schedule_gen: 2, card: card(3) }),
        item({ id: ids[4], angle: "S-one", status: "scheduled", card: card(4), scheduled: { variant: 1, count: 10, by: "u", at: "x" } }),
        item({ id: ids[5], angle: "P-two", status: "planned" }),
      ]),
    );
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("coming-up-item").length).toBe(6));
    const waiting = section("waiting-on-you") as HTMLElement;
    const coming = section("coming-up-group") as HTMLElement;
    expect(within(waiting).getByRole("heading", { name: /Waiting on you\s*2$/ })).toBeTruthy();
    expect(within(coming).getByRole("heading", { name: /Coming up\s*4$/ })).toBeTruthy();
    expect(within(waiting).getAllByTestId("coming-up-item").map((li) => li.getAttribute("data-status"))).toEqual(["ready", "ready"]);
    expect(within(waiting).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Waiting on you2", "N-one", "V-one"]);
    expect(within(coming).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Coming up4", "P-one", "D-one", "S-one", "P-two"]);
    expect(within(waiting).queryByText("Planned")).toBeNull();
    expect(within(coming).queryByText("Needs approval")).toBeNull();
    expect(titles(waiting)).toEqual([ids[1], ids[3]]);
  });

  it("a vetoed item reads as one state: no Needs approval chip, no second chip, Approve still enabled", async () => {
    set("GET /api/workspace/email-plan", view([item({ id: ids[3], status: "ready", vetoed: true, schedule_gen: 2, card: card(3) }), item({ id: ids[1], status: "ready", card: card(1) })]));
    set(`GET /api/email-cards/channel_actions/${ids[3]}`, { card: { open: true, list: { name: "L", people: 1 }, viewer_can_approve: true, can_approve: [true], chosen_variant: null, versions: [{ variant: 1, subject: "S", preview_text: null, tested_by_approver: true }] } });
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("coming-up-item").length).toBe(2));
    const [vetoed, normal] = screen.getAllByTestId("coming-up-item");
    expect(within(vetoed).getByText("You stopped this send")).toBeTruthy();
    expect(within(vetoed).getByText("Approve to send it at the planned time.")).toBeTruthy();
    expect(within(vetoed).queryByText("Needs approval")).toBeNull();
    expect(within(vetoed).queryByText(/You said/)).toBeNull();
    expect(await within(vetoed).findByRole("link", { name: "Approve and schedule" })).toBeTruthy();
    expect(within(normal).getByText("Needs approval")).toBeTruthy();
    expect(within(normal).queryByText(/stopped/)).toBeNull();
  });

  it("only planned items: no Waiting on you heading at all", async () => {
    set("GET /api/workspace/email-plan", view([item({ id: ids[0] }), item({ id: ids[1], status: "drafting" })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("coming-up-item").length).toBe(2));
    expect(screen.queryByTestId("waiting-on-you")).toBeNull();
    expect(screen.queryByText(/Waiting on you/)).toBeNull();
    expect(screen.getByRole("heading", { name: /Coming up\s*2$/ })).toBeTruthy();
  });

  it("only needs-approval items: no Coming up heading", async () => {
    set("GET /api/workspace/email-plan", view([item({ id: ids[1], status: "ready", card: card(1) })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => screen.getByTestId("waiting-on-you"));
    expect(screen.queryByTestId("coming-up-group")).toBeNull();
    expect(screen.getByRole("heading", { name: /Waiting on you\s*1$/ })).toBeTruthy();
  });

  it("an item that goes from planned to needs approval on refetch moves group and both counts update", async () => {
    const a = item({ id: ids[0], angle: "Mover" });
    const b = item({ id: ids[1], angle: "Stayer", planned_at: "2026-10-22T16:00:00Z" });
    set("GET /api/workspace/email-plan", view([a, b]));
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getAllByTestId("coming-up-item").length).toBe(2));
    expect(screen.queryByTestId("waiting-on-you")).toBeNull();
    expect(screen.getByRole("heading", { name: /Coming up\s*2$/ })).toBeTruthy();
    set("GET /api/workspace/email-plan", view([{ ...a, status: "ready", content_version: 2, card: card(0) }, b]));
    window.dispatchEvent(new Event(EMAIL_PLAN_CHANGED_EVENT));
    await waitFor(() => expect(screen.getByRole("heading", { name: /Waiting on you\s*1$/ })).toBeTruthy());
    expect(screen.getByRole("heading", { name: /Coming up\s*1$/ })).toBeTruthy();
    expect(within(section("waiting-on-you") as HTMLElement).getByText("Mover")).toBeTruthy();
    expect(within(section("coming-up-group") as HTMLElement).getByText("Stayer")).toBeTruthy();
    expect(within(section("coming-up-group") as HTMLElement).queryByText("Mover")).toBeNull();
  });

  it("separates every group after the first with a top divider and leaves the first bare", async () => {
    set("GET /api/workspace/email-plan", {
      ...view([
        item({ id: ids[0], angle: "W", status: "ready", card: card(0) }),
        item({ id: ids[1], angle: "C", status: "planned" }),
        item({ id: ids[2], angle: "Done", status: "sent", sent_at: "2026-10-20T16:00:00Z" }),
      ]),
      holds: [{ rail: "decisions", card_id: ids[3], list_key: "zavi_list:x", since: "x", since_label: "Mon, Oct 19, 10:00" }],
    });
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getByTestId("holds-section")).toBeTruthy());
    const groups = ["waiting-on-you-section", "coming-up-group-section", "past-section", "holds-section"].map((id) => screen.getByTestId(id));
    const divided = (el: HTMLElement) => el.classList.contains("border-t") && el.classList.contains("border-rule");
    expect(groups.map(divided)).toEqual([false, true, true, true]);
    expect(groups.slice(1).every((g) => g.classList.contains("mt-8") && g.classList.contains("pt-6"))).toBe(true);
  });

  it("puts the divider on the next group when the first group is empty", async () => {
    set("GET /api/workspace/email-plan", view([item({ id: ids[1], angle: "C", status: "planned" }), item({ id: ids[2], angle: "Done", status: "sent", sent_at: "2026-10-20T16:00:00Z" })]));
    render(<EmailComingUpBlock />);
    await waitFor(() => expect(screen.getByTestId("past-section")).toBeTruthy());
    expect(screen.queryByTestId("waiting-on-you-section")).toBeNull();
    expect(screen.getByTestId("coming-up-group-section").classList.contains("border-t")).toBe(false);
    expect(screen.getByTestId("past-section").classList.contains("border-t")).toBe(true);
  });
});
