import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: () => ({ from: () => null }) }));
vi.mock("@/services/agents/runner", () => ({ canCurrentUserReadRun: async () => true }));

import { missReasonFor } from "@/services/channels/top-action-miss";
import { topActionFinalRefusal, topActionRetryPayload } from "@/services/channels/top-actions";

import { LIST_GONE_SENTENCE as GONE } from "@/services/email-plan/messages";
const zavi = { channel_slug: "email_marketing", top_action: { key: "new_email", by: "u1", inputs: { route: "zavi_list", list_id: "6b7a1c2e-1111-4222-8333-444455556666", brief: "Announce the spring sale" } } };
const tool = { channel_slug: "email_marketing", top_action: { key: "new_email", by: "u1", inputs: { route: "mailchimp", list_id: "a1b2c3", brief: "Announce the spring sale" } } };
const refused = (code: string) => [
  { name: "email__propose_campaign", status: "tool_error", code: "something_transient" },
  { name: "email__propose_campaign", status: "tool_error", code },
];

describe("a list that vanished between the pick and the run", () => {
  it.each([
    ["list_not_found", zavi],
    ["email_audience_missing", tool],
  ])("%s is final: no second paid run, and the banner says the list is gone", (code, payload) => {
    expect(topActionRetryPayload(payload, refused(code))).toBeNull();
    expect(topActionFinalRefusal(payload, refused(code))).toEqual({ code });
    expect(missReasonFor(payload, refused(code))).toBe(GONE);
  });

  it("an unrelated non-final code still earns the one retry, so the guard is about these codes", () => {
    expect(topActionRetryPayload(zavi, [{ name: "email__propose_campaign", status: "tool_error", code: "something_transient" }])).not.toBeNull();
  });
});
