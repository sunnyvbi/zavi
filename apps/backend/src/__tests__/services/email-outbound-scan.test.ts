import { describe, it, expect } from "vitest";
import { scanOutboundEmail } from "../../services/tools/email/outbound-scan";

describe("scanOutboundEmail — blocks credential leaks", () => {
  it("passes a normal support reply", () => {
    const r = scanOutboundEmail("Hi Jane, your booking is confirmed for Friday. Thanks!");
    expect(r.blocked).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("blocks an AWS access key id", () => {
    const r = scanOutboundEmail("here is the key AKIAIOSFODNN7EXAMPLE for you");
    expect(r.blocked).toBe(true);
    expect(r.reasons).toContain("aws_access_key_id");
  });

  it("blocks an OpenAI-style secret key", () => {
    const r = scanOutboundEmail("use sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(r.blocked).toBe(true);
    expect(r.reasons).toContain("openai_key");
  });

  it("blocks a Stripe live key", () => {
    expect(scanOutboundEmail("sk_live_abcdef0123456789ABCDEF").blocked).toBe(true);
  });

  it("blocks a private key block", () => {
    expect(scanOutboundEmail("-----BEGIN RSA PRIVATE KEY-----\nMIIE...").blocked).toBe(true);
  });

  it("blocks a slack token", () => {
    expect(scanOutboundEmail("token xoxb-12345678901-abcdefghijkl").blocked).toBe(true);
  });

  it("blocks a github token", () => {
    expect(scanOutboundEmail("ghp_abcdefghijklmnopqrstuvwxyz0123456789").blocked).toBe(true);
  });

  it("blocks a JWT", () => {
    expect(
      scanOutboundEmail("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N").blocked,
    ).toBe(true);
  });

  it("blocks a praxis vault secret key name", () => {
    expect(scanOutboundEmail("the value of slack.bot_token is ...").blocked).toBe(true);
  });

  it("blocks a service_role mention", () => {
    expect(scanOutboundEmail("SUPABASE_SERVICE_ROLE_KEY=...").blocked).toBe(true);
  });

  it("blocks a postgres connection string with creds", () => {
    expect(scanOutboundEmail("postgresql://user:pass@host:5432/db").blocked).toBe(true);
  });

  it("scans the html body too", () => {
    const r = scanOutboundEmail("clean text", "<p>AKIAIOSFODNN7EXAMPLE</p>");
    expect(r.blocked).toBe(true);
  });
});
