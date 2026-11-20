// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ProposalSummary } from "./ProposalCard";
import { ChatDecisionRun } from "./ChatDecisionRun";
import type { LiveDecisionRow } from "@/lib/approvals/decisionApi";

const CLS = "meta_ads.set_status_review";
const LEAD = "Oct 1-20: $853.76 spend, 14 Meta-counted purchases ($60.98 each), ROAS 5.93, optimizing for Purchase.";
const ON_BODY = {
  object_id: "900",
  level: "adset",
  status: "ACTIVE",
  verified_name: "Zavi · Host Recommended Areas (copy) · zvf101c3e846",
  object_daily_budget: 60,
  object_status: "PAUSED",
  currency: "USD",
  origin: "user_initiated_chat",
  founder_chat_order: true,
  move_group: "g",
  about: "Restart Atlanta/Houston copy at its existing $60/day budget",
  rationale: `${LEAD} Cheapest booking cost of any Meta ad set with real volume.`,
};
const pause = (id: string, name: string, usd: number) => ({ object_id: id, level: "adset", status: "PAUSED", verified_name: name, object_daily_budget: usd, object_status: "ACTIVE", origin: "user_initiated_chat", founder_chat_order: true, move_group: "g", cut_guard_note: "it still brings 52 sign-ups" });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = (id: string, body: Record<string, unknown>, status = "proposed"): LiveDecisionRow => ({ id, decision_class: CLS, handler: CLS, body, status, dispatched_at: null, dispatch_error: null, founder_advice: { warnings: [] } });

afterEach(() => cleanup());
beforeEach(() => apiFetch.mockReset());

describe("a money-first ad card", () => {
  it("must-catch: leads with the action, the clean name and $0 -> $60/day, amber; no ROAS badge; stats once", () => {
    render(<ProposalSummary decisionClass={CLS} handler={CLS} body={ON_BODY} />);
    const text = () => document.body.textContent ?? "";
    expect(screen.getByText("Turn on Host Recommended Areas (copy)")).toBeTruthy();
    expect(screen.getByTestId("money-line").textContent).toContain("$0 → $60/day");
    expect(screen.getByText("Spend up $60/day").className).toContain("text-[#8a5a10]");
    expect(text()).not.toMatch(/zvf101c3e846|× ROAS/);
    expect(text().split(LEAD).length - 1).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Why this change?" }));
    expect(text()).toContain("Cheapest booking cost");
    expect(text().split(LEAD).length - 1).toBe(1);
  });

  it("a pause is $100/day -> $0 in neutral grey, never red", () => {
    render(<ProposalSummary decisionClass={CLS} handler={CLS} body={pause("1", "Regular Leads - Ad set", 100)} />);
    expect(screen.getByText("Pause Regular Leads - Ad set")).toBeTruthy();
    expect(screen.getByTestId("money-line").textContent).toContain("$100/day → $0");
    const chip = screen.getByText("Spend down $100/day");
    expect(chip.className).toContain("text-[#595959]");
    expect(chip.className).not.toMatch(/c0392b/);
  });

  it("must-not-invent: without the object's budget, no amounts are shown", () => {
    const { object_daily_budget: _b, ...noAmount } = ON_BODY;
    render(<ProposalSummary decisionClass={CLS} handler={CLS} body={noAmount} />);
    expect(screen.getByText("Turn on Host Recommended Areas (copy)")).toBeTruthy();
    expect(screen.queryByTestId("money-line")).toBeNull();
  });
});

describe("an object already on", () => {
  it("F3: says it adds nothing, never $0 -> $60", () => {
    render(<ProposalSummary decisionClass={CLS} handler={CLS} body={{ ...ON_BODY, object_status: "ACTIVE" }} />);
    expect(screen.getByTestId("money-line").textContent).toContain("$60/day → $60/day");
    expect(screen.getByText("Already on, adds nothing")).toBeTruthy();
    expect(screen.queryByText(/Spend up/)).toBeNull();
  });
});

