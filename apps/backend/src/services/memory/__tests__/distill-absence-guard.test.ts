import { describe, it, expect } from "vitest";

import { assertsBlockedCapability, type DistillArtifact } from "../distill";

function art(over: Partial<DistillArtifact>): DistillArtifact {
  return {
    note_type: "tenant_reference",
    title: "t",
    body_markdown: "b",
    tags: [],
    rationale: "r",
    ...over,
  };
}

describe("assertsBlockedCapability (durable-fact guard)", () => {
  it("flags the real poisoning notes (blocked/missing/pending capability)", () => {
    expect(
      assertsBlockedCapability(
        art({
          title: "Host-review reply endpoint and mobile UI implementation",
          body_markdown:
            "The backend endpoint POST /v1/hostReviews/.../reply was attempted but blocked by sandbox bootstrap failures. Mobile UIs remain pending backend contract availability.",
        }),
      ),
    ).toBe(true);
    expect(
      assertsBlockedCapability(
        art({
          title: "Sandbox boot blockers in rravi149/upcar",
          body_markdown:
            "Two pre-existing repo issues block app_verify sandbox boot. These must be patched alongside the host-review endpoint to unblock the HTTP-route gate.",
        }),
      ),
    ).toBe(true);
    expect(
      assertsBlockedCapability(
        art({
          note_type: "tenant_project",
          body_markdown: "The reply endpoint does not exist yet and is not implemented in the backend.",
        }),
      ),
    ).toBe(true);
  });

  it("does NOT flag agent_feedback / operator_preference (the correct home for a blocked-learning)", () => {
    expect(
      assertsBlockedCapability(
        art({
          note_type: "agent_feedback",
          body_markdown: "I concluded the endpoint was missing and stalled; next time grep the live code first.",
        }),
      ),
    ).toBe(false);
    expect(
      assertsBlockedCapability(
        art({ note_type: "operator_preference", body_markdown: "Operator wants the reply endpoint shipped." }),
      ),
    ).toBe(false);
  });

  it("does NOT flag a legit business fact with no code-capability noun", () => {
    expect(
      assertsBlockedCapability(
        art({ body_markdown: "The Visa partnership is currently blocked on legal review." }),
      ),
    ).toBe(false);
    expect(
      assertsBlockedCapability(
        art({ body_markdown: "The average host owns 3.2 cars; primary geo is the California Bay Area." }),
      ),
    ).toBe(false);
    expect(
      assertsBlockedCapability(
        art({ body_markdown: "The Stripe Connect contract is currently pending legal review." }),
      ),
    ).toBe(false);
  });

  it("does NOT flag a POSITIVE capability fact (endpoint exists)", () => {
    expect(
      assertsBlockedCapability(
        art({
          body_markdown:
            "Host reply to a guest review is served by the live endpoint POST /respondToCarReview { ratingId, responseMessage }.",
        }),
      ),
    ).toBe(false);
  });
});
