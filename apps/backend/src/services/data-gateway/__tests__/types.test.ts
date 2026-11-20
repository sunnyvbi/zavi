import { describe, it, expect } from "vitest";
import { GatewayRefusal, ConnectorOfflineError, AuditUnavailableError, callerLabel } from "../types";
import { ExpectedToolError } from "@/services/tools/types";

describe("gateway errors", () => {
  it("are recoverable ExpectedToolErrors with stable codes", () => {
    const r = new GatewayRefusal("users.email is hidden", "zavi", ["users"]);
    expect(r).toBeInstanceOf(ExpectedToolError);
    expect(r.code).toBe("data_access_refused");
    expect(r.message).toBe("Refused by a data-access rule: users.email is hidden");
    expect(new GatewayRefusal("raw rows not allowed", "connector", [], { totals_only: true }).message).toMatch(/Refused by your connector.*Use operator_db__summary\./);
    expect(new ConnectorOfflineError("mac-mini", "3 hours").code).toBe("connector_offline");
    expect(new ConnectorOfflineError(null, null).message).toMatch(/answer without their data/);
    expect(new AuditUnavailableError().code).toBe("audit_unavailable");
  });
  it("callerLabel", () => {
    expect(callerLabel({ kind: "agent", agent_slug: "pm", run_id: null, tool_name: "x" })).toBe("pm");
    expect(callerLabel({ kind: "background", feature: "Booking metrics" })).toBe("Zavi (background) · Booking metrics");
    expect(callerLabel({ kind: "person", user_id: "u", feature: "Contact import" })).toBe("Contact import");
  });
});