describe("a founder move in a chat", () => {
  it("must-catch: one header with the total, pauses first, each card with its own buttons, Autopilot on one line", async () => {
    const rows: Record<string, LiveDecisionRow> = {
      on: row("on", ON_BODY),
      pa: row("pa", pause("1", "Regular Leads - Ad set", 100)),
      pb: row("pb", pause("2", "Regular Leads (copy)", 80)),
    };
    apiFetch.mockImplementation(async (url: string) => {
      const id = /approvals\/([^/?]+)/.exec(url)?.[1] ?? "";
      return json(200, { decision: rows[id], home: { kind: "growth" }, needs_owner_admin: false, viewer_role: "owner" });
    });
    const item = (id: string) => ({ body: { decision_id: id, decision_class: CLS, title: id, full_card: true }, node: <p>plain {id}</p> });
    render(<ChatDecisionRun items={[item("on"), item("pa"), item("pb")]} />);
    const header = await screen.findByTestId("move-header");
    expect(header.textContent).toContain("−$120/day (turn on $60, pause $180)");
    expect(header.textContent).toContain("0 of 3 decided");
    expect(within(header).queryByRole("button")).toBeNull();
    const group = screen.getByTestId("move-group");
    await screen.findByText("Turn on Host Recommended Areas (copy)");
    const titles = within(group).getAllByText(/^(Pause|Turn on) /, { selector: "p" }).map((e) => e.textContent);
    expect(titles).toEqual(["Pause Regular Leads - Ad set", "Pause Regular Leads (copy)", "Turn on Host Recommended Areas (copy)"]);
    expect(within(group).getAllByRole("button", { name: /^(Pause it|Turn it on)$/ }).map((b) => b.textContent)).toEqual(["Pause it", "Pause it", "Turn it on"]);
    expect(within(group).getAllByTestId("autopilot-disagrees")[0].textContent).toBe("Autopilot disagrees: it still brings 52 sign-ups.");
    expect(screen.queryByText(/plain /)).toBeNull();
  });

  it("must-not-touch: cards from different moves (or none) render as before, in order", async () => {
    const rows: Record<string, LiveDecisionRow> = { a: row("a", { ...ON_BODY, move_group: "g1" }), b: row("b", { ...ON_BODY, move_group: "g2" }) };
    apiFetch.mockImplementation(async (url: string) => json(200, { decision: rows[/approvals\/([^/?]+)/.exec(url)?.[1] ?? ""], home: { kind: "growth" }, needs_owner_admin: false, viewer_role: "owner" }));
    const item = (id: string) => ({ body: { decision_id: id, decision_class: CLS, title: id }, node: <p>plain {id}</p> });
    render(<ChatDecisionRun items={[item("a"), item("b")]} />);
    expect(await screen.findByText("plain a")).toBeTruthy();
    expect(screen.getByText("plain b")).toBeTruthy();
    expect(screen.queryByTestId("move-header")).toBeNull();
  });

  it("must-catch Oct 20: the Oct 20 pauses and a newer move render as two separate moves, never under one header", async () => {
    const rows: Record<string, LiveDecisionRow> = {
      o1: row("o1", { ...pause("1", "Regular Leads - Ad set", 100), move_group: "run-root" }),
      o2: row("o2", { ...pause("2", "Regular Leads (copy)", 80), move_group: "run-root" }),
      n1: row("n1", { ...pause("3", "Houston", 50), move_group: "2bdc4968" }),
      n2: row("n2", { ...ON_BODY, move_group: "2bdc4968" }),
    };
    apiFetch.mockImplementation(async (url: string) => json(200, { decision: rows[/approvals\/([^/?]+)/.exec(url)?.[1] ?? ""], home: { kind: "growth" }, needs_owner_admin: false, viewer_role: "owner" }));
    const item = (id: string, extra: Record<string, unknown> = {}) => ({ body: { decision_id: id, decision_class: CLS, title: id, full_card: true, ...extra }, node: <p>plain {id}</p> });
    render(<ChatDecisionRun items={[item("o1", { from_other_chat: true, filed_at: "2026-10-20T18:00:00Z" }), item("n1"), item("o2", { from_other_chat: true, filed_at: "2026-10-20T18:00:00Z" }), item("n2")]} />);
    await screen.findAllByTestId("move-header");
    const groups = screen.getAllByTestId("move-group");
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => within(g).getByTestId("move-header").textContent)).toEqual([expect.stringContaining("2 changes"), expect.stringContaining("2 changes")]);
    expect(within(groups[0]).getByTestId("card-origin").textContent).toMatch(/^From your Oct \d+ chat$/);
    expect(within(groups[1]).queryByTestId("card-origin")).toBeNull();
  });
});
