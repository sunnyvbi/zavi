// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const routes: Record<string, unknown> = {};
const calls: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
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
const LINE = "Your draft appears here when it's ready.";
const view = (items: unknown[]) => ({ ok: true, role: "owner", timezone: "America/Los_Angeles", next_plan_at: "2026-11-02T15:00:00Z", next_plan_label: "Mon", items });

beforeEach(() => {
  for (const k of Object.keys(routes)) delete routes[k];
  calls.length = 0;
});
afterEach(cleanup);

describe("a planned email whose draft was already asked for", () => {
  it("on first load says where the draft appears, drops the day-before line and offers no Draft now", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ draft_requested: true })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    expect(within(row).getByText(LINE)).toBeTruthy();
    expect(within(row).queryByText("Zavi drafts it the day before.")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Draft now" })).toBeNull();
    expect(within(row).getByText("Drafting")).toBeTruthy();
  });

  it("an unrequested planned email keeps the day-before line and Draft now", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ draft_requested: false })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    expect(within(row).getByText("Zavi drafts it the day before.")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Draft now" })).toBeTruthy();
    expect(within(row).queryByText(LINE)).toBeNull();
  });

  it("shows a live status with an animated dot only while the draft is requested", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ draft_requested: true })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    const status = within(row).getByRole("status");
    expect(status.textContent).toBe(LINE);
    expect(status.getAttribute("data-testid")).toBe("coming-up-drafting-status");
    const dot = within(row).getByTestId("email-chip-live-dot");
    expect(dot.className).toContain("motion-safe:animate-pulse");
    expect(status.querySelector(".motion-safe\\:animate-shimmer")).toBeTruthy();
  });

  it("keeps the loader once the worker has started the draft and the item is drafting", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ status: "drafting", draft_requested: true })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    const status = within(row).getByRole("status");
    expect(status.textContent).toBe(LINE);
    expect(status.querySelector(".motion-safe\\:animate-shimmer")).toBeTruthy();
    expect(within(row).getByTestId("email-chip-live-dot")).toBeTruthy();
    expect(within(row).getByText("Drafting")).toBeTruthy();
  });

  it("shows the loader for a drafting item that carries no requested flag", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ status: "drafting", draft_requested: false })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    expect(within(row).getByRole("status").textContent).toBe(LINE);
  });

  it.each([
    ["not requested", { draft_requested: false }],
    ["ready", { status: "ready", draft_requested: false }],
    ["skipped", { status: "skipped", draft_requested: false }],
  ])("renders no live status when %s", async (_n, over) => {
    routes["GET /api/workspace/email-plan"] = view([item(over)]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    expect(within(row).queryByRole("status")).toBeNull();
    expect(within(row).queryByTestId("email-chip-live-dot")).toBeNull();
  });
});

describe("the draft in progress state", () => {
  it("says it once: no second drafting sentence on the card, and the status holds only the line", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ draft_requested: true })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    expect(row.textContent).not.toContain("drafting it now");
    expect(row.textContent).not.toContain("writing this email");
    expect(row.textContent?.split(LINE)).toHaveLength(2);
    expect(within(row).getByRole("status").textContent).toBe(LINE);
  });

  it("shows a hidden ghost shaped like the real email box: subject, preview and varied body lines", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ draft_requested: true })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    const ghost = within(row).getByTestId("email-box-ghost");
    expect(within(row).getByRole("status").contains(ghost)).toBe(true);
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    const lines = within(ghost).getAllByTestId("email-ghost-line");
    expect(lines).toHaveLength(7);
    expect(new Set(lines.map((l) => l.className.split(/\s+/).find((c) => c.startsWith("w-")))).size).toBeGreaterThanOrEqual(5);
    expect(lines[0].className.split(/\s+/)).toContain("h-3.5");
    for (const l of lines.slice(2)) expect(l.className.split(/\s+/)).toContain("h-2");
    const delays = lines.map((l) => (l.firstElementChild as HTMLElement).style.animationDelay);
    expect(new Set(delays).size).toBe(7);
  });

  it("sweeps only under motion-safe, on theme tokens, and stays static under reduced motion", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ draft_requested: true })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    for (const line of within(row).getAllByTestId("email-ghost-line")) {
      expect(line.className.split(/\s+/)).toContain("bg-bone");
      const sweep = (line.firstElementChild as HTMLElement).className.split(/\s+/);
      expect(sweep).toContain("motion-safe:animate-shimmer");
      expect(sweep).toContain("motion-reduce:hidden");
      expect(sweep).not.toContain("animate-shimmer");
    }
  });

  it("keeps Skip and the more menu working on the drafting card", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ draft_requested: true })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    fireEvent.click(within(row).getByRole("button", { name: "More actions" }));
    expect(within(row).getByRole("menuitem", { name: "Move" })).toBeTruthy();
    expect(within(row).getByRole("menuitem", { name: "Change topic" })).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(calls).toContain("POST /api/workspace/email-plan/11111111-1111-4111-8111-111111111111/skip"));
  });
});

