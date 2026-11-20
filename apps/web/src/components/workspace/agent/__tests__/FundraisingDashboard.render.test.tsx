// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type {
  FundraisingInvestor,
  InvestorDossier,
} from "../fundraising-dashboard-util";

const mockState = vi.hoisted(() => ({ current: null as unknown }));
const apiCalls = vi.hoisted(() => ({ list: [] as Array<[string, unknown]> }));
const apiBehavior = vi.hoisted(() => ({
  ok: true,
  runStatus: "running" as string,
}));

vi.mock("../dashboard-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dashboard-ui")>();
  return {
    ...actual,
    useAgentDashboard: () => ({
      data: mockState.current,
      loading: false,
      refreshing: false,
      error: null,
      refresh: () => {},
      newRowIds: new Set<string>(),
    }),
  };
});

vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, init?: { body?: string }) => {
    apiCalls.list.push([path, init?.body ? JSON.parse(init.body) : undefined]);
    return {
      ok: apiBehavior.ok,
      status: apiBehavior.ok ? 200 : 500,
      json: async () => ({
        run_id: "run-deep-1",
        run: { id: "run-deep-1", status: apiBehavior.runStatus },
        queue_position: null,
        queue_ahead: null,
      }),
    };
  },
}));

vi.mock("../../InlineStatusRow", () => ({
  InlineStatusRow: () => <div data-testid="inline-status" />,
}));

vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({
    send: async () => ({
      kind: "queued",
      thread_id: "t",
      user_message_id: "m",
      run_id: "run-refine-1",
    }),
  }),
}));

import { FundraisingDashboard } from "../FundraisingDashboard";

const dossier = (over: Record<string, unknown> = {}) => ({
  who_they_are: "Dana has been a partner since 2019.",
  why_this_company: "Hosts keep 90%+ where the incumbent pays less.",
  how_to_reach: { warm_path: "A warm path exists." },
  draft_message: "Subject: 90% host payout",
  pushbacks: [
    { objection: "Why won't the incumbent match it?", honest_answer: "Margin." },
  ],
  sources: [{ url: "acme.vc/team", claim: "Partner list" }],
  ...over,
});

const inv = (over: Partial<FundraisingInvestor> = {}): FundraisingInvestor => {
  const firm = over.firm ?? "Acme Ventures";
  const name = over.name ?? "Dana Lee";
  return {
    firm,
    name,
    tier: 1,
    fit_rationale: "Marketplace thesis.",
    source: "web",
    source_url: "https://acme.vc",
    review_key: `${firm}|${name}`,
    ...over,
  };
};

function mount(
  investors: FundraisingInvestor[],
  extra: Record<string, unknown> = {},
) {
  mockState.current = {
    generic: false,
    latest: {
      run_id: "run-x",
      generated_at: "2026-07-29T00:00:00Z",
      investors,
    },
    coverage: { total: investors.length },
    ...extra,
  };
  return render(<FundraisingDashboard />);
}

import realPayload from "./real-prod-payload.fixture.json";

describe("REAL prod payload (129 investors, tenant upcar-ai)", () => {
  function mountReal() {
    mockState.current = realPayload as unknown;
    return render(<FundraisingDashboard />);
  }

  it("renders the real 129-investor list without throwing", () => {
    mountReal();
    const investors = (realPayload as any).latest.investors as Array<any>;
    expect(investors.length).toBe(129);
    const firstT1 = investors.find((i) => i.tier === 1);
    expect(firstT1).toBeTruthy();
    expect(screen.getAllByText(firstT1.firm || firstT1.name).length).toBeGreaterThan(0);
  });

  it("does NOT dump all 129 rows at once (a 129-row wall is the bug)", () => {
    const { container } = mountReal();
    const cards = container.querySelectorAll('[role="button"]');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(129);
  });

  it("clicking a real investor opens their read view", () => {
    const { container } = mountReal();
    const first = container.querySelector('[role="button"]') as HTMLElement;
    expect(first).toBeTruthy();
    fireEvent.click(first);
    expect(screen.getAllByText(/back/i).length).toBeGreaterThan(0);
  });

  it("surfaces the real no-named-partner gap rather than hiding it", () => {
    mountReal();
    const investors = (realPayload as any).latest.investors as Array<any>;
    const noPerson = investors.filter((i) => !i.name || !String(i.name).trim());
    expect(noPerson.length).toBeGreaterThan(10);
    expect(document.body.textContent || "").toMatch(/no named partner|no partner/i);
  });
});

