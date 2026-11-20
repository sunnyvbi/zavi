
import { describe, it, expect, beforeEach } from "vitest";
import {
  assertColdContactWithinCaps,
  dmRecipientsFromCall,
  isConsentedSlackReply,
  recipientKeyFor,
  __resetDmGuardForTests,
} from "@/services/mcp/slack-dm-guard";

const T = "tenant-1";
const RUN = "run-1";
const INBOUND_DM = "D0BGT91QLER";

beforeEach(() => __resetDmGuardForTests());

describe("consented replies are never metered (2026-07-13 regression)", () => {
  it("a backend delivery worker posting into an inbound DM is exempt", () => {
    expect(
      isConsentedSlackReply({ slack_inbound_delivery: true }, { channel_id: INBOUND_DM }),
    ).toBe(true);
  });

  it("an agent posting back into the DM that TRIGGERED its run is exempt", () => {
    expect(
      isConsentedSlackReply({ slack_routing: { channel_id: INBOUND_DM } }, { channel_id: INBOUND_DM }),
    ).toBe(true);
  });

  it("THE INCIDENT: 50 reply posts into one active DM are never metered", () => {
    const ctx = { slack_inbound_delivery: true };
    for (let i = 0; i < 50; i++) {
      const recipients = isConsentedSlackReply(ctx, { channel_id: INBOUND_DM })
        ? null
        : dmRecipientsFromCall("post_message", { channel_id: INBOUND_DM });
      expect(recipients).toBeNull();
    }
  });
});

describe("cold contact IS still blocked — on breadth (the actual blast)", () => {
  it("blocks fan-out past the per-run distinct-recipient cap", () => {
    for (let i = 0; i < 5; i++) {
      expect(() => assertColdContactWithinCaps(T, RUN, [`U-stranger-${i}`])).not.toThrow();
    }
    expect(() => assertColdContactWithinCaps(T, RUN, ["U-stranger-5"])).toThrow(
      /different people/i,
    );
  });

  it("a group DM counts as ONE recipient set — MPIM fan-out cannot buy reach cheaply", () => {
    for (let i = 0; i < 5; i++) {
      expect(() =>
        assertColdContactWithinCaps(T, RUN, [`U-a${i}`, `U-b${i}`, `U-c${i}`]),
      ).not.toThrow();
    }
    expect(() => assertColdContactWithinCaps(T, RUN, ["U-a9", "U-b9", "U-c9"])).toThrow(
      /different people/i,
    );
  });

  it("re-messaging the SAME cold recipient does not consume breadth", () => {
    for (let i = 0; i < 6; i++) {
      expect(() => assertColdContactWithinCaps(T, RUN, ["U-same"])).not.toThrow();
    }
  });

  it("still depth-caps a loop harassing ONE cold recipient", () => {
    for (let i = 0; i < 8; i++) assertColdContactWithinCaps(T, RUN, ["U-victim"]);
    expect(() => assertColdContactWithinCaps(T, RUN, ["U-victim"])).toThrow(
      /unprompted messages/i,
    );
  });

  it("caps cold breadth across MANY runs at the tenant level", () => {
    let blocked = false;
    outer: for (let r = 0; r < 10; r++) {
      for (let i = 0; i < 5; i++) {
        try {
          assertColdContactWithinCaps(T, `run-${r}`, [`U-x${r}-${i}`]);
        } catch {
          blocked = true;
          break outer;
        }
      }
    }
    expect(blocked).toBe(true);
  });

  it("isolates tenants — one tenant's cold budget does not affect another", () => {
    for (let i = 0; i < 5; i++) assertColdContactWithinCaps("tA", RUN, [`U${i}`]);
    expect(() => assertColdContactWithinCaps("tA", RUN, ["U-more"])).toThrow();
    expect(() => assertColdContactWithinCaps("tB", RUN, ["U-more"])).not.toThrow();
  });

  it("rolls cold depth off after the 1h window", () => {
    const base = 3_000_000;
    for (let i = 0; i < 8; i++) assertColdContactWithinCaps(T, RUN, ["U1"], base + i);
    expect(() => assertColdContactWithinCaps(T, RUN, ["U1"], base + 8)).toThrow();
    expect(() =>
      assertColdContactWithinCaps(T, RUN, ["U1"], base + 60 * 60 * 1000 + 1),
    ).not.toThrow();
  });
});

describe("the reply exemption is not reachable by a model", () => {
  it("no ctx => a raw D... post is cold contact and IS metered", () => {
    expect(isConsentedSlackReply({}, { channel_id: INBOUND_DM })).toBe(false);
    expect(dmRecipientsFromCall("post_message", { channel_id: INBOUND_DM })).toEqual([
      INBOUND_DM,
    ]);
  });

  it("posting to a DIFFERENT DM than the one that triggered the run is NOT exempt", () => {
    expect(
      isConsentedSlackReply({ slack_routing: { channel_id: INBOUND_DM } }, { channel_id: "D-OTHER" }),
    ).toBe(false);
  });

  it("a model-supplied slack_inbound_delivery in TOOL ARGS grants nothing", () => {
    expect(
      isConsentedSlackReply({}, { channel_id: "D-VICTIM", slack_inbound_delivery: true }),
    ).toBe(false);
  });
});

describe("dmRecipientsFromCall — DM shape detection", () => {
  it("extracts a single user_id", () => {
    expect(dmRecipientsFromCall("post_message", { user_id: "U1", text: "x" })).toEqual(["U1"]);
  });
  it("extracts user_ids (group DM)", () => {
    expect(dmRecipientsFromCall("open_dm", { user_ids: ["U1", "U2"] })).toEqual(["U1", "U2"]);
  });
  it("treats a raw D... channel as a DM (bypass attempt)", () => {
    expect(dmRecipientsFromCall("post_message", { channel_id: "D999", text: "x" })).toEqual(["D999"]);
  });
  it("treats a raw G... group-DM channel as a DM (a LIVE bypass before 2026-07-13)", () => {
    expect(dmRecipientsFromCall("post_message", { channel_id: "G0ABCDEF1" })).toEqual(["G0ABCDEF1"]);
  });
  it("returns null for a normal channel post (exempt)", () => {
    expect(dmRecipientsFromCall("post_message", { channel_id: "C42", text: "x" })).toBeNull();
  });
  it("returns null for a read tool", () => {
    expect(dmRecipientsFromCall("get_channel_history", { channel_id: "C1" })).toBeNull();
  });
});

describe("recipientKeyFor — order-independent", () => {
  it("same set in any order maps to the same key", () => {
    expect(recipientKeyFor(["U2", "U1"])).toBe(recipientKeyFor(["U1", "U2"]));
  });
});