describe("the source pill sits in the top-right of the card", () => {
  const CARD = { rail: "channel_actions", id: "33333333-3333-4333-8333-333333333333" };
  const STATES: Array<[string, Record<string, unknown>]> = [
    ["planned", {}],
    ["drafting requested", { draft_requested: true }],
    ["drafting", { status: "drafting" }],
    ["ready", { status: "ready", card: CARD }],
    ["stopped", { status: "ready", card: CARD, vetoed: true }],
    ["scheduled", { status: "scheduled", card: CARD }],
    ["blocked", { status: "blocked", reason: "Blocked for a reason." }],
    ["skipped", { status: "skipped", status_reason: "skipped_by_founder" }],
    ["sent", { status: "sent", sent_at: "2026-10-31T16:00:00Z" }],
  ];

  it.each(STATES.flatMap(([name, over]) => [
    [name, "founder", "Planned by your team", over] as const,
    [name, "growth_agent", "Suggested by your growth plan", over] as const,
  ]))("%s from %s: on the chip's row, once, and clear of the date", async (_n, src, label, over) => {
    routes["GET /api/workspace/email-plan"] = view([item({ source: src, ...over })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    const meta = within(row).getByTestId("email-card-meta");
    const corner = within(meta).getByTestId("email-card-corner");
    expect(within(row).getAllByText(label)).toHaveLength(1);
    expect(corner.textContent).toBe(label);
    expect(corner.parentElement).toBe(meta);
    const text = within(meta).getByTestId("email-card-meta-text");
    expect(text.textContent).toContain("Paying customers");
    expect(text.textContent).not.toContain(label);
    expect(corner.className.split(/\s+/)).toEqual(expect.arrayContaining(["ml-auto", "order-1"]));
    expect(text.className.split(/\s+/)).toEqual(expect.arrayContaining(["order-2", "basis-full", "[@container(min-width:640px)]:flex-1"]));
    expect(meta.className.split(/\s+/)).toContain("[@container(min-width:640px)]:flex-nowrap");
    expect(row.className.split(/\s+/)).toContain("[container-type:inline-size]");
  });

  it("an email Zavi planned itself has no pill and no corner slot", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ source: "email_agent", draft_requested: true })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    expect(within(row).queryByTestId("email-card-corner")).toBeNull();
    expect(within(row).getByTestId("email-card-meta-text").className).not.toContain("basis-full");
  });

  it("the hold chip stays below the meta row", async () => {
    routes["GET /api/workspace/email-plan"] = view([item({ source: "founder", hold: { unresolved: true } })]);
    render(<EmailComingUpBlock />);
    const row = await screen.findByTestId("coming-up-item");
    expect(within(row).getByTestId("email-card-meta").contains(within(row).getByText("List on hold"))).toBe(false);
  });
});
