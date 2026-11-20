import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flag: vi.fn(),
  blob: {} as Record<string, unknown> | "error",
  tenant: { id: "t", deleted_at: null } as Record<string, unknown> | null,
  sender: null as null | Record<string, unknown>,
  settings: { fields: {} } as Record<string, unknown> | "error",
  list: null as null | Record<string, unknown>,
  version: null as null | Record<string, unknown>,
  hold: null as null | Record<string, unknown>,
  template: null as null | Record<string, unknown> | "error",
  recheck: vi.fn(async (_t: string) => {}),
}));

vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: (...a: unknown[]) => mocks.flag(...a) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
}));
vi.mock("../sending-domain", () => ({
  resolveBulkSender: async () => mocks.sender,
  recheckSendingDomainIfStale: (t: string) => mocks.recheck(t),
}));
vi.mock("@/services/tenant-client", () => {
  const table = (name: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => {
        if (name === "system_config") return mocks.blob === "error" ? { data: null, error: { message: "x" } } : { data: { blob: mocks.blob }, error: null };
        if (name === "tenants") return { data: mocks.tenant, error: null };
        if (name === "email_lists") return { data: mocks.list, error: null };
        if (name === "email_list_versions") return { data: mocks.version, error: null };
        if (name === "email_bulk_abuse_holds") return { data: mocks.hold, error: null };
        if (name === "email_templates") return mocks.template === "error" ? { data: null, error: { message: "x" } } : { data: mocks.template, error: null };
        return { data: null, error: null };
      },
    };
    return b;
  };
  return {
    asTenantId: (t: string) => t,
    globalClient: () => ({ from: table }),
    tenantClient: () => ({ from: table }),
    tenantRpc: async () => (mocks.settings === "error" ? { data: null, error: { message: "x" } } : { data: mocks.settings, error: null }),
  };
});

import { BULK_REFUSAL_SENTENCES, checkBulkReady, checkBulkSender, checkListVersion, readPostalAddress } from "../readiness";
import { bulkTextBody } from "../wire";
import { holdSentence } from "../notices";

const template = (postal_address: string | null) => ({
  logo_url: null,
  brand_color: "#111111",
  button_color: "#222222",
  font_key: "system",
  sign_off: "",
  postal_address,
  show_cards: false,
  updated_by: null,
  updated_at: "2026-10-01T00:00:00Z",
});

