import { describe, it, expect } from "vitest";
import { willBeInfraRetried } from "../queued-stuck-scan";
import {
  CHAT_REPLAY_SAFE_SLUGS,
  INFRA_RETRY_CAP,
} from "@/services/agents/infra-retry";

const engineerChatBase = {
  id: "run-eng-1",
  tenant_id: "t1",
  agent_slug: "engineer",
  status: "dispatch_error",
  error: "dispatch failed — Inngest exhausted retries",
  infra_retry_count: 0,
  last_progress_at: null as string | null,
  trigger: "chat" as string | null,
};

describe("engineer re-fire exclusion (turn-clock honesty P1)", () => {
  it("engineer is NOT in CHAT_REPLAY_SAFE_SLUGS (boot path won't re-fire a progressed engineer run)", () => {
    expect(CHAT_REPLAY_SAFE_SLUGS.has("engineer")).toBe(false);
  });

  it("SCAN gate: a progressed engineer chat run is NOT infra-retried (progress emitted → bubble, no re-mint)", () => {
    expect(
      willBeInfraRetried({
        ...engineerChatBase,
        last_progress_at: "2026-07-15T10:00:00Z",
      }),
    ).toBe(false);
  });

  it("SCAN gate: a pre-progress engineer orphan IS retryable but bounded by the shared cap", () => {
    expect(willBeInfraRetried(engineerChatBase)).toBe(true);
    expect(
      willBeInfraRetried({
        ...engineerChatBase,
        infra_retry_count: INFRA_RETRY_CAP,
      }),
    ).toBe(false);
  });

  it("the read-mostly agents that ARE replay-safe stay replay-safe (guards the exclusion is engineer-specific, not a typo)", () => {
    for (const slug of ["advisor", "pm", "growth-lead", "chief-of-staff", "research"]) {
      expect(CHAT_REPLAY_SAFE_SLUGS.has(slug)).toBe(true);
    }
  });
});
