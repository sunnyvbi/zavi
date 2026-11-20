import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const maybeSingle = vi.fn();
const selected: string[] = [];
vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({
    from: () => ({
      select: (cols: string) => {
        selected.push(cols);
        return { eq: () => ({ maybeSingle }) };
      },
    }),
  }),
}));

import { resolveAgentSendingIdentity } from "@/email/sending-identity";

const ENV = { ...process.env };

beforeEach(() => {
  maybeSingle.mockReset();
  selected.length = 0;
  process.env = { ...ENV };
});
afterEach(() => {
  process.env = ENV;
  vi.restoreAllMocks();
});

describe("resolveAgentSendingIdentity", () => {
  it("prefers the tenant's OWN verified domain — blast radius of one", () => {
    maybeSingle.mockResolvedValue({
      data: {
        domain: "mail.acme.com",
        from_address: "hello@mail.acme.com",
        from_name: "Acme",
        verification_status: "verified",
        provider_domain_id: "sg-domain-123",
      },
      error: null,
    });
    process.env.AGENT_EMAIL_FROM = "agents@zaviagent-mail.com";

    return resolveAgentSendingIdentity("t1").then((id) => {
      expect(id).toEqual({ from: "hello@mail.acme.com", name: "Acme", lane: "tenant_domain" });
    });
  });

  it("does not send From a verified domain that has no provider record, so no DKIM is signed", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        domain: "mail.acme.com",
        from_address: "hello@mail.acme.com",
        from_name: "Acme",
        verification_status: "verified",
        provider_domain_id: null,
      },
      error: null,
    });
    process.env.AGENT_EMAIL_FROM = "agents@zaviagent-mail.com";
    process.env.AGENT_EMAIL_FROM_NAME = "Zavi Agents";

    const id = await resolveAgentSendingIdentity("t1");

    expect(id).toEqual({ from: "agents@zaviagent-mail.com", name: "Zavi Agents", lane: "shared_agent_domain" });
    expect(selected).toHaveLength(1);
    expect(selected[0].split(",").map((c) => c.trim())).toContain("provider_domain_id");
  });

  it("falls to the auth domain, not the tenant domain, when a verified row has no provider record and no agent domain is set", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        domain: "mail.acme.com",
        from_address: "hello@mail.acme.com",
        from_name: "Acme",
        verification_status: "verified",
      },
      error: null,
    });
    delete process.env.AGENT_EMAIL_FROM;
    delete process.env.ZAVI_EMAIL_FROM;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const id = await resolveAgentSendingIdentity("t1");

    expect(id.lane).toBe("system_auth_domain");
    expect(id.from).not.toContain("acme.com");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("NEVER uses an unverified tenant domain — unauthenticated mail lands in spam", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        domain: "mail.acme.com",
        from_address: "hello@mail.acme.com",
        from_name: "Acme",
        verification_status: "pending",
      },
      error: null,
    });
    process.env.AGENT_EMAIL_FROM = "agents@zaviagent-mail.com";

    const id = await resolveAgentSendingIdentity("t1");
    expect(id.lane).toBe("shared_agent_domain");
    expect(id.from).toBe("agents@zaviagent-mail.com");
  });

  it("falls back to the shared AGENT domain — separate reputation from auth", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    process.env.AGENT_EMAIL_FROM = "agents@zaviagent-mail.com";
    process.env.ZAVI_EMAIL_FROM = "hello@zaviagent.com";

    const id = await resolveAgentSendingIdentity("t1");
    expect(id.lane).toBe("shared_agent_domain");
    expect(id.from).not.toBe("hello@zaviagent.com");
  });

  it("falls back to the auth domain only as a LAST resort, and says so out loud", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    delete process.env.AGENT_EMAIL_FROM;
    process.env.ZAVI_EMAIL_FROM = "hello@zaviagent.com";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const id = await resolveAgentSendingIdentity("t1");

    expect(id.lane).toBe("system_auth_domain");
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/password-reset|AUTH domain/i);
  });

  it("fails SOFT to the shared lane on a DB error — a blip must not stop a tenant's mail", async () => {
    maybeSingle.mockRejectedValue(new Error("db down"));
    process.env.AGENT_EMAIL_FROM = "agents@zaviagent-mail.com";

    const id = await resolveAgentSendingIdentity("t1");
    expect(id.lane).toBe("shared_agent_domain");
  });

  it("still resolves with NO env set at all — the sender defaults in code", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    delete process.env.AGENT_EMAIL_FROM;
    delete process.env.ZAVI_EMAIL_FROM;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const id = await resolveAgentSendingIdentity("t1");

    expect(id.lane).toBe("system_auth_domain");
    expect(id.from).toBe("support@zaviagent.com");
  });
});