const KEYS = ["BULK_SENDGRID_API_KEY", "SYSTEM_SENDGRID_API_KEY", "PROVISION_EMAIL_SENDGRID_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.BULK_SENDGRID_API_KEY = "bulk-key";
  mocks.flag.mockReset().mockResolvedValue(true);
  mocks.blob = {};
  mocks.tenant = { id: "t", deleted_at: null };
  mocks.sender = { domain: "acme.com", from_address: "hello@acme.com", from_name: null };
  mocks.settings = { fields: {} };
  mocks.list = { id: "L", name: "Newsletter", archived_at: null };
  mocks.version = { id: "V", list_id: "L", consent_confirmed_at: "2026-10-07T00:00:00Z" };
  mocks.hold = null;
  mocks.template = template(" 1 Main St ");
  mocks.recheck.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("checkBulkSender", () => {
  it("is ready with the switch on, the key set, a verified domain and a postal address", async () => {
    expect(await checkBulkSender("t")).toEqual({
      ok: true,
      sender: { domain: "acme.com", from_address: "hello@acme.com", from_name: null },
      postal_address: "1 Main St",
    });
    expect(mocks.flag).toHaveBeenCalledWith("bulk_outbound_enabled", "t");
  });

  it("an abuse hold refuses even with the switch still on; a cleared hold does not", async () => {
    mocks.hold = { reason: "abuse_complaints", cleared_at: null };
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_abuse_hold" });
    mocks.hold = { reason: "abuse_complaints", cleared_at: "2026-10-08T00:00:00Z" };
    expect((await checkBulkSender("t")).ok).toBe(true);
  });

  it("after the abuse shutoff flipped the switch off, an open hold still reads as the spam pause, not a plain switch-off", async () => {
    mocks.flag.mockResolvedValue(false);
    mocks.hold = { reason: "abuse_complaints", cleared_at: null };
    const r = await checkBulkSender("t");
    expect(r).toMatchObject({ ok: false, code: "bulk_abuse_hold" });
    expect(r.ok === false && r.sentence).toMatch(/^Bulk email is paused for this workspace/);
    mocks.hold = { reason: "abuse_complaints", cleared_at: "2026-10-08T00:00:00Z" };
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_outbound_disabled" });
    mocks.hold = null;
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_outbound_disabled" });
  });

  it("re-checks a stale verified domain with the provider before using it", async () => {
    await checkBulkSender("t");
    expect(mocks.recheck).toHaveBeenCalledWith("t");
  });

  it("the switch off for this workspace", async () => {
    mocks.flag.mockResolvedValue(false);
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_outbound_disabled", sentence: "Bulk email is switched off for this workspace." });
  });

  it("the global stop", async () => {
    mocks.blob = { bulk_email_send_enabled: false };
    const stopped = await checkBulkSender("t");
    expect(stopped).toMatchObject({ ok: false, code: "bulk_sending_paused" });
    expect(stopped.ok ? "" : stopped.sentence).toMatch(/^Zavi's own sender is stopped for every workspace right now/);
    expect(stopped.ok ? "" : stopped.sentence).not.toMatch(/Zavi sender stopped/);
    expect(stopped.ok ? "" : stopped.sentence).not.toMatch(/paused for everyone/i);
    mocks.blob = { bulk_email_send_enabled: "false" };
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_sending_paused" });
    mocks.blob = { bulk_email_send_enabled: "off" };
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_sending_paused" });
    mocks.blob = { bulk_email_send_enabled: "true" };
    expect((await checkBulkSender("t")).ok).toBe(true);
  });

  it("the bulk key unset refuses, even with the system and provisioning keys present", async () => {
    delete process.env.BULK_SENDGRID_API_KEY;
    process.env.SYSTEM_SENDGRID_API_KEY = "system-key";
    process.env.PROVISION_EMAIL_SENDGRID_API_KEY = "provision-key";
    expect(await checkBulkSender("t")).toEqual({ ok: false, code: "bulk_sender_not_configured", sentence: "Bulk email is not set up yet." });
    process.env.BULK_SENDGRID_API_KEY = "   ";
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_sender_not_configured" });
  });

  it("no verified domain, no postal address, a closed workspace", async () => {
    mocks.sender = null;
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "sending_domain_not_verified" });
    mocks.sender = { domain: "acme.com", from_address: "hello@acme.com", from_name: null };
    mocks.template = template(null);
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "postal_address_missing" });
    mocks.template = template("1 Main St");
    mocks.tenant = { id: "t", deleted_at: "2026-10-01T00:00:00Z" };
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "workspace_closed" });
  });

  it("fails closed when a read fails", async () => {
    mocks.flag.mockRejectedValue(new Error("db down"));
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_check_failed" });
    mocks.flag.mockResolvedValue(true);
    mocks.blob = "error";
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_sending_paused" });
    mocks.blob = {};
    mocks.template = "error";
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_check_failed" });
  });

  it("reads the template's postal address, trimmed and capped at 500", async () => {
    mocks.template = template(`  ${"A".repeat(600)}  `);
    expect(await readPostalAddress("t")).toBe("A".repeat(500));
  });
});

describe("checkListVersion", () => {
  it("passes for a consented version of a list that is not archived", async () => {
    expect(await checkListVersion("t", "L", "V")).toEqual({ ok: true, list_name: "Newsletter" });
  });

  it("refuses a missing list, an archived list, a version not on that list and a version with no consent", async () => {
    mocks.list = null;
    expect(await checkListVersion("t", "L", "V")).toMatchObject({ ok: false, code: "list_not_found" });
    mocks.list = { id: "L", name: "N", archived_at: "2026-10-07T00:00:00Z" };
    expect(await checkListVersion("t", "L", "V")).toMatchObject({ ok: false, code: "list_archived" });
    mocks.list = { id: "L", name: "N", archived_at: null };
    mocks.version = null;
    expect(await checkListVersion("t", "L", "V")).toMatchObject({ ok: false, code: "list_not_found" });
    mocks.version = { id: "V", list_id: "L", consent_confirmed_at: null };
    expect(await checkListVersion("t", "L", "V")).toEqual({ ok: false, code: "list_not_consented", sentence: BULK_REFUSAL_SENTENCES.list_not_consented });
  });

  it("checkBulkReady stops at the first refusal", async () => {
    mocks.flag.mockResolvedValue(false);
    mocks.list = null;
    expect(await checkBulkReady("t", "L", "V")).toMatchObject({ ok: false, code: "bulk_outbound_disabled" });
    mocks.flag.mockResolvedValue(true);
    expect(await checkBulkReady("t", "L", "V")).toMatchObject({ ok: false, code: "list_not_found" });
  });
});