beforeEach(() => {
  apiCalls.list = [];
  apiBehavior.ok = true;
  apiBehavior.runStatus = "running";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("clicking an investor opens their read view", () => {
  it("opens the clicked investor, and only that one", () => {
    mount([
      inv({ firm: "Acme Ventures", name: "Dana Lee", dossier: dossier() }),
      inv({ firm: "Beta Fund", name: "Sam Roy", tier: 2 }),
    ]);

    expect(screen.getByText("Tier 1: strong fit")).toBeTruthy();
    expect(screen.getByText("Beta Fund")).toBeTruthy();

    fireEvent.click(screen.getByText("Acme Ventures"));

    expect(screen.getByText("Who they are")).toBeTruthy();
    expect(screen.getByText("Dana has been a partner since 2019.")).toBeTruthy();
    expect(screen.queryByText("Tier 1: strong fit")).toBeNull();
    expect(screen.queryByText("Beta Fund")).toBeNull();
  });

  it("opens on keyboard Enter too — the card is a real target", () => {
    mount([inv({ firm: "Acme Ventures", dossier: dossier() })]);
    const card = screen.getByText("Acme Ventures").closest('[role="button"]');
    expect(card).toBeTruthy();
    fireEvent.keyDown(card as Element, { key: "Enter" });
    expect(screen.getByText("Who they are")).toBeTruthy();
  });

  it("back returns to the list", () => {
    mount([inv({ firm: "Acme Ventures", dossier: dossier() })]);
    fireEvent.click(screen.getByText("Acme Ventures"));
    fireEvent.click(screen.getByText("Back to the list"));
    expect(screen.getByText("Tier 1: strong fit")).toBeTruthy();
  });

  it("an un-researched investor's read view offers the deep round, not a dossier", () => {
    mount([inv({ firm: "Maniv Mobility", name: "" })]);
    fireEvent.click(screen.getByText("Maniv Mobility"));
    expect(screen.getByText("Deep round Maniv Mobility")).toBeTruthy();
    expect(screen.queryByText("Who they are")).toBeNull();
  });
});

describe("deep round", () => {
  it("the per-card button dispatches a deep run and does NOT open the read view", async () => {
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee" })]);

    fireEvent.click(screen.getByText("Deep round"));
    await vi.waitFor(() =>
      expect(
        apiCalls.list.some(([p]) => p === "/api/agents/fundraising/run"),
      ).toBe(true),
    );

    const [, body] = apiCalls.list.find(
      ([p]) => p === "/api/agents/fundraising/run",
    ) as [string, Record<string, unknown>];
    expect(body).toEqual({
      mode: "deep",
      deep: {
        firm: "Acme Ventures",
        name: "Dana Lee",
        identity_key: "Acme Ventures|Dana Lee",
        source_url: "https://acme.vc",
      },
    });

    expect(screen.getByText("Tier 1: strong fit")).toBeTruthy();
  });

  it("the next-step CTA queues several at once and each card shows it is running", async () => {
    mount([
      inv({ firm: "Firm 0", name: "P 0" }),
      inv({ firm: "Firm 1", name: "P 1" }),
      inv({ firm: "Firm 2", name: "P 2" }),
    ]);

    fireEvent.click(screen.getByText("Deep round these 3"));

    await vi.waitFor(() =>
      expect(screen.getAllByText("researching…").length).toBe(3),
    );
    expect(
      apiCalls.list.filter(([p]) => p === "/api/agents/fundraising/run").length,
    ).toBe(3);

    expect(screen.getByText("Researching 3 investors")).toBeTruthy();
  });
});

describe("a deep round survives until the RUN actually ends", () => {
  async function clickDeepRound() {
    vi.useFakeTimers();
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee" })]);
    fireEvent.click(screen.getByText("Deep round"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText("researching…")).toBeTruthy();
  }

  const runPolls = () =>
    apiCalls.list.filter(([p]) => p.startsWith("/api/agents/runs/")).length;
  const dispatches = () =>
    apiCalls.list.filter(([p]) => p === "/api/agents/fundraising/run").length;

  it("stays researching across many polls while the run is still running", async () => {
    await clickDeepRound();

    await vi.advanceTimersByTimeAsync(6 * 5000);

    expect(runPolls()).toBeGreaterThanOrEqual(5);
    expect(screen.getByText("researching…")).toBeTruthy();
    expect(screen.queryByText("Deep round")).toBeNull();
    expect(dispatches()).toBe(1);
  });

  it("a second click while one is in flight does not bill a second run", async () => {
    await clickDeepRound();
    await vi.advanceTimersByTimeAsync(2 * 5000);

    expect(dispatches()).toBe(1);
    expect(screen.queryByText("Deep round these 1")).toBeNull();
  });

  it("a run that ends non-success says so instead of restoring the button", async () => {
    await clickDeepRound();

    apiBehavior.runStatus = "parse_failed";
    await vi.advanceTimersByTimeAsync(5000);

    expect(screen.getByText("came back empty")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.queryByText("Deep round")).toBeNull();
    expect(screen.queryByText("researching…")).toBeNull();
  });

  it("a run that succeeds keeps saying researching until the dossier can land", async () => {
    await clickDeepRound();

    apiBehavior.runStatus = "success";
    await vi.advanceTimersByTimeAsync(5000);

    expect(screen.getByText("researching…")).toBeTruthy();
    expect(screen.queryByText("came back empty")).toBeNull();
  });

  it("a success whose dossier never arrives eventually says THAT, not nothing", async () => {
    await clickDeepRound();

    apiBehavior.runStatus = "success";
    await vi.advanceTimersByTimeAsync(6 * 5000);

    expect(screen.getByText("no dossier")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("a round whose status can never be read stops claiming progress", async () => {
    await clickDeepRound();
    apiBehavior.ok = false;

    await vi.advanceTimersByTimeAsync(20 * 5000);

    expect(screen.queryByText("researching…")).toBeNull();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("a brief unreadable blip does NOT end a run that is still going", async () => {
    await clickDeepRound();
    apiBehavior.ok = false;
    await vi.advanceTimersByTimeAsync(3 * 5000);
    apiBehavior.ok = true;
    await vi.advanceTimersByTimeAsync(5000);

    expect(screen.getByText("researching…")).toBeTruthy();
  });

  it("recovers a round the SERVER still has running after a reload", async () => {
    vi.useFakeTimers();
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee" })], {
      deep_in_flight: [
        { identity_key: "Acme Ventures|Dana Lee", run_id: "run-server-1" },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText("researching…")).toBeTruthy();
    expect(screen.queryByText("Deep round")).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      apiCalls.list.some(([p]) => p === "/api/agents/runs/run-server-1"),
    ).toBe(true);
    expect(
      apiCalls.list.some(([p]) => p === "/api/agents/fundraising/run"),
    ).toBe(false);
  });

  it("a payload with no deep_in_flight behaves exactly as before", async () => {
    vi.useFakeTimers();
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee" })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText("Deep round")).toBeTruthy();
  });

  it("a dispatch that never lands is reported, not swallowed", async () => {
    vi.useFakeTimers();
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee" })]);
    apiBehavior.ok = false;

    fireEvent.click(screen.getByText("Deep round"));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText("didn't start")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(runPolls()).toBe(0);
  });

  it("the read view names the firm and what happened to its round", async () => {
    vi.useFakeTimers();
    mount([inv({ firm: "Nexus Venture Partners", name: "" })]);

    fireEvent.click(screen.getByText("Nexus Venture Partners"));
    fireEvent.click(screen.getByText("Deep round Nexus Venture Partners"));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText("Researching Nexus Venture Partners…")).toBeTruthy();

    apiBehavior.runStatus = "parse_failed";
    await vi.advanceTimersByTimeAsync(5000);

    expect(
      screen.getByText(/deep round on Nexus Venture Partners finished/i),
    ).toBeTruthy();
    expect(screen.getByText("Try Nexus Venture Partners again")).toBeTruthy();
  });
});

describe("status is set from inside the read view", () => {
  it("marking replied POSTs the existing route and updates the chip immediately", async () => {
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee", dossier: dossier() })]);
    fireEvent.click(screen.getByText("Acme Ventures"));

    fireEvent.click(screen.getByText("mark replied"));

    await vi.waitFor(() =>
      expect(
        apiCalls.list.some(
          ([p]) => p === "/api/fundraising/outreach-replied",
        ),
      ).toBe(true),
    );
    const [, body] = apiCalls.list.find(
      ([p]) => p === "/api/fundraising/outreach-replied",
    ) as [string, Record<string, unknown>];
    expect(body).toEqual({
      investor_id: "Acme Ventures|Dana Lee",
      replied: true,
    });

    await vi.waitFor(() => expect(screen.getByText("replied")).toBeTruthy());
  });

  it("marking passed writes review-state removed", async () => {
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee", dossier: dossier() })]);
    fireEvent.click(screen.getByText("Acme Ventures"));
    fireEvent.click(screen.getByText("mark passed"));

    await vi.waitFor(() =>
      expect(
        apiCalls.list.some(([p]) => p === "/api/fundraising/review-state"),
      ).toBe(true),
    );
    const [, body] = apiCalls.list.find(
      ([p]) => p === "/api/fundraising/review-state",
    ) as [string, Record<string, unknown>];
    expect(body).toEqual({
      investor_id: "Acme Ventures|Dana Lee",
      state: "removed",
    });
  });

  it("marking reached out records a manual mark — it never sends", async () => {
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee", dossier: dossier() })]);
    fireEvent.click(screen.getByText("Acme Ventures"));
    fireEvent.click(screen.getByText("mark reached out"));
    fireEvent.click(screen.getByText("LinkedIn"));

    await vi.waitFor(() =>
      expect(
        apiCalls.list.some(([p]) => p === "/api/fundraising/outreach-sent"),
      ).toBe(true),
    );
    expect(apiCalls.list.every(([p]) => !p.includes("/send"))).toBe(true);
  });
});

function sentBodies() {
  return apiCalls.list
    .filter(([p]) => p === "/api/fundraising/outreach-sent")
    .map(([, b]) => b as Record<string, unknown>);
}

describe("the reached-out channel is never guessed", () => {
  it("uses the channel the dossier stated, without asking", async () => {
    mount([
      inv({
        firm: "Acme Ventures",
        name: "Dana Lee",
        dossier: dossier({ how_to_reach: { best_channel: "LinkedIn DM" } }),
      }),
    ]);
    fireEvent.click(screen.getByText("Acme Ventures"));

    fireEvent.click(screen.getByText("mark reached out via LinkedIn"));

    await vi.waitFor(() => expect(sentBodies().length).toBe(1));
    expect(sentBodies()[0]).toEqual({
      investor_id: "Acme Ventures|Dana Lee",
      channel: "linkedin",
    });
  });

  it("asks when there is no dossier, and sends the founder's pick", async () => {
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee" })]);
    fireEvent.click(screen.getByText("Acme Ventures"));

    expect(screen.queryByText("warm intro")).toBeNull();

    fireEvent.click(screen.getByText("mark reached out"));
    expect(screen.getByText(/which channel/i)).toBeTruthy();
    expect(sentBodies().length).toBe(0);

    fireEvent.click(screen.getByText("warm intro"));

    await vi.waitFor(() => expect(sentBodies().length).toBe(1));
    expect(sentBodies()[0]).toEqual({
      investor_id: "Acme Ventures|Dana Lee",
      channel: "warm_intro",
    });
    expect(screen.queryByText(/which channel/i)).toBeNull();
  });

  it("asks when the dossier names two channels rather than picking one", async () => {
    mount([
      inv({
        firm: "Acme Ventures",
        name: "Dana Lee",
        dossier: dossier({
          how_to_reach: { best_channel: "warm intro, otherwise email" },
        }),
      }),
    ]);
    fireEvent.click(screen.getByText("Acme Ventures"));
    fireEvent.click(screen.getByText("mark reached out"));

    expect(sentBodies().length).toBe(0);
    fireEvent.click(screen.getByText("X"));

    await vi.waitFor(() => expect(sentBodies().length).toBe(1));
    expect(sentBodies()[0]).toEqual({
      investor_id: "Acme Ventures|Dana Lee",
      channel: "twitter",
    });
  });

  it("the expanded choice adds no new control type — it is links", () => {
    const { container } = mount([inv({ firm: "Acme Ventures", name: "Dana Lee" })]);
    fireEvent.click(screen.getByText("Acme Ventures"));
    fireEvent.click(screen.getByText("mark reached out"));

    expect(container.querySelectorAll("select").length).toBe(0);
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelectorAll('[role="tab"]').length).toBe(0);
    expect(container.querySelectorAll('[role="dialog"]').length).toBe(0);
    for (const label of ["email", "LinkedIn", "X", "warm intro", "cancel"]) {
      expect(screen.getByText(label).tagName).toBe("BUTTON");
    }
  });

  it("cancelling writes nothing at all", () => {
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee" })]);
    fireEvent.click(screen.getByText("Acme Ventures"));
    fireEvent.click(screen.getByText("mark reached out"));
    fireEvent.click(screen.getByText("cancel"));

    expect(screen.queryByText(/which channel/i)).toBeNull();
    expect(apiCalls.list.length).toBe(0);
    expect(screen.queryByText("reached out")).toBeNull();
  });

  it("no mark on this surface ever ships a channel the data didn't state", async () => {
    mount([inv({ firm: "Acme Ventures", name: "Dana Lee" })]);
    fireEvent.click(screen.getByText("Acme Ventures"));
    fireEvent.click(screen.getByText("mark reached out"));
    fireEvent.click(screen.getByText("LinkedIn"));

    await vi.waitFor(() => expect(sentBodies().length).toBe(1));
    expect(sentBodies().every((b) => b.channel !== "email")).toBe(true);
  });
});

describe("show all in tier", () => {
  it("reveals the rest of a tier and can collapse again", () => {
    mount(
      Array.from({ length: 12 }, (_, i) =>
        inv({ firm: `Firm ${i}`, name: `P ${i}` }),
      ),
    );
    expect(screen.queryByText("Firm 9")).toBeNull();

    fireEvent.click(screen.getByText("Show more"));
    expect(screen.getByText("Firm 9")).toBeTruthy();

    fireEvent.click(screen.getByText("Show less"));
    expect(screen.queryByText("Firm 9")).toBeNull();
  });
});

describe("the outreach plan", () => {
  it("opens from the next step once two dossiers exist, and comes back", () => {
    mount([
      inv({ firm: "Warm Co", name: "Dana", dossier: dossier() }),
      inv({ firm: "Cold Co", name: "", dossier: dossier() }),
      inv({ firm: "Unread Co", name: "Sam" }),
    ]);

    fireEvent.click(screen.getAllByText("Build outreach plan")[0]);

    expect(screen.getByText("Outreach plan")).toBeTruthy();
    expect(screen.getByText("Go first: a named partner (1)")).toBeTruthy();
    expect(screen.getByText("Research before contact (1)")).toBeTruthy();

    fireEvent.click(screen.getByText("Back to the list"));
    expect(screen.getByText("Tier 1: strong fit")).toBeTruthy();
  });
});

describe("refine", () => {
  it("Enter submits the query and clears the box", async () => {
    mount([inv({ firm: "Acme Ventures" })]);
    const box = screen.getByLabelText(
      "Refine your investor list in plain English",
    ) as HTMLInputElement;

    fireEvent.change(box, { target: { value: "marketplace seed funds in NY" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await vi.waitFor(() => expect(box.value).toBe(""));
  });

  it("an empty query does nothing", () => {
    mount([inv({ firm: "Acme Ventures" })]);
    const box = screen.getByLabelText(
      "Refine your investor list in plain English",
    );
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(apiCalls.list.length).toBe(0);
  });
});

describe("a rejected status write does not stick", () => {
  it("rolls the row back when the server rejects the mark", async () => {
    mount([
      inv({
        firm: "Acme Ventures",
        name: "Dana Lee",
        dossier: dossier({ how_to_reach: { best_channel: "LinkedIn DM" } }),
      }),
    ]);
    fireEvent.click(screen.getByText("Acme Ventures"));

    apiBehavior.ok = false;
    fireEvent.click(screen.getByText("mark reached out via LinkedIn"));

    await vi.waitFor(() => expect(sentBodies().length).toBe(1));
    await vi.waitFor(() =>
      expect(screen.getByText("mark reached out via LinkedIn")).toBeTruthy(),
    );
  });

  it("keeps the mark when the server accepts it", async () => {
    mount([
      inv({
        firm: "Acme Ventures",
        name: "Dana Lee",
        dossier: dossier({ how_to_reach: { best_channel: "LinkedIn DM" } }),
      }),
    ]);
    fireEvent.click(screen.getByText("Acme Ventures"));
    fireEvent.click(screen.getByText("mark reached out via LinkedIn"));
    await vi.waitFor(() => expect(sentBodies().length).toBe(1));
    await vi.waitFor(() =>
      expect(screen.queryByText("mark reached out via LinkedIn")).toBeNull(),
    );
  });
});

describe("empty list copy", () => {
  it("does not claim researched work, and does not depend on layout", () => {
    const { container } = mount([]);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Everything you've researched is marked");
    expect(text).not.toMatch(/on the right/i);
    expect(text).toContain("Ask the Fundraising agent in chat");
  });
});
