import { describe, it, expect, vi } from "vitest";
import {
  detectCrossRunContradiction,
  detectGeneralContradiction,
  relativeAge,
  type RecallHitLite,
} from "../cross-run-contradiction";

function hit(body: string, agent_slug: string | null = "pm"): RecallHitLite {
  return { agent_slug, created_at: "2026-05-30T10:00:00Z", body };
}

describe("relativeAge", () => {
  const now = Date.parse("2026-05-30T12:00:00Z");

  it("renders 'today' for same-day notes", () => {
    expect(relativeAge("2026-05-30T01:00:00Z", now)).toBe("today");
  });

  it("renders '1d ago' / 'Nd ago'", () => {
    expect(relativeAge("2026-05-29T01:00:00Z", now)).toBe("1d ago");
    expect(relativeAge("2026-05-20T01:00:00Z", now)).toBe("10d ago");
  });

  it("omits (undefined) for future-dated notes — no clamp-lie", () => {
    expect(relativeAge("2026-06-01T00:00:00Z", now)).toBeUndefined();
  });

  it("omits for missing / unparsable created_at", () => {
    expect(relativeAge(null, now)).toBeUndefined();
    expect(relativeAge(undefined, now)).toBeUndefined();
    expect(relativeAge("not-a-date", now)).toBeUndefined();
  });
});

describe("detectCrossRunContradiction", () => {
  it("fires on the 600-vs-1160-hosts repro across two notes", () => {
    const banner = detectCrossRunContradiction([
      hit("~600 hosts are stalled at verification, generating zero GMV."),
      hit("Live host fleet: 1,160 booking requests this period."),
    ]);
    expect(banner).toBeDefined();
    expect(banner).toContain("conflicting figures");
    expect(banner).toContain("host");
  });

  it("does NOT fire on unrelated numbers sharing no business topic (FP guard)", () => {
    const banner = detectCrossRunContradiction([
      hit("We saw 50 signups this week."),
      hit("The host-referral reward is $50 per host."),
    ]);
    expect(banner).toBeUndefined();
  });

  it("does NOT fire when the same topic agrees across notes", () => {
    const banner = detectCrossRunContradiction([
      hit("We have about 600 hosts."),
      hit("Roughly 605 hosts are active."),
    ]);
    expect(banner).toBeUndefined();
  });

  it("does NOT fire on a single hit", () => {
    expect(
      detectCrossRunContradiction([hit("600 hosts vs 1160 hosts in one note")]),
    ).toBeUndefined();
  });

  it("does NOT fire when conflicting numbers live in the SAME note", () => {
    const banner = detectCrossRunContradiction([
      hit("600 hosts stalled but 1160 hosts live — same note."),
      hit("Revenue grew nicely."),
    ]);
    expect(banner).toBeUndefined();
  });

  it("handles null / empty bodies without crashing", () => {
    expect(
      detectCrossRunContradiction([
        { agent_slug: "pm", created_at: null, body: null },
        { agent_slug: null, created_at: null, body: "" },
      ]),
    ).toBeUndefined();
  });

  it("fires on a 0-vs-nonzero conflict on the same topic", () => {
    const banner = detectCrossRunContradiction([
      hit("0 active hosts right now."),
      hit("We have 600 hosts."),
    ]);
    expect(banner).toBeDefined();
    expect(banner).toContain("host");
  });
});

describe("detectGeneralContradiction (Gap #6 — status/policy/fact)", () => {
  it("FIRES on a same-subject status conflict (live vs paused)", () => {
    const banner = detectGeneralContradiction([
      hit("Stripe Connect payouts are live for all hosts."),
      hit("The Stripe Connect rollout is paused pending a key-scope review."),
    ]);
    expect(banner).toBeDefined();
    expect(banner).toContain("status of");
    expect(banner).toContain("live");
    expect(banner).toContain("paused");
    expect(banner!.toLowerCase()).toMatch(/stripe|connect/);
  });

  it("FIRES on an enabled-vs-disabled policy conflict on the same subject", () => {
    const banner = detectGeneralContradiction([
      hit("Guest referral rewards are enabled this quarter."),
      hit("Referral rewards are disabled until fraud review completes."),
    ]);
    expect(banner).toBeDefined();
    expect(banner).toContain("enabled");
    expect(banner).toContain("disabled");
    expect(banner!.toLowerCase()).toContain("referral");
  });

  it("FIRES on an approved-vs-rejected fact conflict", () => {
    const banner = detectGeneralContradiction([
      hit("The Acme partnership proposal was approved by ops."),
      hit("Legal says the Acme partnership proposal was rejected."),
    ]);
    expect(banner).toBeDefined();
    expect(banner!.toLowerCase()).toMatch(/acme|partnership|proposal/);
  });

  it("does NOT fire when opposing states describe DIFFERENT subjects", () => {
    const banner = detectGeneralContradiction([
      hit("The payments API is live in production."),
      hit("The marketing blog is currently paused."),
    ]);
    expect(banner).toBeUndefined();
  });

  it("does NOT fire on only a GENERIC shared noun (export vs import feature)", () => {
    const banner = detectGeneralContradiction([
      hit("The export feature is live."),
      hit("The import feature is disabled."),
    ]);
    expect(banner).toBeUndefined();
  });

  it("does NOT fire when one note HEDGES (mentions both sides of a group)", () => {
    const banner = detectGeneralContradiction([
      hit("Stripe Connect is live for payouts but disputes are still paused."),
      hit("Stripe Connect is live."),
    ]);
    expect(banner).toBeUndefined();
  });

  it("does NOT fire when the two notes AGREE on the same subject status", () => {
    const banner = detectGeneralContradiction([
      hit("Stripe Connect payouts are live."),
      hit("Confirmed: Stripe Connect payouts are live and healthy."),
    ]);
    expect(banner).toBeUndefined();
  });

  it("does NOT fire on a single hit, or on null/empty bodies", () => {
    expect(
      detectGeneralContradiction([hit("Stripe Connect is live but also paused.")]),
    ).toBeUndefined();
    expect(
      detectGeneralContradiction([
        { agent_slug: "pm", created_at: null, body: null },
        { agent_slug: null, created_at: null, body: "" },
      ]),
    ).toBeUndefined();
  });

  it("does NOT fire when no state words appear at all", () => {
    const banner = detectGeneralContradiction([
      hit("Revenue grew nicely this month."),
      hit("We onboarded several new hosts."),
    ]);
    expect(banner).toBeUndefined();
  });
});

describe("detectGeneralContradiction cost guard (no per-hit fan-out)", () => {
  it("never makes a network/LLM call — deterministic lexical only", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch" as never)
      .mockImplementation((() => {
        throw new Error("no network calls allowed on the recall hot path");
      }) as never);
    try {
      const hits: RecallHitLite[] = Array.from({ length: 8 }, (_, i) =>
        hit(
          i % 2 === 0
            ? "Stripe Connect payouts are live for hosts."
            : "Stripe Connect payouts are paused for hosts.",
        ),
      );
      const banner = detectGeneralContradiction(hits);
      expect(banner).toBeDefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
