import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isRemoteToolAllowed } from "../write-allowlist";

vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn(async () => {}),
}));
import { logEvent } from "@/services/logging/logEvent";
import {
  getCapabilityFailclosedMode,
  isTenantFailclosedBypassed,
  shouldEnforceFailclosed,
  logCapabilityWouldBlock,
} from "../capability-failclosed";

const ENV_MODE = "CAPABILITY_FAILCLOSED_MODE";
const ENV_BYPASS = "CAPABILITY_FAILCLOSED_BYPASS_TENANTS";

describe("capability-failclosed — mode resolution", () => {
  const saved = process.env[ENV_MODE];
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_MODE];
    else process.env[ENV_MODE] = saved;
  });

  it("defaults to enforce when unset", () => {
    delete process.env[ENV_MODE];
    expect(getCapabilityFailclosedMode()).toBe("enforce");
  });

  it("defaults to enforce on an unrecognized value", () => {
    process.env[ENV_MODE] = "loud";
    expect(getCapabilityFailclosedMode()).toBe("enforce");
  });

  it("parses shadow/warn/enforce case-insensitively", () => {
    process.env[ENV_MODE] = "SHADOW";
    expect(getCapabilityFailclosedMode()).toBe("shadow");
    process.env[ENV_MODE] = "  warn ";
    expect(getCapabilityFailclosedMode()).toBe("warn");
    process.env[ENV_MODE] = "enforce";
    expect(getCapabilityFailclosedMode()).toBe("enforce");
  });
});

describe("capability-failclosed — per-tenant bypass", () => {
  const savedBypass = process.env[ENV_BYPASS];
  const savedMode = process.env[ENV_MODE];
  afterEach(() => {
    if (savedBypass === undefined) delete process.env[ENV_BYPASS];
    else process.env[ENV_BYPASS] = savedBypass;
    if (savedMode === undefined) delete process.env[ENV_MODE];
    else process.env[ENV_MODE] = savedMode;
  });

  it("no bypass list → not bypassed", () => {
    delete process.env[ENV_BYPASS];
    expect(isTenantFailclosedBypassed("t-1")).toBe(false);
  });

  it("matches a tenant in a comma/space list", () => {
    process.env[ENV_BYPASS] = "t-1, t-2  t-3";
    expect(isTenantFailclosedBypassed("t-2")).toBe(true);
    expect(isTenantFailclosedBypassed("t-3")).toBe(true);
    expect(isTenantFailclosedBypassed("t-9")).toBe(false);
    expect(isTenantFailclosedBypassed(null)).toBe(false);
  });

  it("shouldEnforceFailclosed: enforce mode + not bypassed → true; bypass → false", () => {
    process.env[ENV_MODE] = "enforce";
    process.env[ENV_BYPASS] = "t-1";
    expect(shouldEnforceFailclosed("t-9")).toBe(true);
    expect(shouldEnforceFailclosed("t-1")).toBe(false);
    process.env[ENV_MODE] = "shadow";
    expect(shouldEnforceFailclosed("t-9")).toBe(false);
  });
});

describe("capability-failclosed — would_block telemetry is C14-safe", () => {
  beforeEach(() => (logEvent as unknown as ReturnType<typeof vi.fn>).mockClear());

  it("logs source/code + only identifier meta (no user content)", () => {
    logCapabilityWouldBlock({
      tenant_id: "t-1",
      run_id: "r-1",
      server_id: "composio",
      tool_name: "GMAIL_SEND_EMAIL",
      gate: "advertise",
      agent_slug: "operator",
    });
    expect(logEvent).toHaveBeenCalledTimes(1);
    const arg = (logEvent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.source).toBe("capability.failclosed");
    expect(arg.code).toBe("would_block");
    expect(arg.tenant_id).toBe("t-1");
    expect(arg.meta).toEqual({
      server_id: "composio",
      tool_name: "GMAIL_SEND_EMAIL",
      agent_slug: "operator",
    });
  });
});

describe("isRemoteToolAllowed — enforce mode gates vendor-hinted writes", () => {
  it("(a) Composio write tool with readOnlyHint=true is gated (default = enforce)", () => {
    expect(isRemoteToolAllowed("composio", "GMAIL_SEND_EMAIL", true)).toBe(false);
    expect(
      isRemoteToolAllowed("composio", "LINEAR_RUN_QUERY_OR_MUTATION", true),
    ).toBe(false);
  });

  it("(a) NET-NEW: an UNKNOWN remote server can't launder a write-named tool via a read hint", () => {
    expect(isRemoteToolAllowed("acmecrm", "delete_contact", true)).toBe(false);
    expect(
      isRemoteToolAllowed("acmecrm", "delete_contact", true, { mode: "enforce" }),
    ).toBe(false);
  });

  it("(a) NET-NEW: a destructiveHint tool is distrusted even with readOnlyHint=true", () => {
    expect(
      isRemoteToolAllowed("acmecrm", "reconcile", {
        readOnlyHint: true,
        destructiveHint: true,
      }),
    ).toBe(false);
  });
});

describe("isRemoteToolAllowed — shadow/warn relax only the NET-NEW blocks", () => {
  it("(b) shadow allows the newly-gated unknown-server write (execute as today)", () => {
    expect(
      isRemoteToolAllowed("acmecrm", "delete_contact", true, { mode: "shadow" }),
    ).toBe(true);
    expect(
      isRemoteToolAllowed("acmecrm", "delete_contact", true, { mode: "warn" }),
    ).toBe(true);
  });

  it("(b) shadow does NOT re-open the pre-existing dynamic-vendor write-name drop", () => {
    expect(
      isRemoteToolAllowed("composio", "GMAIL_SEND_EMAIL", true, { mode: "shadow" }),
    ).toBe(false);
    expect(
      isRemoteToolAllowed("pipedream_stripe", "create_refund", true, {
        mode: "shadow",
      }),
    ).toBe(false);
  });
});

describe("isRemoteToolAllowed — per-tenant bypass", () => {
  it("(c) a bypassed tenant unblocks the NET-NEW write under enforce mode", () => {
    expect(
      isRemoteToolAllowed("acmecrm", "delete_contact", true, {
        mode: "enforce",
        bypassed: true,
      }),
    ).toBe(true);
  });
});

describe("isRemoteToolAllowed — reads keep flowing (no over-block)", () => {
  it("(d) a Higgsfield read fallback + a genuine composio/pipedream read pass in enforce", () => {
    expect(isRemoteToolAllowed("higgsfield", "balance", true)).toBe(true);
    expect(isRemoteToolAllowed("higgsfield", "generate_video", undefined)).toBe(true);
    expect(isRemoteToolAllowed("composio", "HUBSPOT_GET_DEAL", true)).toBe(true);
    expect(isRemoteToolAllowed("pipedream_notion", "search_pages", true)).toBe(true);
  });
});
