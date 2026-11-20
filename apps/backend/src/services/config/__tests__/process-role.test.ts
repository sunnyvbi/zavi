import { describe, it, expect } from "vitest";

import { processRole, servesInngest } from "../process-role";

describe("processRole (PRAXIS_ROLE: which half of the backend this host is)", () => {
  it("unset or blank is the single all-in-one host, exactly as before the split", () => {
    expect(processRole({})).toBe("all");
    expect(processRole({ PRAXIS_ROLE: "" })).toBe("all");
    expect(processRole({ PRAXIS_ROLE: "  " })).toBe("all");
  });

  it("reads the two split roles", () => {
    expect(processRole({ PRAXIS_ROLE: "api" })).toBe("api");
    expect(processRole({ PRAXIS_ROLE: "worker" })).toBe("worker");
  });

  it("refuses a typo instead of silently running everything", () => {
    expect(() => processRole({ PRAXIS_ROLE: "Worker" })).toThrow(/PRAXIS_ROLE/);
    expect(() => processRole({ PRAXIS_ROLE: "apii" })).toThrow(/PRAXIS_ROLE/);
  });
});

describe("servesInngest", () => {
  it("only the api host stops serving /api/inngest", () => {
    expect(servesInngest("all")).toBe(true);
    expect(servesInngest("worker")).toBe(true);
    expect(servesInngest("api")).toBe(false);
  });
});
