
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  supabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test-token" } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  }),
}));
vi.mock("./auth", () => ({ signOut: vi.fn() }));
vi.mock("../shared/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/config")>()),
  ANSWER_POLL_MS: 0,
  THREAD_IDLE_POLL_MS: 3_600_000,
}));

import { isHighRisk, moneyCardBody, summarizeDecision } from "./components/ApprovalCard";
import {
  Panel,
  callsTo,
  installChrome,
  installFetch,
  newServer,
  type FakeDecision,
  type FakeServer,
} from "./test-harness";

let server: FakeServer;
let panel: Panel;

const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";

function decision(over: Partial<FakeDecision>): FakeDecision {
  return {
    id: D1,
    decision_class: "jira.create_issue",
    body: { summary: "Create Jira: follow up with Sam" },
    status: "proposed",
    agent_slug: "operator",
    thread_id: "thread-1",
    ...over,
  };
}

beforeEach(() => {
  server = newServer();
  installFetch(server);
  installChrome();
  panel = new Panel();
});

afterEach(() => {
  panel.unmount();
  vi.unstubAllGlobals();
});

describe("approval cards in the panel", () => {
  it("renders only decisions for the open thread", async () => {
    server.decisions = [
      decision({}),
      decision({ id: D2, thread_id: "some-other-thread", body: { summary: "Other thread card" } }),
    ];
    await panel.mount();
    await panel.ask("file a Jira for this");

    expect(panel.text).toContain("Create Jira: follow up with Sam");
    expect(panel.text).not.toContain("Other thread card");
    expect(panel.host.querySelectorAll(".zv-approval")).toHaveLength(1);
  });

  it("Approve posts to that decision's approve endpoint, then refreshes and the card goes", async () => {
    server.decisions = [decision({})];
    await panel.mount();
    await panel.ask("file a Jira for this");
    const historyBefore = callsTo(server, "GET", "/api/agents/operator/chat/history").length;

    await panel.click("button.zv-approval-approve");

    const approves = callsTo(server, "POST", `/api/approvals/${D1}/approve`);
    expect(approves).toHaveLength(1);
    expect(approves[0].body).toEqual({});
    expect(callsTo(server, "GET", "/api/agents/operator/chat/history").length).toBeGreaterThan(
      historyBefore,
    );
    expect(panel.host.querySelectorAll(".zv-approval")).toHaveLength(0);
  });

  it("Reject posts to the reject endpoint", async () => {
    server.decisions = [decision({})];
    await panel.mount();
    await panel.ask("file a Jira for this");
    await panel.click("button.zv-approval-reject");

    expect(callsTo(server, "POST", `/api/approvals/${D1}/reject`)).toHaveLength(1);
    expect(callsTo(server, "POST", `/api/approvals/${D1}/approve`)).toHaveLength(0);
  });

  it("a high-risk class needs Review then Confirm; the first click posts nothing", async () => {
    server.decisions = [decision({ decision_class: "engineer.ship-pr", body: { title: "Fix the checkout bug" } })];
    await panel.mount();
    await panel.ask("have the engineer fix this");

    await panel.click("button.zv-approval-approve");
    expect(callsTo(server, "POST", `/api/approvals/${D1}/approve`)).toHaveLength(0);
    expect(panel.text).toContain("Confirm");

    await panel.click("button.zv-approval-approve");
    expect(callsTo(server, "POST", `/api/approvals/${D1}/approve`)).toHaveLength(1);
  });

  it("409 requires_ship_red_override: warning, and only a second explicit click posts ship_anyway", async () => {
    server.decisions = [decision({ decision_class: "engineer.ship-pr", body: { title: "Fix the checkout bug" } })];
    server.approveReplies = [
      {
        status: 409,
        json: {
          error: {
            code: "requires_ship_red_override",
            message:
              "This change broke a test that was passing on the base branch. Confirm you want to open the PR anyway to approve it.",
          },
        },
      },
    ];
    await panel.mount();
    await panel.ask("have the engineer fix this");

    await panel.click("button.zv-approval-approve");
    await panel.click("button.zv-approval-approve");

    let approves = callsTo(server, "POST", `/api/approvals/${D1}/approve`);
    expect(approves).toHaveLength(1);
    expect(approves[0].body).toEqual({});
    expect(panel.text).toContain("broke a test that was passing on the base branch");
    expect(panel.host.querySelector("button.zv-approval-shipanyway")).not.toBeNull();

    await panel.click("button.zv-approval-shipanyway");
    approves = callsTo(server, "POST", `/api/approvals/${D1}/approve`);
    expect(approves).toHaveLength(2);
    expect(approves[1].body).toEqual({ ship_anyway: true });
  });
});

