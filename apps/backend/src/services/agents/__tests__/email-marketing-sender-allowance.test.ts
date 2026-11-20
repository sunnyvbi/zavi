import { describe, it, expect, vi } from "vitest";
import { scrubAgentEgress } from "@/services/agents/scrub-agent-egress";
import { keptEmailsFor, runEmailAllowlist } from "@/services/agents/egress-email-provenance";
import { ownerEmailAllowlist, ownerTextsFromRows } from "@/services/agents/owner-turns";

const resolveBulkSender = vi.hoisted(() => vi.fn());
vi.mock("@/services/comms/bulk-outbound/sending-domain", () => ({ resolveBulkSender }));

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const SENDERS: Record<string, string> = {
  [TENANT_A]: "Hello@Acme-Shop.com",
  [TENANT_B]: "news@rival-store.com",
};

const readSender = vi.fn(async (tenantId: string) => (SENDERS[tenantId] ? { from_address: SENDERS[tenantId] } : null));

const scrub = (text: string, keepEmails: readonly string[] | undefined, agentSlug = "email_marketing") =>
  scrubAgentEgress(text, { surface: "chat", agentSlug, scrubPii: true, keepEmails }).text;

describe("email_marketing keeps the workspace's own verified sender, nothing else", () => {
  it("keeps the tenant's sender and still redacts a customer address in the same reply", async () => {
    readSender.mockClear();
    const keep = await runEmailAllowlist("email_marketing", TENANT_A, [], readSender);
    expect(readSender).toHaveBeenCalledTimes(1);
    expect(readSender).toHaveBeenCalledWith(TENANT_A);
    expect(keep).toEqual(["hello@acme-shop.com"]);
    const out = scrub("Sends go from hello@acme-shop.com. Jane (jane.doe@gmail.com) replied asking to unsubscribe.", keep);
    expect(out).toBe("Sends go from hello@acme-shop.com. Jane ([redacted]) replied asking to unsubscribe.");
  });

  it("keeps the sender in any letter case and in a mailto link", async () => {
    const keep = await runEmailAllowlist("email_marketing", TENANT_A, [], readSender);
    expect(scrub("[HELLO@ACME-SHOP.COM](mailto:Hello@Acme-Shop.com)", keep)).toBe("[HELLO@ACME-SHOP.COM](mailto:Hello@Acme-Shop.com)");
  });

  it("redacts another tenant's sender address", async () => {
    const keep = await runEmailAllowlist("email_marketing", TENANT_A, [], readSender);
    expect(scrub("Sends go from hello@acme-shop.com, not news@rival-store.com.", keep)).toBe(
      "Sends go from hello@acme-shop.com, not [redacted].",
    );
    const keepB = await runEmailAllowlist("email_marketing", TENANT_B, [], readSender);
    expect(scrub("Sends go from hello@acme-shop.com.", keepB)).toBe("Sends go from [redacted].");
  });

  it("never keeps an address the owner typed, a near match, or a lookalike domain", async () => {
    const owner = ownerEmailAllowlist(
      { owner_turn_texts: ownerTextsFromRows([{ sender_role: "user", body: "send it to broker@example-agency.com" }], null) },
      "chat",
    );
    expect(owner).toEqual(["broker@example-agency.com"]);
    const keep = await runEmailAllowlist("email_marketing", TENANT_A, owner, readSender);
    expect(keep).toEqual(["hello@acme-shop.com"]);
    for (const addr of [
      "broker@example-agency.com",
      "hello@acme-shop.co",
      "xhello@acme-shop.com",
      "hello@acme-shop.com.evil.io",
      "hello@sub.acme-shop.com",
      "sales@acme-shop.com",
    ]) {
      expect(scrub(`from ${addr}`, keep)).toBe("from [redacted]");
    }
  });

  it("the sender in a percent-encoded or bracket-obfuscated form is always redacted", async () => {
    const keep = await runEmailAllowlist("email_marketing", TENANT_A, [], readSender);
    expect(scrub("https://x.example.com/u?from=hello%40acme-shop.com&y=1", keep)).toBe("https://x.example.com/u?from=[redacted]&y=1");
    expect(scrub("hello [at] acme-shop [dot] com", keep)).toBe("[redacted]");
    expect(scrub("hello(at)acme-shop.com", keep)).toBe("[redacted]");
  });

  it("a character-reference encoded sender renders as the kept sender, a char-ref customer address is redacted", async () => {
    const keep = await runEmailAllowlist("email_marketing", TENANT_A, [], readSender);
    expect(scrub("Sends go from hello&#64;acme-shop&#46;com", keep)).toBe("Sends go from hello&#64;acme-shop&#46;com");
    const out = scrub("Sends go from hello&#64;acme-shop&#46;com; reply from jane&#64;gmail&#46;com", keep);
    expect(out).toBe("Sends go from hello@acme-shop.com; reply from [redacted]");
  });

  it("a failed sender read keeps nothing, so the sender is redacted", async () => {
    const failing = vi.fn(async () => {
      throw new Error("sending_domain_read_failed");
    });
    const keep = await runEmailAllowlist("email_marketing", TENANT_A, ["broker@example-agency.com"], failing);
    expect(failing).toHaveBeenCalledWith(TENANT_A);
    expect(keep).toEqual([]);
    expect(scrub("Sends go from hello@acme-shop.com", keep)).toBe("Sends go from [redacted]");
  });

  it("no verified sender, a malformed sender, or no tenant keeps nothing", async () => {
    for (const row of [null, {}, { from_address: null }, { from_address: 7 }, { from_address: "a@b.com c@d.com" }, { from_address: "not an email" }]) {
      expect(await runEmailAllowlist("email_marketing", TENANT_A, ["broker@example-agency.com"], async () => row)).toEqual([]);
    }
    const spy = vi.fn(readSender);
    expect(await runEmailAllowlist("email_marketing", undefined, ["broker@example-agency.com"], spy)).toEqual([]);
    expect(await runEmailAllowlist("email_marketing", "", [], spy)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still scrubs phones, cards and SSNs alongside the kept sender", async () => {
    const keep = await runEmailAllowlist("email_marketing", TENANT_A, [], readSender);
    const out = scrub("From hello@acme-shop.com, call 415-555-0134, SSN 123-45-6789", keep);
    expect(out).toContain("hello@acme-shop.com");
    expect(out).not.toContain("415-555-0134");
    expect(out).not.toContain("123-45-6789");
  });
});

describe("every other agent behaves as before", () => {
  it("never reads a sender and passes the owner list through unchanged", async () => {
    const spy = vi.fn(readSender);
    for (const slug of ["cgo", "pm", "growth-lead", "support-lead", undefined]) {
      expect(await runEmailAllowlist(slug, TENANT_A, ["broker@example-agency.com"], spy)).toEqual(["broker@example-agency.com"]);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("a PII agent other than cgo or email_marketing redacts the tenant sender even when handed it", () => {
    for (const slug of ["pm", "growth-lead", "support-lead", "chief-of-staff"]) {
      expect(keptEmailsFor(slug, ["hello@acme-shop.com"])).toBeUndefined();
      expect(scrub("Sends go from hello@acme-shop.com", ["hello@acme-shop.com"], slug)).toBe("Sends go from [redacted]");
    }
  });

  it("email_marketing with no list stamped redacts every address", () => {
    expect(scrub("Sends go from hello@acme-shop.com", undefined)).toBe("Sends go from [redacted]");
    expect(scrub("Sends go from hello@acme-shop.com", [])).toBe("Sends go from [redacted]");
  });
});

describe("the default reader is the tenant's own verified bulk sender", () => {
  it("reads resolveBulkSender for the run's tenant only, and fails closed when it throws", async () => {
    resolveBulkSender.mockReset();
    resolveBulkSender.mockImplementation(async (t: string) =>
      t === TENANT_A ? { domain: "acme-shop.com", from_address: "hello@acme-shop.com", from_name: null } : null,
    );
    expect(await runEmailAllowlist("email_marketing", TENANT_A, [])).toEqual(["hello@acme-shop.com"]);
    expect(resolveBulkSender).toHaveBeenLastCalledWith(TENANT_A);
    expect(await runEmailAllowlist("email_marketing", TENANT_B, [])).toEqual([]);
    expect(resolveBulkSender).toHaveBeenLastCalledWith(TENANT_B);
    resolveBulkSender.mockRejectedValueOnce(new Error("We could not read your sending domain. Try again."));
    const keep = await runEmailAllowlist("email_marketing", TENANT_A, []);
    expect(keep).toEqual([]);
    expect(scrub("Sends go from hello@acme-shop.com", keep)).toBe("Sends go from [redacted]");
    expect(resolveBulkSender.mock.calls.every(([t]) => t === TENANT_A || t === TENANT_B)).toBe(true);
  });
});
