// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const calls: Array<{ path: string; method?: string; body?: string }> = [];
let replies: Record<string, { status: number; body: unknown }> = {};
type FetchImpl = (path: string, opts?: { method?: string; body?: string }) => Promise<Response>;
let fetchImpl: FetchImpl | null = null;
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts?: { method?: string; body?: string }) => {
    if (fetchImpl) return fetchImpl(path, opts);
    calls.push({ path, method: opts?.method, body: opts?.body });
    const r = replies[`${opts?.method ?? "GET"} ${path}`] ?? { status: 404, body: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as unknown as Response;
  },
}));

import { AdBudgetSection, dateTimeLabel, holdsLine, monthPlan, parseAmount, planLine, stoppedNotice, type AdBudget } from "./AdBudgetSection";

const ID = "aaaaaaaa-0000-0000-0000-000000000001";
const active: AdBudget = {
  id: ID,
  status: "active",
  monthly_usd: 25000,
  daily_limit_usd: null,
  started_on: "2026-08-14",
  month_cap_usd: 25000,
  spent_usd: 1250,
  held_usd: 3000,
  left_usd: 20750,
  month_start: "2026-09-01",
  next_month_start: "2026-10-01",
  days_left: 5,
  days_in_month: 30,
  stopped_at: null,
  still_running: [],
};
const snap = (over: Record<string, unknown> = {}) => ({ budget: null, can_manage: true, pro: true, ...over });

beforeEach(() => {
  calls.length = 0;
  replies = {};
  fetchImpl = null;
});
afterEach(cleanup);

const text = () => (screen.getByLabelText("Ad budget").textContent ?? "").replace(/\s+/g, " ").trim();

