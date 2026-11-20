import { describe, it, expect } from "vitest";
import { deriveToolCapability } from "../tool-capability";

describe("deriveToolCapability — fail-closed on unknown remote tools", () => {
  it("pipedream write-named tool → write yes|unknown, NEVER no", () => {
    const c = deriveToolCapability({ server_id: "pipedream_slack", tool_name: "send_message" });
    expect(c.write).toBe("yes");
    expect(c.write).not.toBe("no");
  });

  it("composio write-named tool → write yes|unknown, NEVER no", () => {
    const c = deriveToolCapability({ server_id: "composio", tool_name: "GITHUB_CREATE_ISSUE" });
    expect(["yes", "unknown"]).toContain(c.write);
    expect(c.write).not.toBe("no");
  });

  it("dynamic-vendor tool with a NON-write name still never writes:'no' (fail-closed)", () => {
    const c = deriveToolCapability({ server_id: "pipedream_notion", tool_name: "pages" });
    expect(c.write).not.toBe("no");
    expect(c.write).toBe("unknown");
  });

  it("a dynamic-vendor read-only hint is NOT trusted → write never 'no'", () => {
    const c = deriveToolCapability({
      server_id: "composio",
      tool_name: "HUBSPOT_GET_DEAL",
      annotations: { readOnlyHint: true },
    });
    expect(c.write).not.toBe("no");
    expect(c.egress).toBe("yes");
    expect(c.privateData).toBe("yes");
  });
});

describe("deriveToolCapability — first-party reads classify safe", () => {
  it("known first-party read tool → write:'no'", () => {
    const c = deriveToolCapability({ server_id: "memory", tool_name: "search" });
    expect(c.write).toBe("no");
    expect(c.metered).toBe("no");
    expect(c.revenue).toBe("no");
  });

  it("the open-web baseline reads are public (privateData:'no', egress:'yes')", () => {
    const c = deriveToolCapability({ server_id: "web_fetch", tool_name: "fetch" });
    expect(c.write).toBe("no");
    expect(c.privateData).toBe("no");
    expect(c.egress).toBe("yes");
    expect(c.fetch).toBe("yes");
  });
});

describe("deriveToolCapability — readOnlyHint must not launder a write name", () => {
  it("readOnlyHint=true on a write-named tool → write NOT 'no' (untrusted)", () => {
    const c = deriveToolCapability({
      server_id: "linear",
      tool_name: "update_issue",
      annotations: { readOnlyHint: true },
    });
    expect(c.write).not.toBe("no");
    expect(c.write).toBe("yes");
  });

  it("readOnlyHint=true on a NON-write first-party name IS trusted → write:'no'", () => {
    const c = deriveToolCapability({
      server_id: "operator_db",
      tool_name: "query_rows",
      annotations: { readOnlyHint: true },
    });
    expect(c.write).toBe("no");
  });

  it("destructiveHint=true forces write:'yes' regardless of name", () => {
    const c = deriveToolCapability({
      server_id: "stripe",
      tool_name: "reconcile",
      annotations: { destructiveHint: true },
    });
    expect(c.write).toBe("yes");
  });
});

describe("deriveToolCapability — metered + revenue axes", () => {
  it("a generation-named tool is metered:'yes'", () => {
    const c = deriveToolCapability({ server_id: "higgsfield", tool_name: "generate_video" });
    expect(c.metered).toBe("yes");
  });

  it("a money-verb tool is revenue:'yes'", () => {
    const c = deriveToolCapability({ server_id: "stripe", tool_name: "create_refund" });
    expect(c.revenue).toBe("yes");
    expect(c.write).toBe("yes");
  });

  it("an unknown remote server fails closed to 'unknown' on the safe axes", () => {
    const c = deriveToolCapability({ server_id: "evilserver", tool_name: "peek" });
    expect(c.write).toBe("unknown");
    expect(c.metered).toBe("unknown");
    expect(c.revenue).toBe("unknown");
    expect(c.privateData).toBe("unknown");
  });
});
