import { describe, it, expect } from "vitest";
import {
  themeSeverity,
  buildStuckRollupBody,
  decideCoalesceAction,
  needsActionMarkdown,
} from "../needs-action";

describe("themeSeverity — security/money/P0 themes route HIGH", () => {
  const KNOWN_P0S = [
    "P0 IDOR: authenticated users can read other users' payment methods",
    "Dispute evidence deadlines expiring silently — 3 packets 9 days old, 0 approvals",
    "Offline/pay-later bookings may enter automated payout cron without exclusion guard",
    "Password hash leaking in queries + account takeover via profile change",
    "Email monitor failing with Mongo auth error — support dark since June 3",
    "IDOR on POST /api/users/getPaymentInfo exposes full payment method to any authenticated user",
    "Cross-subdomain auth blocks private-label user registration (SCRUM-5114)",
    "Webhook race condition in webhookHandlers.ts causes double charges on retries",
    "Split-payment path shipped without committed test coverage",
    "Guest checkout abandons at payment method step — 94% InitiateCheckout→AddPaymentInfo drop",
    "OAuth login failure blocks ~15% of new signups permanently",
    "Password reset token not invalidated after use — account takeover vector",
    "Cross-tenant data exposure lets users view other companies' records",
    "SQL injection in search endpoint",
    "Stored XSS steals session cookies",
    "Privilege escalation via role update",
    "Any user can delete another user's listing",
    "Admin-only endpoint callable by regular users",
  ];
  for (const theme of KNOWN_P0S) {
    it(`HIGH: ${theme.slice(0, 48)}`, () => {
      expect(themeSeverity(theme)).toBe("high");
    });
  }

  it("routine engineering themes classify NORMAL", () => {
    expect(themeSeverity("DL barcode parsing missing from DriverVerification.tsx")).toBe("normal");
    expect(themeSeverity("Host-review reply endpoint missing in web backend")).toBe("normal");
    expect(
      themeSeverity("Operator agent preemptively claims file-read tools unavailable"),
    ).toBe("normal");
    expect(themeSeverity("75 QA test cases seeded but zero automated executions")).toBe("normal");
  });

  it("null / empty theme is NORMAL (never crashes)", () => {
    expect(themeSeverity(null)).toBe("normal");
    expect(themeSeverity(undefined)).toBe("normal");
    expect(themeSeverity("")).toBe("normal");
  });
});

describe("buildStuckRollupBody — one informational card, nothing hidden", () => {
  const items = Array.from({ length: 15 }, (_, i) => ({
    theme: `stuck theme ${i + 1}`,
    roadmap_id: `rm-${i + 1}`,
  }));

  it("no-op approve shape (roadmap_id null, proposed_action none)", () => {
    const b = buildStuckRollupBody(items);
    expect(b.stuck_rollup).toBe(true);
    expect(b.proposed_action).toBe("none");
    expect(b.roadmap_id).toBeNull();
    expect(b.severity).toBe("normal");
    expect(b.affected_count).toBe(15);
  });

  it("names items + counts the overflow (nothing silently dropped)", () => {
    const md = buildStuckRollupBody(items).rendered_markdown as string;
    expect(md).toContain("15 fixes stuck in review");
    expect(md).toContain("stuck theme 1");
    expect(md).toContain("(and 7 more)");
  });

  it("carries roadmap_ids so an operator can act from the feed", () => {
    const b = buildStuckRollupBody(items);
    expect(b.affected_roadmap_ids).toContain("rm-1");
  });

  it("no em-dashes in outbound copy", () => {
    const md = buildStuckRollupBody(items).rendered_markdown as string;
    expect(md).not.toContain("—");
  });

  it("singular grammar for one item", () => {
    const md = buildStuckRollupBody([{ theme: "solo", roadmap_id: "rm-x" }])
      .rendered_markdown as string;
    expect(md).toContain("1 fix stuck in review");
  });
});

describe("decideCoalesceAction — reused for the stuck rollup lifecycle", () => {
  it("items + none open → emit", () => expect(decideCoalesceAction(3, false)).toBe("emit"));
  it("items + one open → refresh", () => expect(decideCoalesceAction(3, true)).toBe("refresh"));
  it("zero + one open → resolve (stalls cleared)", () =>
    expect(decideCoalesceAction(0, true)).toBe("resolve"));
  it("zero + none open → noop", () => expect(decideCoalesceAction(0, false)).toBe("noop"));
});

describe("needsActionMarkdown PR promise", () => {
  const base = { theme: "t", kind: "stuck" as const, proposed_action: "redispatch_and_close_pr" as const };
  it("promises a close only for a PR the handler can parse", () => {
    expect(needsActionMarkdown({ ...base, pr_url: "https://github.com/a/b/pull/7" })).toContain("close the stale PR");
    expect(needsActionMarkdown({ ...base, pr_url: "https://example.com/not-a-pr" })).not.toContain("close the stale PR");
    expect(needsActionMarkdown({ ...base, pr_url: null })).not.toContain("close the stale PR");
  });
});
