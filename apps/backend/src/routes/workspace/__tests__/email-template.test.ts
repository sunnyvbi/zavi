import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: { value: "owner" as string | null },
  stored: { row: null as Record<string, unknown> | null },
  upserts: [] as Array<{ table: string; row: Record<string, unknown>; opts: unknown }>,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: mocks.role.value ? { role: mocks.role.value } : null, error: null }),
  };
  return { serviceClient: () => ({ from: () => chain }) };
});
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: () => ({
    from: (table: string) => ({
      select: () => ({ maybeSingle: async () => ({ data: mocks.stored.row, error: null }) }),
      upsert: (row: Record<string, unknown>, opts: unknown) => {
        mocks.upserts.push({ table, row, opts });
        mocks.stored.row = row;
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      },
    }),
  }),
}));

import { getEmailTemplateHandler, putEmailTemplateHandler, draftEmailTemplateWith } from "../email-template";

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

const VALID = {
  logo_url: "https://cdn.brightloop.test/logo.png",
  brand_color: "#1A73E8",
  button_color: "#ff6b35",
  font_key: "georgia",
  sign_off: "Thanks,\nThe Brightloop team",
  postal_address: "12 Example Street",
  show_cards: true,
};

beforeEach(() => {
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-brightloop", user_id: "u-1" });
  mocks.role.value = "owner";
  mocks.stored.row = null;
  mocks.upserts.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function put(body: unknown) {
  const res = mockRes();
  await putEmailTemplateHandler({ body } as any, res as any);
  return res;
}

describe("email-template routes", () => {
  it("GET: a member reads (null when none saved) and cannot edit", async () => {
    mocks.role.value = "member";
    const res = mockRes();
    await getEmailTemplateHandler({} as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ template: null, can_edit: false });
    expect(res.body.fonts).toContain("system");
  });

  it("GET: unauthenticated stops at requireAuth", async () => {
    mocks.requireAuth.mockResolvedValue(null);
    const res = mockRes();
    await getEmailTemplateHandler({} as any, res as any);
    expect(res.body).toBeUndefined();
  });

  it("PUT: member gets 403 and nothing is written", async () => {
    mocks.role.value = "member";
    const res = await put(VALID);
    expect(res.statusCode).toBe(403);
    expect(mocks.upserts).toHaveLength(0);
  });

  it("PUT: admin saves, tenant from session, colors lower-cased", async () => {
    mocks.role.value = "admin";
    const res = await put(VALID);
    expect(res.statusCode).toBe(200);
    expect(mocks.upserts[0]).toMatchObject({ table: "email_templates", opts: { onConflict: "tenant_id" } });
    expect(mocks.upserts[0].row).toMatchObject({ tenant_id: "tnt-brightloop", brand_color: "#1a73e8", updated_by: "u-1" });
    expect(res.body.template.font_key).toBe("georgia");
  });

  it("PUT: refuses bad values and unknown keys with a sentence", async () => {
    for (const body of [
      { ...VALID, brand_color: "red;background:url(x)" },
      { ...VALID, font_key: "comic" },
      { ...VALID, logo_url: "javascript:alert(1)" },
      { ...VALID, logo_url: "http://cdn.brightloop.test/logo.png" },
      { ...VALID, html: "<script>" },
      { ...VALID, tenant_id: "other-tenant" },
    ]) {
      const res = await put(body);
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe("invalid_template");
      expect(typeof res.body.error.message).toBe("string");
    }
    expect(mocks.upserts).toHaveLength(0);
  });

  it("PUT: refuses an overridden (staff) workspace", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-brightloop", user_id: "u-1", tenant_overridden: true });
    const res = await put(VALID);
    expect(res.statusCode).toBe(403);
  });

  it("draft: member 403; owner gets a draft and nothing is saved", async () => {
    const draft = draftEmailTemplateWith({
      brand: async () => null,
      logoUrl: async () => null,
      postalAddress: async () => "PO Box 7, Lakeside",
    });
    mocks.role.value = "member";
    let res = mockRes();
    await draft({} as any, res as any);
    expect(res.statusCode).toBe(403);

    mocks.role.value = "owner";
    res = mockRes();
    await draft({} as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.draft).toMatchObject({ logo_url: null, postal_address: "PO Box 7, Lakeside", font_key: "system" });
    expect(mocks.upserts).toHaveLength(0);
  });
});
