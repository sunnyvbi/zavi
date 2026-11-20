
import { describe, expect, it } from "vitest";
import {
  BUSINESS_ACTION_CONSEQUENCE,
  BUSINESS_ACTION_LABEL,
  BUSINESS_ACTION_TRIGGER,
  TRIGGER_BUSINESS_ACTION,
  businessActionsFor,
  runBusinessAction,
  type BusinessAction,
  type RunBusinessActionDeps,
} from "../business-actions";
import {
  TRANSITIONS,
  creatorOrderTriggersFrom,
  type CreatorOrderSource,
  type CreatorOrderStatus,
} from "../order-state";
import type { CreatorDisputeOpen } from "../orders-db";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";

const ALL_ACTIONS = Object.keys(BUSINESS_ACTION_TRIGGER) as BusinessAction[];
const ALL_STATUSES: CreatorOrderStatus[] = [
  "checkout_pending",
  "awaiting_acceptance",
  "in_progress",
  "submitted",
  "revision_requested",
  "cancel_requested",
  "in_dispute",
  "completed",
  "cancelled",
];
const ALL_SOURCES: CreatorOrderSource[] = ["booking", "offer", "applicant"];

describe("one action, one transition", () => {
  it("maps every action to exactly one trigger that exists in S3's table", () => {
    const known = new Set(TRANSITIONS.map((t) => t.trigger));
    for (const a of ALL_ACTIONS) {
      const t = BUSINESS_ACTION_TRIGGER[a];
      expect(known.has(t), `${a} -> ${t}`).toBe(true);
    }
  });

  it("is injective: no two actions share a trigger", () => {
    const triggers = ALL_ACTIONS.map((a) => BUSINESS_ACTION_TRIGGER[a]);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  it("round-trips through the inverse map", () => {
    for (const a of ALL_ACTIONS) {
      expect(TRIGGER_BUSINESS_ACTION[BUSINESS_ACTION_TRIGGER[a]]).toBe(a);
    }
  });

  it("only ever names triggers S3 allows the BUSINESS to pull", () => {
    for (const a of ALL_ACTIONS) {
      const row = TRANSITIONS.find((t) => t.trigger === BUSINESS_ACTION_TRIGGER[a]);
      expect(row?.actors).toContain("business");
    }
  });

  it("gives every action a label and a consequence sentence", () => {
    for (const a of ALL_ACTIONS) {
      expect(BUSINESS_ACTION_LABEL[a].length).toBeGreaterThan(0);
      expect(BUSINESS_ACTION_CONSEQUENCE[a].length).toBeGreaterThan(20);
      expect(BUSINESS_ACTION_CONSEQUENCE[a]).not.toMatch(/[–—]/);
      expect(BUSINESS_ACTION_CONSEQUENCE[a]).not.toContain("--");
      expect(BUSINESS_ACTION_LABEL[a]).not.toMatch(/[–—]/);
    }
  });
});

describe("the offered buttons come from S3, not from this file", () => {
  it("equals S3's business triggers for every status and source", () => {
    for (const status of ALL_STATUSES) {
      for (const source of ALL_SOURCES) {
        const fromTable = creatorOrderTriggersFrom(status, source, "business")
          .map((t) => TRIGGER_BUSINESS_ACTION[t])
          .filter((a): a is BusinessAction => a !== undefined)
          .filter((a) => a !== "ask_zavi_in_buffer")
          .sort();
        expect(businessActionsFor(status, source)).toEqual(fromTable);
      }
    }
  });

  it("never offers a button on a terminal-and-finished job it cannot act on", () => {
    expect(businessActionsFor("cancelled", "booking")).toEqual([]);
    expect(businessActionsFor("completed", "booking")).toEqual([]);
  });

  describe("Ask Zavi to step in on a closed job (Ravi 2026-09-27: 10 days after auto-approve)", () => {
    const closedAt = "2026-09-20T12:00:00.000Z";
    const day = 86_400_000;
    const at = (days: number) => new Date(Date.parse(closedAt) + days * day);
    const facts = (over: Partial<{ closed_reason: string; payout_status: string; now: Date }> = {}) => ({
      closed_reason: "auto_accepted",
      closed_at: closedAt,
      payout_status: "ready",
      now: at(3),
      ...over,
    });

    it("offers it on an auto-accepted job inside its 10 days", () => {
      expect(businessActionsFor("completed", "booking", null, facts())).toEqual(["ask_zavi_in_buffer"]);
    });
    it("never on a job the business approved itself", () => {
      expect(businessActionsFor("completed", "booking", null, facts({ closed_reason: "approved" }))).toEqual([]);
    });
    it("not after the 10 days", () => {
      expect(businessActionsFor("completed", "booking", null, facts({ now: at(10) }))).toEqual([]);
    });
    it("not once the payout was sent", () => {
      expect(businessActionsFor("completed", "booking", null, facts({ payout_status: "transferred" }))).toEqual([]);
    });
  });

  it("offers Approve only where there is something to approve", () => {
    expect(businessActionsFor("submitted", "booking")).toContain("approve");
    expect(businessActionsFor("in_progress", "booking")).not.toContain("approve");
    expect(businessActionsFor("awaiting_acceptance", "booking")).not.toContain("approve");
  });

  it("offers Cancel-the-booking only before the creator has accepted", () => {
    expect(businessActionsFor("awaiting_acceptance", "booking")).toContain("withdraw");
    expect(businessActionsFor("in_progress", "booking")).not.toContain("withdraw");
    expect(businessActionsFor("in_progress", "booking")).toContain("request_cancellation");
  });

  it("offers the extension decision only while the job is running (Q23)", () => {
    expect(businessActionsFor("in_progress", "booking")).toEqual(
      expect.arrayContaining(["approve_extension", "decline_extension"]),
    );
    expect(businessActionsFor("submitted", "booking")).not.toContain("approve_extension");
  });

  it("never offers both step-in buttons at once", () => {
    for (const status of ALL_STATUSES) {
      for (const source of ALL_SOURCES) {
        const offered = businessActionsFor(status, source);
        const both =
          offered.includes("ask_zavi") && offered.includes("ask_zavi_in_buffer");
        expect(both, `${status}/${source}`).toBe(false);
      }
    }
  });
});

type Recorded = {
  trigger: string;
  actor?: string;
  actor_user_id?: string | null;
  note?: string | null;
  dispute?: CreatorDisputeOpen;
};

function harness(result?: { ok: false; code: string; message: string }) {
  const calls: Recorded[] = [];
  const library: string[] = [];
  const threadPosts: string[] = [];
  const deps: RunBusinessActionDeps = {
    transition: (async (a: Recorded) => {
      calls.push(a);
      return (
        result ?? {
          ok: true,
          to: "completed",
          from: "submitted",
          needs_staff_review: false,
          payout_waiting: false,
        }
      );
    }) as never,
    library: {
      createLibraryAssetOnApproval: async (t, o) => {
        library.push(`${t}:${o}`);
        return { created: true, asset_id: "asset-1" };
      },
    },
    thread: {
      readThread: async () => ({ available: false, thread_id: null, messages: [] }),
      postMessage: async (a) => {
        threadPosts.push(a.body);
        return { posted: true };
      },
    },
    log: (async () => {}) as never,
  };
  return { deps, calls, library, threadPosts };
}

describe("running an action", () => {
  it("pulls the mapped trigger and nothing else", async () => {
    for (const a of ALL_ACTIONS) {
      const h = harness();
      await runBusinessAction(
        { tenant_id: TENANT, order_id: ORDER, action: a, user_id: "u1" },
        h.deps,
      );
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0].trigger).toBe(BUSINESS_ACTION_TRIGGER[a]);
    }
  });

  it("always acts as the BUSINESS, whatever the caller says", async () => {
    for (const a of ALL_ACTIONS) {
      const h = harness();
      await runBusinessAction(
        { tenant_id: TENANT, order_id: ORDER, action: a, user_id: "u1" },
        h.deps,
      );
      expect(h.calls[0].actor).toBe("business");
      expect(h.calls[0].actor_user_id).toBe("u1");
    }
  });

  it("refuses an illegal action with S3's reason, and does no side effect", async () => {
    const h = harness({
      ok: false,
      code: "illegal_transition",
      message: "'approve' cannot run on an order that is in_progress.",
    });
    const r = await runBusinessAction(
      { tenant_id: TENANT, order_id: ORDER, action: "approve", user_id: "u1", note: "looks good" },
      h.deps,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("illegal_transition");
    expect(h.library).toEqual([]);
    expect(h.threadPosts).toEqual([]);
  });

  it("carries the note into the dispute row when asking Zavi to step in", async () => {
    for (const a of ["ask_zavi", "ask_zavi_in_buffer"] as BusinessAction[]) {
      const h = harness();
      await runBusinessAction(
        {
          tenant_id: TENANT,
          order_id: ORDER,
          action: a,
          user_id: "u9",
          note: "The video never mentions the product",
        },
        h.deps,
      );
      expect(h.calls[0].dispute).toEqual({
        kind: "step_in",
        opened_by: "tenant",
        opened_by_user_id: "u9",
        reason: "The video never mentions the product",
      });
    }
  });

  it("keeps the note for Zavi away from the creator: no thread post, no note in the emails", async () => {
    for (const a of ["ask_zavi", "ask_zavi_in_buffer"] as BusinessAction[]) {
      const h = harness();
      await runBusinessAction(
        {
          tenant_id: TENANT,
          order_id: ORDER,
          action: a,
          user_id: "u9",
          note: "Between us, this creator ignored the brief twice",
        },
        h.deps,
      );
      expect(h.threadPosts, a).toEqual([]);
      expect(h.calls[0].note, a).toBeNull();
      expect(JSON.stringify(h.calls[0]).match(/ignored the brief/g), a).toHaveLength(1);
      expect(h.calls[0].dispute?.reason, a).toBe("Between us, this creator ignored the brief twice");
    }
  });

  it("still mirrors a note meant for the creator into the thread", async () => {
    const h = harness();
    await runBusinessAction(
      { tenant_id: TENANT, order_id: ORDER, action: "request_change", user_id: "u9", note: "Mention the price" },
      h.deps,
    );
    expect(h.threadPosts).toEqual(["Mention the price"]);
    expect(h.calls[0].note).toBe("Mention the price");
  });

  it("still opens a dispute when the business writes nothing", async () => {
    const h = harness();
    await runBusinessAction(
      { tenant_id: TENANT, order_id: ORDER, action: "ask_zavi", user_id: null },
      h.deps,
    );
    expect(h.calls[0].dispute).toMatchObject({
      reason: "The business asked Zavi to step in.",
    });
  });

  it("never attaches a dispute to an action that is not a step-in", async () => {
    for (const a of ALL_ACTIONS.filter((x) => !x.startsWith("ask_zavi"))) {
      const h = harness();
      await runBusinessAction(
        { tenant_id: TENANT, order_id: ORDER, action: a, user_id: "u1", note: "hi" },
        h.deps,
      );
      expect(h.calls[0].dispute).toBeUndefined();
    }
  });

  it("calls S14's library seam on approve, and ONLY on approve", async () => {
    const approve = harness();
    const r = await runBusinessAction(
      { tenant_id: TENANT, order_id: ORDER, action: "approve", user_id: "u1" },
      approve.deps,
    );
    expect(approve.library).toEqual([`${TENANT}:${ORDER}`]);
    expect(r.ok && r.library_asset_created).toBe(true);

    for (const a of ALL_ACTIONS.filter((x) => x !== "approve")) {
      const h = harness();
      await runBusinessAction(
        { tenant_id: TENANT, order_id: ORDER, action: a, user_id: "u1" },
        h.deps,
      );
      expect(h.library).toEqual([]);
    }
  });

  it("does not fail the action when the library seam throws", async () => {
    const h = harness();
    h.deps.library = {
      createLibraryAssetOnApproval: async () => {
        throw new Error("S14 is not merged");
      },
    };
    const r = await runBusinessAction(
      { tenant_id: TENANT, order_id: ORDER, action: "approve", user_id: "u1" },
      h.deps,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.library_asset_created).toBe(false);
  });

  it("mirrors a note into the thread, and posts nothing when there is none", async () => {
    const withNote = harness();
    await runBusinessAction(
      {
        tenant_id: TENANT,
        order_id: ORDER,
        action: "request_change",
        user_id: "u1",
        note: "Re-shoot the first 3 seconds",
      },
      withNote.deps,
    );
    expect(withNote.threadPosts).toEqual(["Re-shoot the first 3 seconds"]);

    const without = harness();
    await runBusinessAction(
      { tenant_id: TENANT, order_id: ORDER, action: "request_change", user_id: "u1" },
      without.deps,
    );
    expect(without.threadPosts).toEqual([]);
  });

  it("passes the caller's tenant straight through and never a second one", async () => {
    const h = harness();
    await runBusinessAction(
      { tenant_id: TENANT, order_id: ORDER, action: "approve", user_id: "u1" },
      h.deps,
    );
    expect(h.calls[0]).toMatchObject({ trigger: "approve" });
    expect(h.library[0].startsWith(TENANT)).toBe(true);
  });
});

describe("the library seam is actually wired, not still on the no-op", () => {
  it("realCreatorLibraryPort is NOT noopLibraryPort", async () => {
    const { realCreatorLibraryPort, noopLibraryPort } = await import("../s7-ports");
    expect(realCreatorLibraryPort).not.toBe(noopLibraryPort);
    expect(typeof realCreatorLibraryPort.createLibraryAssetOnApproval).toBe("function");
  });

  it("the notify port is the real service too, not the S3 no-op", async () => {
    const { realCreatorNotifyPort, noopCreatorNotifyPort } = await import("../ports");
    expect(realCreatorNotifyPort).not.toBe(noopCreatorNotifyPort);
  });
});
