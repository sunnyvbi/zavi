
import { describe, expect, it } from "vitest";
import { heldCount } from "../channel-actions";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const row = (over: Record<string, unknown>) => ({ status: "snoozed", snoozed_until: "2026-11-09T00:00:00Z", held_reason: "pacing", body: {}, ...over });

describe("heldCount", () => {
  it("counts only cards held by pacing whose date is still ahead", () => {
    expect(
      heldCount(
        [
          row({}),
          row({}),
          row({ held_reason: null }),
          row({ snoozed_until: "2026-10-29T00:00:00Z" }),
          row({ status: "pending", snoozed_until: null, held_reason: "released" }),
          row({ body: { step: { deliverable: { kind: "strategy" } } } }),
        ],
        NOW,
      ),
    ).toBe(2);
  });
});