describe("card states", () => {
  it("renders nothing but a loading bar until the read answers, then the state", async () => {
    replies["GET /api/workspace/ad-budget"] = { status: 200, body: snap() };
    render(<AdBudgetSection />);
    expect(screen.getByLabelText("Loading the ad budget")).toBeTruthy();
    expect(screen.queryByText(/Ad budget:/)).toBeNull();
    await screen.findByText("Ad budget: none");
  });

  it("carries the #ad-budget anchor the budget emails link to, loading, failed and loaded, and scrolls to it", async () => {
    window.history.replaceState(null, "", "/workspace?tab=growth-strategy#ad-budget");
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      replies["GET /api/workspace/ad-budget"] = { status: 200, body: snap() };
      render(<AdBudgetSection />);
      expect(document.getElementById("ad-budget")?.getAttribute("aria-label")).toBe("Loading the ad budget");
      await screen.findByText("Ad budget: none");
      expect(document.getElementById("ad-budget")?.getAttribute("aria-label")).toBe("Ad budget");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      cleanup();

      replies["GET /api/workspace/ad-budget"] = { status: 500, body: {} };
      render(<AdBudgetSection />);
      await screen.findByText("Couldn't load the ad budget.");
      expect(document.getElementById("ad-budget")?.textContent).toBe("Couldn't load the ad budget.");
    } finally {
      Element.prototype.scrollIntoView = original;
      window.history.replaceState(null, "", "/");
    }
  });

  it("none (owner, Pro): 'Ad budget: none', Set up, and the ad-change ledger", () => {
    render(<AdBudgetSection initial={snap()} />);
    expect(text()).toBe("Ad budget: noneSet upSee ledger");
    expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
  });

  it("active: the monthly amount, running now; this month's spend and what is set aside; Edit / Stop / See ledger", () => {
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    expect(screen.getByText("Ad budget: $25,000 a month, running now")).toBeTruthy();
    expect(text()).toContain("September: $1,250 spent of $25,000. $3,000 set aside for budget Zavi added.");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "See ledger" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
    expect(text()).not.toMatch(/—|ends |end date/);
  });

  it("active with a daily limit, in its prorated first month", () => {
    render(
      <AdBudgetSection
        initial={snap({ budget: { ...active, monthly_usd: 3000, month_cap_usd: 1100, spent_usd: 0, held_usd: 0, daily_limit_usd: 150, started_on: "2026-09-20" } })}
      />,
    );
    expect(screen.getByText("Ad budget: $3,000 a month, running now, up to $150 a day")).toBeTruthy();
    expect(text()).toContain("September: $0 spent of $1,100 (prorated, 5 days left). Full $3,000 from 1 Oct.");
  });

  it("stopped: the status and Set up a new budget", () => {
    render(<AdBudgetSection initial={snap({ budget: { ...active, status: "stopped", stopped_at: "2026-09-27T10:00:00Z" } })} />);
    expect(screen.getByText("Ad budget: stopped")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up a new budget" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("stopped with an object that could not be paused: says so and offers Stop again", () => {
    render(
      <AdBudgetSection
        initial={snap({ budget: { ...active, status: "stopped", still_running: [{ platform: "google", object_id: "555" }] } })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Still holding money: Google campaign 555");
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up a new budget" })).toBeNull();
  });

  it("non-Pro: says why, and no Set up", () => {
    render(<AdBudgetSection initial={snap({ pro: false })} />);
    expect(screen.getByText("Ad budgets are on the Pro plan.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  });

  it("member: read-only, the ledger is still visible", () => {
    render(<AdBudgetSection initial={snap({ can_manage: false, budget: active })} />);
    expect(screen.getByText("Only owners and admins can change the ad budget.")).toBeTruthy();
    for (const name of ["Stop", "Edit", "Set up"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.getByRole("button", { name: "See ledger" })).toBeTruthy();
  });

  it("the read failing says so instead of guessing a state", async () => {
    replies["GET /api/workspace/ad-budget"] = { status: 503, body: {} };
    render(<AdBudgetSection />);
    await screen.findByText("Couldn't load the ad budget.");
  });
});

describe("actions", () => {
  it("must-catch: Stop names each LinkedIn campaign by name with its own reason, never as a Google campaign or its internal id", async () => {
    const binding = "c1000000-0000-4000-8000-0000000000aa";
    replies[`POST /api/workspace/ad-budget/${ID}/stop`] = {
      status: 200,
      body: {
        status: "stopped",
        paused: [],
        failed: [
          { platform: "linkedin", object_id: binding, label: 'LinkedIn campaign "Spring launch"', reason: "A change to this ad was still being sent when you stopped. Press Stop again in a minute to make sure it is paused." },
          { platform: "linkedin", object_id: "c1000000-0000-4000-8000-0000000000bb", label: 'LinkedIn campaign "Webinar"', reason: "It runs on Zavi's shared ads account, so Zavi pauses it for you. Press Stop again in a minute." },
        ],
        partial: true,
      },
    };
    replies["GET /api/workspace/ad-budget"] = {
      status: 200,
      body: snap({ budget: { ...active, status: "stopped", still_running: [{ platform: "linkedin", object_id: binding, label: 'LinkedIn campaign "Spring launch"' }] } }),
    };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, stop" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain('LinkedIn campaign "Spring launch": A change to this ad was still being sent when you stopped. Press Stop again in a minute'));
    const notice = screen.getByRole("status").textContent ?? "";
    expect(notice).toContain(`LinkedIn campaign "Webinar": It runs on Zavi's shared ads account`);
    expect(notice).not.toMatch(/Google|c1000000|ad platform/);
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain('Still holding money: LinkedIn campaign "Spring launch"');
    expect(alert).not.toMatch(/Google|c1000000|in the ad platform/);
  });

  it("Stop asks first, then reports a partial stop honestly", async () => {
    replies[`POST /api/workspace/ad-budget/${ID}/stop`] = {
      status: 200,
      body: { status: "stopped", paused: [{ platform: "meta", object_id: "a1" }], failed: [{ platform: "google", object_id: "555" }], partial: true },
    };
    replies["GET /api/workspace/ad-budget"] = {
      status: 200,
      body: snap({ budget: { ...active, status: "stopped", still_running: [{ platform: "google", object_id: "555" }] } }),
    };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(calls).toEqual([]);
    expect(screen.getByText(/pauses every ad it turned on/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, stop" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("This could not be paused yet and still holds money. Google campaign 555: Pause it in the ad platform, or press Stop again."));
    expect(calls[0]).toMatchObject({ path: `/api/workspace/ad-budget/${ID}/stop`, method: "POST" });
    expect(screen.getByText("Ad budget: stopped")).toBeTruthy();
  });

  it("Set up asks for $ per month (no end date), previews this month, and shows the server's refusal as-is", async () => {
    replies["POST /api/workspace/ad-budget"] = { status: 403, body: { error: { message: "Ad budgets are on the Pro plan." } } };
    render(<AdBudgetSection initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(screen.queryByLabelText("End date")).toBeNull();
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "500" } });
    const today = new Date().toISOString().slice(0, 10);
    expect(text()).toContain(planLine(500, today, today));
    fireEvent.click(screen.getByRole("button", { name: "Set up budget" }));
    await screen.findByText("Ad budgets are on the Pro plan.");
    expect(JSON.parse(calls[0].body!)).toEqual({ monthly_usd: 500, daily_limit_usd: null });
  });

  it("a daily limit above the monthly amount is caught before any call", () => {
    render(<AdBudgetSection initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Daily limit (USD, optional)"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up budget" }));
    expect(screen.getByRole("alert").textContent).toBe("The daily limit can't be more than the monthly amount.");
    expect(calls).toEqual([]);
  });

  it("Edit sends the new monthly amount and shows the refusal with its numbers", async () => {
    const msg =
      "That would make this month's budget $1,000, but $4,250 is already spent or set aside for ads running until the end of the month. Pick an amount that leaves at least $4,250 this month, or pause some ads first.";
    replies[`PATCH /api/workspace/ad-budget/${ID}`] = { status: 409, body: { error: { code: "below_used", message: msg } } };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("$ per month") as HTMLInputElement).value).toBe("25000");
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(msg);
    expect(calls[0]).toMatchObject({ path: `/api/workspace/ad-budget/${ID}`, method: "PATCH" });
    expect(JSON.parse(calls[0].body!)).toEqual({ monthly_usd: 1000, daily_limit_usd: null });
  });

  it("See ledger opens inline with the rows and who did each", async () => {
    replies["GET /api/workspace/ad-budget/ledger"] = {
      status: 200,
      body: {
        rows: [
          { at: "2026-09-26T15:00:00Z", kind: "hand", date: "2026-09-26", action: "Logged by hand: Raised in Ads Manager", amount_usd: 40, amount_label: "$40.00 (logged by hand)", result: "Logged", source: "person", by: "You" },
          { at: "2026-09-26T12:00:00Z", kind: "hold", date: null, action: "Created Google campaign 555 at $10.00 a day", amount_usd: 62.5, amount_label: "$62.50 set aside", result: "Held", source: "cgo", by: "Autopilot" },
          { at: "2026-09-26T10:00:00Z", kind: "event", date: null, action: "Budget set up: $3,000.00 a month", amount_usd: null, amount_label: null, result: "Set up", source: "person", by: "A teammate" },
        ],
      },
    };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "See ledger" }));
    const table = within(await screen.findByRole("table"));
    table.getByText("Created Google campaign 555 at $10.00 a day");
    expect(table.getByText("Autopilot")).toBeTruthy();
    expect(table.getByText("You")).toBeTruthy();
    expect(table.getByText("A teammate")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log a human action" })).toBeTruthy();

    const headers = table.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["When", "Action", "Amount", "Result", "By"]);
    const cells = (i: number) => table.getAllByRole("row")[i + 1].querySelectorAll("td");
    expect(cells(0)[2].textContent).toBe("$40.00 (logged by hand)");
    expect(cells(1)[2].textContent).toBe("$62.50 set aside");
    expect(cells(2)[2].textContent).toBe("");

    expect(cells(0)[0].textContent).toBe("Sep 26, 2026");
    expect(cells(1)[0].textContent).toBe(dateTimeLabel("2026-09-26T12:00:00Z"));
    expect(cells(1)[0].textContent).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    expect(cells(2)[0].textContent).toBe(dateTimeLabel("2026-09-26T10:00:00Z"));
    expect(screen.getByLabelText("Ad budget ledger").textContent).not.toMatch(/—/);
  });

  it("at phone width each row is a card with every field; the table is for wider screens", async () => {
    replies["GET /api/workspace/ad-budget/ledger"] = {
      status: 200,
      body: {
        rows: [
          { at: "2026-09-27T10:00:00Z", kind: "event", date: null, action: "Budget stopped ($2,400.00 a month)", amount_usd: null, amount_label: null, result: "Stopped", source: "person", by: "You" },
          { at: "2026-09-26T12:00:00Z", kind: "hold", date: null, action: 'Created Meta ad set "Spring promo" at $10.00 a day', amount_usd: 62.5, amount_label: "$62.50 set aside", result: "Changed", source: "cgo", by: "Autopilot" },
        ],
      },
    };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "See ledger" }));
    const list = await screen.findByRole("list", { name: "Ledger rows" });
    expect(list.className).toContain("sm:hidden");
    expect(screen.getByRole("table").parentElement!.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByRole("table").parentElement!.className).toContain("sm:block");
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    const pairs = (li: HTMLElement) =>
      Array.from(li.querySelectorAll("dt")).map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`);
    expect(cards[0].querySelector("p")!.textContent).toBe("Budget stopped ($2,400.00 a month)");
    expect(pairs(cards[0])).toEqual([`When: ${dateTimeLabel("2026-09-27T10:00:00Z")}`, "Result: Stopped", "By: You"]);
    expect(pairs(cards[1])).toEqual([
      `When: ${dateTimeLabel("2026-09-26T12:00:00Z")}`,
      "Amount: $62.50 set aside",
      "Result: Changed",
      "By: Autopilot",
    ]);
    expect(list.className).not.toMatch(/overflow-x/);
  });

  it("a long unbroken note or ad name wraps instead of pushing the phone layout sideways", async () => {
    const long = `Logged by hand: ${"x".repeat(300)}`;
    replies["GET /api/workspace/ad-budget/ledger"] = {
      status: 200,
      body: { rows: [{ at: "2026-09-27T10:00:00Z", kind: "hand", date: "2026-09-27", action: long, amount_usd: null, amount_label: null, result: "Logged", source: "person", by: "You" }] },
    };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "See ledger" }));
    const list = await screen.findByRole("list", { name: "Ledger rows" });
    const action = within(list).getByText(long);
    expect(action.className).toContain("break-words");
    expect(action.className).toContain("[overflow-wrap:anywhere]");
    const cell = within(screen.getByRole("table")).getByText(long);
    expect(cell.className).toContain("[overflow-wrap:anywhere]");
  });

  it.each([
    ["0.005", "The monthly budget must be at least $1."],
    ["0", "The monthly budget must be at least $1."],
    ["10000000", "The monthly budget must be less than $10,000,000."],
    ["9999999.999", "The monthly budget must be less than $10,000,000."],
    ["1e12", "Enter a monthly amount in dollars."],
    ["1e3", "Enter a monthly amount in dollars."],
    ["3,00", "Enter a monthly amount in dollars."],
    ["0x10", "Enter a monthly amount in dollars."],
    ["10,000,000", "The monthly budget must be less than $10,000,000."],
  ])("monthly %s: the message shows as typed, never a preview, and nothing is sent", (value, message) => {
    render(<AdBudgetSection initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value } });
    expect(text()).toContain(message);
    expect(text()).not.toMatch(/This month:/);
    fireEvent.click(screen.getByRole("button", { name: "Set up budget" }));
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(calls).toEqual([]);
  });

  it("a daily limit under $1 is refused before any call", () => {
    render(<AdBudgetSection initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Daily limit (USD, optional)"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up budget" }));
    expect(screen.getByRole("alert").textContent).toBe("The daily limit must be at least $1, or left empty.");
    expect(calls).toEqual([]);
  });
});

describe("the first-month proration, in plain words", () => {
  it("Ravi's example: $3,000 set up on Oct 21 (11 of 31 days) is $1,064.51 this month", () => {
    expect(monthPlan(3000, "2026-10-21", "2026-10-21")).toMatchObject({ cap: 1064.51, daysLeft: 11, daysInMonth: 31, next: "2026-11-01" });
    expect(planLine(3000, "2026-10-21", "2026-10-21")).toBe("This month: $1,064.51 (11 of 31 days left). From 1 Nov: $3,000/month.");
  });
  it("a 30-day month: $3,000 set up on Sep 20 is $1,100 (11 of 30 days left)", () => {
    expect(planLine(3000, "2026-09-20", "2026-09-20")).toBe("This month: $1,100 (11 of 30 days left). From 1 Oct: $3,000/month.");
  });
  it("rounds DOWN to the cent, like the server", () => {
    expect(monthPlan(1000, "2026-10-31", "2026-10-31").cap).toBe(32.25);
  });
  it("on the 1st, or editing a budget that started in an earlier month, the full amount applies", () => {
    expect(planLine(3000, "2026-10-01", "2026-10-01")).toBe("This month: $3,000. From 1 Nov: $3,000/month.");
    expect(planLine(2000, "2026-08-14", "2026-10-21")).toBe("This month: $2,000. From 1 Nov: $2,000/month.");
  });
  it("editing in the month it started keeps the same proration", () => {
    expect(planLine(1800, "2026-09-20", "2026-09-25")).toBe("This month: $660 (11 of 30 days left). From 1 Oct: $1,800/month.");
  });
  it("no em-dashes; December rolls to 1 Jan", () => {
    expect(planLine(3000, "2026-12-31", "2026-12-31")).toBe("This month: $96.77 (1 of 31 days left). From 1 Jan: $3,000/month.");
    expect(planLine(3000, "2026-12-31", "2026-12-31")).not.toMatch(/—/);
  });
});

describe("amounts as founders type them", () => {
  it.each([
    ["3000", 3000],
    ["3,000", 3000],
    ["3,000.50", 3000.5],
    ["$3,000", 3000],
    [" 1,234,567.8 ", 1234567.8],
    [".5", 0.5],
  ])("%s reads as %s", (raw, n) => {
    expect(parseAmount(raw)).toBe(n);
  });
  it.each(["1e12", "1E3", "3,00", "30,00.5", "0x10", "Infinity", "-5", "", ".", "12abc", "1,2345"])("%s is not a plain amount", (raw) => {
    expect(Number.isNaN(parseAmount(raw))).toBe(true);
  });

  it("3,000 previews this month and is sent as 3000", async () => {
    replies["POST /api/workspace/ad-budget"] = { status: 403, body: { error: { message: "Ad budgets are on the Pro plan." } } };
    render(<AdBudgetSection initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "3,000.50" } });
    const today = new Date().toISOString().slice(0, 10);
    expect(text()).toContain(planLine(3000.5, today, today));
    fireEvent.click(screen.getByRole("button", { name: "Set up budget" }));
    await screen.findByText("Ad budgets are on the Pro plan.");
    expect(JSON.parse(calls[0].body!)).toEqual({ monthly_usd: 3000.5, daily_limit_usd: null });
  });
});

describe("messages clear as soon as the input is fixed", () => {
  it("a refused amount's message goes away once the amount is valid", () => {
    render(<AdBudgetSection initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up budget" }));
    expect(screen.getByRole("alert").textContent).toBe("The monthly budget must be at least $1.");
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "3,000" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(text()).not.toContain("must be at least $1");
  });

  it("a daily limit over the monthly amount updates live, then clears", () => {
    render(<AdBudgetSection initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Daily limit (USD, optional)"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up budget" }));
    expect(screen.getByRole("alert").textContent).toBe("The daily limit can't be more than the monthly amount.");
    fireEvent.change(screen.getByLabelText("Daily limit (USD, optional)"), { target: { value: "0.5" } });
    expect(screen.getByRole("alert").textContent).toBe("The daily limit must be at least $1, or left empty.");
    fireEvent.change(screen.getByLabelText("Daily limit (USD, optional)"), { target: { value: "50" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("the server's refusal clears when the founder edits the amount", async () => {
    replies[`PATCH /api/workspace/ad-budget/${ID}`] = { status: 409, body: { error: { message: "Pick a higher amount." } } };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Pick a higher amount.");
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "30000" } });
    expect(screen.queryByText("Pick a higher amount.")).toBeNull();
  });
});

describe("one click, one request", () => {
  it.each([
    ["Set up budget", "Set up", "POST /api/workspace/ad-budget"],
    ["Save changes", "Edit", `PATCH /api/workspace/ad-budget/${ID}`],
  ])("%s is disabled while its request is in flight, and a double click sends once", async (submit, open) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchImpl = (async (path: string, opts?: { method?: string; body?: string }) => {
      calls.push({ path, method: opts?.method, body: opts?.body });
      if (opts?.method) await gate;
      return { ok: false, status: 409, json: async () => ({ error: { message: "No." } }) } as unknown as Response;
    }) as FetchImpl;
    render(<AdBudgetSection initial={snap(open === "Edit" ? { budget: active } : {})} />);
    fireEvent.click(screen.getByRole("button", { name: open }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "30000" } });
    const btn = screen.getByRole("button", { name: submit });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true));
    await act(async () => release());
    await screen.findByText("No.");
    expect(calls.filter((c) => c.method)).toHaveLength(1);
  });

  it("Yes, stop is disabled while stopping, and a double click stops once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchImpl = (async (path: string, opts?: { method?: string; body?: string }) => {
      calls.push({ path, method: opts?.method, body: opts?.body });
      if (opts?.method === "POST") {
        await gate;
        return { ok: true, status: 200, json: async () => ({ status: "stopped", paused: [], failed: [] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => snap({ budget: { ...active, status: "stopped" } }) } as unknown as Response;
    }) as FetchImpl;
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const btn = screen.getByRole("button", { name: "Yes, stop" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect((screen.getByRole("button", { name: "Stopping…" }) as HTMLButtonElement).disabled).toBe(true));
    await act(async () => release());
    await screen.findByText("Stopped. No ads were running.");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("Log it is disabled while saving, and a double click logs once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fetchImpl = (async (path: string, opts?: { method?: string; body?: string }) => {
      calls.push({ path, method: opts?.method, body: opts?.body });
      if (opts?.method === "POST") {
        await gate;
        return { ok: false, status: 400, json: async () => ({ error: { message: "No." } }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ rows: [] }) } as unknown as Response;
    }) as FetchImpl;
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "See ledger" }));
    fireEvent.click(await screen.findByRole("button", { name: "Log a human action" }));
    fireEvent.change(screen.getByLabelText("What you changed"), { target: { value: "Raised it" } });
    const btn = screen.getByRole("button", { name: "Log it" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true));
    await act(async () => release());
    await screen.findByText("No.");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("What you changed"), { target: { value: "Raised it to $80" } });
    expect(screen.queryByText("No.")).toBeNull();
  });
});

describe("Stop, in founder words", () => {
  it("says what happened: no ads running, one ad, several ads", () => {
    expect(stoppedNotice(0)).toBe("Stopped. No ads were running.");
    expect(stoppedNotice(1)).toBe("Stopped. 1 ad paused.");
    expect(stoppedNotice(3)).toBe("Stopped. 3 ads paused.");
  });
  it("the confirmation talks about Autopilot and ad spend, not the CGO", () => {
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(text()).toContain("Stop the ad budget? This pauses every ad it turned on, and Autopilot will ask you before any ad spend again.");
    expect(text()).not.toMatch(/CGO/);
  });
});

describe("the ad-change ledger (S7)", () => {
  const CH = "cccccccc-0000-0000-0000-000000000001";
  const rows = [
    { at: "2026-09-28T10:00:00Z", kind: "outside", date: null, action: 'Turned on Meta ad set "40% to Turo" (was off), outside Zavi', amount_usd: null, amount_label: null, result: "Seen in the ad account", source: "outside", by: "Outside Zavi", undo: null },
    { at: "2026-09-28T08:25:00Z", kind: "change", date: null, action: 'Paused Meta ad set "Awareness" (was on)', amount_usd: 19, amount_label: "about $19.00/day freed", result: "Done", source: "cgo", by: "Autopilot", undo: { change_id: CH, change: 'Turn on Meta ad set "Awareness" again' } },
    { at: "2026-09-28T07:00:00Z", kind: "change", date: null, action: 'Paused Google campaign "Search"', amount_usd: null, amount_label: "amount unknown", result: "Done", source: "person", by: "A teammate", undo: null },
  ];

  it("shows every change with who did it and its $ effect; Undo only where the server offers one", async () => {
    replies["GET /api/workspace/ad-budget/ledger"] = { status: 200, body: { rows } };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "See ledger" }));
    const table = within(await screen.findByRole("table"));
    expect(table.getByText("Outside Zavi")).toBeTruthy();
    expect(table.getByText("about $19.00/day freed")).toBeTruthy();
    expect(table.getByText("amount unknown")).toBeTruthy();
    expect(table.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });

  it("Undo shows the exact change first; Approve stages it and approves it through the normal approval", async () => {
    replies["GET /api/workspace/ad-budget/ledger"] = { status: 200, body: { rows } };
    replies[`POST /api/workspace/ad-budget/changes/${CH}/undo`] = { status: 201, body: { decision_id: "dec-9", change: 'Turn on Meta ad set "Awareness" again' } };
    replies["POST /api/approvals/dec-9/approve"] = { status: 200, body: { ok: true } };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "See ledger" }));
    const table = within(await screen.findByRole("table"));
    fireEvent.click(table.getByRole("button", { name: "Undo" }));
    const confirm = screen.getByRole("group", { name: "Confirm undo" });
    expect(confirm.textContent).toContain('Undo: Turn on Meta ad set "Awareness" again.');
    expect(confirm.textContent).toContain("counts against your ad budget");
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Approve undo" }));
    await screen.findByText("Undo approved. It shows in the ledger once it has gone through.");
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      `/api/workspace/ad-budget/changes/${CH}/undo`,
      "/api/approvals/dec-9/approve",
    ]);
  });

  it("a refused undo says why and approves nothing; Cancel sends nothing", async () => {
    replies["GET /api/workspace/ad-budget/ledger"] = { status: 200, body: { rows } };
    replies[`POST /api/workspace/ad-budget/changes/${CH}/undo`] = { status: 409, body: { error: { message: "This ad changed again since. Undo the newest change instead." } } };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "See ledger" }));
    const table = within(await screen.findByRole("table"));
    fireEvent.click(table.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm undo" })).toBeNull();
    fireEvent.click(table.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve undo" }));
    await screen.findByText("This ad changed again since. Undo the newest change instead.");
    expect(calls.some((c) => c.path.startsWith("/api/approvals/"))).toBe(false);
  });

  it("a member sees the changes but no Undo; a tenant with no budget still sees its ledger", async () => {
    replies["GET /api/workspace/ad-budget/ledger"] = { status: 200, body: { rows } };
    render(<AdBudgetSection initial={snap({ can_manage: false })} />);
    fireEvent.click(screen.getByRole("button", { name: "See ledger" }));
    const table = within(await screen.findByRole("table"));
    expect(table.getByText('Paused Meta ad set "Awareness" (was on)')).toBeTruthy();
    expect(table.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Log a human action" })).toBeNull();
  });
});

describe("held raises line (cgo-log 2026-10-23, decision i)", () => {
  it("names each held raise with both amounts and the reason, and is absent when none", () => {
    expect(holdsLine([])).toBeNull();
    expect(
      holdsLine([
        { name: "Host Recommended Areas", from_usd: 140, to_usd: 168, words: "you set it Oct 12" },
        { name: "Rent a car at $35 per day", from_usd: 149, to_usd: 178.8, words: "test until Oct 28" },
      ]),
    ).toBe("Holding 2 raises: Host Recommended Areas $140 → $168 (you set it Oct 12) · Rent a car at $35 per day $149 → $178.80 (test until Oct 28)");
    expect(holdsLine([{ name: null, from_usd: null, to_usd: null, words: "you set it yourself" }])).toBe("Holding 1 raise: an ad (you set it yourself)");
  });

  it("the Growth story shows the line under the month line; a failed read says so instead of looking like none", async () => {
    replies["GET /api/workspace/growth/ad-holds"] = { status: 200, body: { holds: [{ name: "Host Recommended Areas", from_usd: 140, to_usd: 168, words: "you set it Oct 12" }] } };
    render(<AdBudgetSection variant="story" initial={snap({ budget: active }) as never} />);
    await screen.findByText("Holding 1 raise: Host Recommended Areas $140 → $168 (you set it Oct 12)");
    cleanup();
    replies["GET /api/workspace/growth/ad-holds"] = { status: 500, body: {} };
    render(<AdBudgetSection variant="story" initial={snap({ budget: active }) as never} />);
    await screen.findByText("Held raises couldn't be loaded right now.");
    expect(screen.queryByText(/Holding/)).toBeNull();
  });
});

describe("after a save, the saved budget shows at once (QA flow 12/28)", () => {
  const slowReads = () => {
    const gets: string[] = [];
    fetchImpl = (async (path: string, opts?: { method?: string; body?: string }) => {
      calls.push({ path, method: opts?.method, body: opts?.body });
      if (!opts?.method) {
        gets.push(path);
        return new Promise<Response>(() => {});
      }
      const r = replies[`${opts.method} ${path}`] ?? { status: 404, body: {} };
      return { ok: r.status < 400, status: r.status, json: async () => r.body } as unknown as Response;
    }) as FetchImpl;
    return gets;
  };

  it("Set up budget: the block shows the new budget while the re-read is still hanging, and tells the page", async () => {
    const gets = slowReads();
    replies["POST /api/workspace/ad-budget"] = { status: 201, body: { budget_id: "new-1", month_cap_usd: 10 } };
    const onChanged = vi.fn();
    render(<AdBudgetSection variant="story" initial={snap() as never} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "155" } });
    fireEvent.click(screen.getByRole("button", { name: "Set up budget" }));
    await screen.findByText("Ads: $155 a month");
    expect(screen.queryByText("Ads: no budget set")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(text()).toContain("$0 spent of $10");
    expect(gets).toContain("/api/workspace/ad-budget");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("Save changes: the new amount and this month's cap from the server show while the re-read hangs", async () => {
    slowReads();
    replies[`PATCH /api/workspace/ad-budget/${ID}`] = { status: 200, body: { ok: true, month_cap_usd: 30000 } };
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "30000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Ad budget: $30,000 a month, running now");
    expect(text()).toContain("$1,250 spent of $30,000");
  });
});

describe("server answers that must not shrink the month", () => {
  it("a saved cap of 0 from the server is treated as missing, so the month keeps its planned cap", async () => {
    fetchImpl = (async (path: string, opts?: { method?: string; body?: string }) => {
      calls.push({ path, method: opts?.method, body: opts?.body });
      if (!opts?.method) return new Promise<Response>(() => {});
      return { ok: true, status: 200, json: async () => ({ ok: true, month_cap_usd: 0 }) } as unknown as Response;
    }) as FetchImpl;
    render(<AdBudgetSection initial={snap({ budget: active })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "30000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Ad budget: $30,000 a month, running now");
    expect(text()).toContain("$1,250 spent of $30,000");
    expect(text()).not.toContain("of $0");
  });

  it("re-syncs to a newer budget the page read after a save made elsewhere, without a read of its own", async () => {
    const { rerender } = render(<AdBudgetSection initial={snap({ budget: active })} />);
    expect(text()).toContain("$25,000 a month");
    rerender(<AdBudgetSection initial={snap({ budget: { ...active, monthly_usd: 30000, month_cap_usd: 30000, left_usd: 25750 } })} />);
    await screen.findByText("Ad budget: $30,000 a month, running now");
    expect(text()).toContain("$1,250 spent of $30,000");
    expect(calls.filter((c) => !c.method && c.path === "/api/workspace/ad-budget")).toHaveLength(0);
  });
});

describe("budget form polish", () => {
  it("the prorated line sits right under the amount, and the ChatGPT note shows only once a daily limit is typed", () => {
    render(<AdBudgetSection initial={snap()} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(screen.queryByText(/ChatGPT Ads/)).toBeNull();
    fireEvent.change(screen.getByLabelText("$ per month"), { target: { value: "155" } });
    const today = new Date().toISOString().slice(0, 10);
    const line = screen.getByTestId("budget-plan-line");
    expect(line.textContent).toBe(planLine(155, today, today));
    expect(line.previousElementSibling?.contains(screen.getByLabelText("$ per month"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Daily limit (USD, optional)"), { target: { value: "25" } });
    expect(screen.getByText(/ChatGPT Ads sets aside twice it/)).toBeTruthy();
  });

  it("a failed held-raises read is a quiet secondary note", async () => {
    replies["GET /api/workspace/growth/ad-holds"] = { status: 500, body: {} };
    render(<AdBudgetSection variant="story" initial={snap({ budget: active }) as never} />);
    const note = await screen.findByText("Held raises couldn't be loaded right now.");
    expect(note.className).toContain("text-inkMuted");
  });
});