describe("the postal address comes from the email template, and from the old setting only when no template is saved", () => {
  it("readiness and the plain-text part use the template's address over the old channel setting", async () => {
    mocks.template = template("9 Template Rd\nSpringfield");
    mocks.settings = { fields: { postal_address: [{ item: "1 Main St" }] } };
    const ready = await checkBulkReady("t", "L", "V");
    expect(ready).toMatchObject({ ok: true, postal_address: "9 Template Rd\nSpringfield" });
    const text = bulkTextBody("Hello", (ready as { postal_address: string }).postal_address, "11111111-1111-4111-8111-111111111111");
    expect(text).toContain("9 Template Rd\nSpringfield");
    expect(text).not.toContain("1 Main St");
  });

  it("passes with only the template address and never reads the channel setting", async () => {
    mocks.settings = "error";
    expect(await checkBulkSender("t")).toMatchObject({ ok: true, postal_address: "1 Main St" });
    expect(await readPostalAddress("t")).toBe("1 Main St");
  });

  it("a saved template with an empty address wins over the old channel setting", async () => {
    mocks.settings = { fields: { postal_address: [{ item: "1 Main St" }] } };
    for (const t of [template("   "), template(null), template("")]) {
      mocks.template = t;
      expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "postal_address_missing" });
      expect(await checkBulkReady("t", "L", "V")).toMatchObject({ ok: false, code: "postal_address_missing" });
      expect(await readPostalAddress("t")).toBeNull();
    }
  });

  it("a workspace with no template row falls back to the old channel setting", async () => {
    mocks.template = null;
    mocks.settings = { fields: { postal_address: [{ item: "  1 Main St  ", status: "dismissed" }, { item: "  2 Old Rd  " }] } };
    expect(await readPostalAddress("t")).toBe("2 Old Rd");
    const ready = await checkBulkReady("t", "L", "V");
    expect(ready).toMatchObject({ ok: true, postal_address: "2 Old Rd" });
    expect(bulkTextBody("Hello", (ready as { postal_address: string }).postal_address, "11111111-1111-4111-8111-111111111111")).toContain("2 Old Rd");
  });

  it("no template row and no setting refuses; no template row and an unreadable setting fails closed", async () => {
    mocks.template = null;
    mocks.settings = { fields: {} };
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "postal_address_missing" });
    mocks.settings = "error";
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_check_failed" });
    await expect(readPostalAddress("t")).rejects.toThrow();
  });

  it("a template with an address is used even when the old setting differs", async () => {
    mocks.template = template("9 Template Rd");
    mocks.settings = { fields: { postal_address: [{ item: "1 Main St" }] } };
    expect(await readPostalAddress("t")).toBe("9 Template Rd");
  });

  it("neither set refuses; a template that cannot be read fails closed", async () => {
    mocks.template = template(null);
    mocks.settings = { fields: {} };
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "postal_address_missing" });
    mocks.template = "error";
    mocks.settings = { fields: { postal_address: [{ item: "1 Main St" }] } };
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "bulk_check_failed" });
  });

  it("refuses a placeholder postal address at every gate, in plain words, and still sends a real one", async () => {
    mocks.settings = "error";
    for (const placeholder of ["123 Main St, Anytown, USA", "Your business address", "XXXX", "123 Fake Street", "City, State ZIP", "TBD", "12345"]) {
      mocks.template = template(placeholder);
      const sender = await checkBulkSender("t");
      expect(sender).toMatchObject({ ok: false, code: "postal_address_placeholder" });
      expect(await checkBulkReady("t", "L", "V")).toMatchObject({ ok: false, code: "postal_address_placeholder" });
      expect((sender as { sentence: string }).sentence).toBe(BULK_REFUSAL_SENTENCES.postal_address_placeholder);
    }
    mocks.template = null;
    mocks.settings = { fields: { postal_address: [{ item: "123 Main St, Anytown" }] } };
    expect(await checkBulkSender("t")).toMatchObject({ ok: false, code: "postal_address_placeholder" });
    expect(BULK_REFUSAL_SENTENCES.postal_address_placeholder).not.toMatch(/_|placeholder_/);
    expect(holdSentence("postal_address_placeholder")).toBe("your business postal address in Email campaigns settings is still a placeholder");
    for (const real of ["1 Main St", "500 Howard St, San Francisco, CA 94105", "Flat 2, 10 Downing Street, London SW1A 2AA", "Cakely Bakery, 2200 W Sample Rd, Pompano Beach, FL 33073", "1800 East Sample Road, Lighthouse Point, FL 33064"]) {
      mocks.template = template(real);
      expect(await checkBulkReady("t", "L", "V")).toMatchObject({ ok: true, postal_address: real });
    }
  });
});
