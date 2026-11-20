import { describe, it, expect } from "vitest";
import {
  shouldRefuseUnapprovedShipPr,
  shouldHoldInteractiveShipPr,
  shouldRefuseUnapprovedComposioWrite,
} from "../ship-pr-approval-gate";

describe("shouldRefuseUnapprovedComposioWrite (decision.approved on a Composio write)", () => {
  it("refuses unless the row status is exactly 'approved'", () => {
    for (const status of ["proposed", "dispatching", "rejected", "acted", null]) {
      expect(shouldRefuseUnapprovedComposioWrite({ handler: "composio.execute_tool", decision_class: "composio.moves_money", status })).toBe(true);
    }
    expect(shouldRefuseUnapprovedComposioWrite({ handler: "composio.execute_tool", decision_class: "composio.write", status: "approved" })).toBe(false);
  });
  it("a composio.* class is refused even if its handler column is off", () => {
    expect(shouldRefuseUnapprovedComposioWrite({ handler: null, decision_class: "composio.deletes_data", status: "proposed" })).toBe(true);
  });
  it("other classes are untouched; a missing row is left to the claim", () => {
    expect(shouldRefuseUnapprovedComposioWrite({ handler: "github.open_pr", decision_class: "engineer.ship-pr", status: "proposed" })).toBe(false);
    expect(shouldRefuseUnapprovedComposioWrite(null)).toBe(false);
  });
});

describe("shouldRefuseUnapprovedShipPr (P1-d: decision.approved replay guard)", () => {
  it("REFUSES a proposed engineer.ship-pr with no approved_by (replayed/injected event)", () => {
    expect(
      shouldRefuseUnapprovedShipPr({
        decision_class: "engineer.ship-pr",
        status: "proposed",
        approved_by: null,
      }),
    ).toBe(true);
  });

  it("ALLOWS a genuinely human-approved engineer.ship-pr (normal yes-path)", () => {
    expect(
      shouldRefuseUnapprovedShipPr({
        decision_class: "engineer.ship-pr",
        status: "approved",
        approved_by: "user-123",
      }),
    ).toBe(false);
  });

  it("REFUSES an anomalous status='approved' row with NO approved_by (Codex P2: approved_by is the real invariant)", () => {
    expect(
      shouldRefuseUnapprovedShipPr({
        decision_class: "engineer.ship-pr",
        status: "approved",
        approved_by: null,
      }),
    ).toBe(true);
  });

  it("ALLOWS when approved_by is set even if status has moved on (dispatching/acted)", () => {
    expect(
      shouldRefuseUnapprovedShipPr({
        decision_class: "engineer.ship-pr",
        status: "dispatching",
        approved_by: "user-123",
      }),
    ).toBe(false);
  });

  it("does NOT touch other decision classes (scoped to engineer.ship-pr)", () => {
    expect(
      shouldRefuseUnapprovedShipPr({
        decision_class: "meta_ads.budget",
        status: "proposed",
        approved_by: null,
      }),
    ).toBe(false);
    expect(
      shouldRefuseUnapprovedShipPr({
        decision_class: "growth-lead.some-action",
        status: "proposed",
        approved_by: null,
      }),
    ).toBe(false);
  });

  it("does NOT refuse a null/undefined row (executeDispatch handles a missing row as a no-op)", () => {
    expect(shouldRefuseUnapprovedShipPr(null)).toBe(false);
    expect(shouldRefuseUnapprovedShipPr(undefined)).toBe(false);
  });
});

describe("shouldHoldInteractiveShipPr (Layer-2: auto-cron interactive-trigger hold)", () => {
  it("HOLDS a chat-triggered engineer.ship-pr (F6: chat must never auto-open; reply-yes is its only open route)", () => {
    expect(
      shouldHoldInteractiveShipPr({ hasRunId: true, readOk: true, trigger: "chat" }),
    ).toBe(true);
  });

  it("does NOT hold a slack-triggered engineer.ship-pr (auto-open — no inline approval surface to route through)", () => {
    expect(
      shouldHoldInteractiveShipPr({ hasRunId: true, readOk: true, trigger: "slack" }),
    ).toBe(false);
  });

  it("HOLDS a push_to_main row on an interactive trigger (defense-in-depth: never fast-forward a customer's main from the auto-open path)", () => {
    expect(
      shouldHoldInteractiveShipPr({
        hasRunId: true,
        readOk: true,
        trigger: "slack",
        pushToMain: true,
      }),
    ).toBe(true);
  });

  it("does NOT hold a push_to_main row on an autopilot trigger (product-builder must still auto-fire)", () => {
    expect(
      shouldHoldInteractiveShipPr({
        hasRunId: true,
        readOk: true,
        trigger: "a2a",
        pushToMain: true,
      }),
    ).toBe(false);
  });

  it("does NOT hold cron/a2a/manual triggers (Devin-parity auto-open preserved)", () => {
    for (const trigger of ["cron", "a2a", "manual", "playbook", "webhook"]) {
      expect(
        shouldHoldInteractiveShipPr({ hasRunId: true, readOk: true, trigger }),
      ).toBe(false);
    }
  });

  it("FAILS CLOSED when there is no agent_run_id", () => {
    expect(
      shouldHoldInteractiveShipPr({ hasRunId: false, readOk: false, trigger: undefined }),
    ).toBe(true);
  });

  it("FAILS CLOSED when the trigger read failed (readOk=false)", () => {
    expect(
      shouldHoldInteractiveShipPr({ hasRunId: true, readOk: false, trigger: undefined }),
    ).toBe(true);
  });

  it("does NOT hold on a null trigger that read successfully (treated as non-interactive)", () => {
    expect(
      shouldHoldInteractiveShipPr({ hasRunId: true, readOk: true, trigger: null }),
    ).toBe(false);
  });
});

describe("shouldHoldInteractiveShipPr — push_to_main on the widened in-session set", () => {
  it("HOLDS a push_to_main row on a handoff trigger", () => {
    expect(
      shouldHoldInteractiveShipPr({
        hasRunId: true,
        readOk: true,
        trigger: "handoff",
        pushToMain: true,
      }),
    ).toBe(true);
  });

  it("does NOT hold a normal (non push_to_main) handoff row — it still auto-opens", () => {
    expect(
      shouldHoldInteractiveShipPr({
        hasRunId: true,
        readOk: true,
        trigger: "handoff",
        pushToMain: false,
      }),
    ).toBe(false);
  });

  it.each(["a2a", "manual"])(
    "does NOT hold push_to_main on %s — autopilot product-builder pushes legitimately, and tryPushToMain pins the repo",
    (trigger) => {
      expect(
        shouldHoldInteractiveShipPr({
          hasRunId: true,
          readOk: true,
          trigger,
          pushToMain: true,
        }),
      ).toBe(false);
    },
  );
});