describe("money-step card (S3, approved copy)", () => {
  const SEAL = "a".repeat(64);
  const money = () =>
    decision({
      decision_class: "extension.money_step",
      body: {
        host: "ads.google.com",
        op: "click_ref",
        label: "Save",
        value_line: "Average daily budget: $50.00",
        fingerprint: SEAL,
        summary: "ignored",
      },
    });

  it("renders the approved title, body and buttons", async () => {
    server.decisions = [money()];
    await panel.mount();
    await panel.ask("raise the budget to $50/day");
    expect(panel.text).toContain("Confirm before I spend money");
    expect(panel.text).toContain('On ads.google.com I\'m about to click "Save". Average daily budget: $50.00');
    expect(panel.host.querySelector("button.zv-approval-approve")?.textContent).toBe("Go ahead");
    expect(panel.host.querySelector("button.zv-approval-reject")?.textContent).toBe("Don't do it");
  });

  it("Go ahead posts once, echoing the card's seal (else the backend refuses stale_card)", async () => {
    server.decisions = [money()];
    await panel.mount();
    await panel.ask("raise the budget to $50/day");
    await panel.click("button.zv-approval-approve");
    const approves = callsTo(server, "POST", `/api/approvals/${D1}/approve`);
    expect(approves).toHaveLength(1);
    expect(approves[0].body).toEqual({ expected_fingerprint: SEAL });
  });

  it("Don't do it posts a reject and never an approve", async () => {
    server.decisions = [money()];
    await panel.mount();
    await panel.ask("raise the budget to $50/day");
    await panel.click("button.zv-approval-reject");
    expect(callsTo(server, "POST", `/api/approvals/${D1}/reject`)).toHaveLength(1);
    expect(callsTo(server, "POST", `/api/approvals/${D1}/approve`)).toHaveLength(0);
  });

  it("typing and nav cards use their own approved shapes", () => {
    expect(moneyCardBody({ op: "type_ref", host: "ads.google.com", label: "Average daily budget", value: "$50.00" })).toBe(
      'On ads.google.com I\'m about to change "Average daily budget" to $50.00.',
    );
    expect(moneyCardBody({ op: "nav", host: "app.example.com", label: "app.example.com/pay/1" })).toBe(
      "On app.example.com I'm about to open the checkout page.",
    );
  });

  it("a dropdown (select_option) card shows the chosen amount, like typing", () => {
    expect(moneyCardBody({ op: "select_option", host: "ads.google.com", label: "Daily budget", value: "$75.00" })).toBe(
      'On ads.google.com I\'m about to change "Daily budget" to $75.00.',
    );
  });

  it("body without a value line", () => {
    expect(moneyCardBody({ host: "adsmanager.facebook.com", label: "Publish", value_line: null })).toBe(
      'On adsmanager.facebook.com I\'m about to click "Publish".',
    );
  });
});

describe("card helpers", () => {
  it("summary falls back through the body keys, never raw JSON", () => {
    expect(summarizeDecision({ description: "d" })).toBe("d");
    expect(summarizeDecision({ foo: 1 })).toBe("Review the details before deciding.");
    expect(summarizeDecision("plain")).toBe("plain");
  });

  it("high-risk classes", () => {
    for (const c of ["meta.budget_change", "ads.spend", "github.pr.merge", "stripe.payment", "file.delete", "engineer.ship-pr"]) {
      expect(isHighRisk(c)).toBe(true);
    }
    expect(isHighRisk("jira.create_issue")).toBe(false);
  });
});
