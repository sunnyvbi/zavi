import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ row: null as unknown, error: null as unknown }));
vi.mock("../_client", () => ({ emailSend: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.row, error: h.error }) }) }) }),
  }),
}));

import { emailSelfReplyReason } from "../send";

beforeEach(() => {
  h.row = null;
  h.error = null;
});

describe("emailSelfReplyReason", () => {
  it("refuses a reply to the inbound sender of an email-triggered run (any casing)", async () => {
    h.row = { trigger: "email", payload: { email: { from: "jane@acme.test" } } };
    expect(await emailSelfReplyReason("t", "r", " Jane@Acme.test ")).toMatch(/already sent back to them/);
  });

  it("allows anyone else, and any recipient on a non-email run", async () => {
    h.row = { trigger: "email", payload: { email: { from: "jane@acme.test" } } };
    expect(await emailSelfReplyReason("t", "r", "ops@acme.test")).toBeNull();
    h.row = { trigger: "cron", payload: {} };
    expect(await emailSelfReplyReason("t", "r", "jane@acme.test")).toBeNull();
  });

  it("fails closed when the row cannot be read, is missing, or has no sender", async () => {
    h.error = { message: "db down" };
    expect(await emailSelfReplyReason("t", "r", "a@b.co")).toMatch(/Could not check/);
    h.error = null;
    h.row = null;
    expect(await emailSelfReplyReason("t", "r", "a@b.co")).toMatch(/Could not check/);
    h.row = { trigger: "email", payload: {} };
    expect(await emailSelfReplyReason("t", "r", "a@b.co")).toMatch(/Could not read who/);
  });
});
