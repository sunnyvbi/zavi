import { describe, it, expect } from "vitest";
import { buildRunEndSubscription } from "./decideRunUnread";
import { tenantRealtimeFilter } from "@/components/workspace/brain/tenantScope";

describe("buildRunEndSubscription — no subscribe until tenant resolves", () => {
  it("returns null while the session is hydrating (undefined)", () => {
    expect(buildRunEndSubscription(undefined)).toBeNull();
  });
  it("returns null when there is no active tenant (null)", () => {
    expect(buildRunEndSubscription(null)).toBeNull();
  });
  it("returns null for an empty-string tenant id", () => {
    expect(buildRunEndSubscription("")).toBeNull();
  });
});

describe("buildRunEndSubscription — isolation boundary", () => {
  it("filters on EXACTLY tenant_id=eq.<id>", () => {
    const cfg = buildRunEndSubscription("t-123");
    expect(cfg).not.toBeNull();
    expect(cfg!.filter).toBe("tenant_id=eq.t-123");
    expect(cfg!.filter).toBe(tenantRealtimeFilter("t-123"));
  });

  it("subscribes to thread_event INSERTs scoped per tenant", () => {
    const cfg = buildRunEndSubscription("t-123")!;
    expect(cfg.table).toBe("thread_event");
    expect(cfg.event).toBe("INSERT");
    expect(cfg.scopeKey).toBe("tenant:t-123");
  });
});
