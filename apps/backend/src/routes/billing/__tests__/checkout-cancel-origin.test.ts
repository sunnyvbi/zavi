
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  createSession: vi.fn(),
  createPortal: vi.fn(),
  subRow: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(mocks.subRow),
      };
      return chain;
    },
  }),
}));
vi.mock("@/services/billing/client", () => ({
  billingStripe: () => ({
    checkout: { sessions: { create: mocks.createSession } },
    billingPortal: { sessions: { create: mocks.createPortal } },
  }),
}));
vi.mock("@/services/billing/portal-config", () => ({ planChangePortalConfiguration: async () => "bpc_zavi" }));

import { billingCheckout } from "../checkout";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}

const TENANT = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT });
  mocks.subRow = { data: null, error: null };
  mocks.createSession.mockResolvedValue({ url: "https://checkout.stripe.test/s" });
  process.env.PRAXIS_PUBLIC_BASE = "https://www.zaviagent.com";
  process.env.STRIPE_PRICE_STARTER_MONTHLY = "price_starter";
});

async function runWith(body: Record<string, unknown>) {
  const res = mockRes();
  await billingCheckout({ body } as never, res as never);
  return mocks.createSession.mock.calls[0]?.[0] as { cancel_url?: string } | undefined;
}

describe("checkout cancel_url origin", () => {
  it("origin=workspace returns to workspace settings, not marketing pricing", async () => {
    const args = await runWith({ tier: "starter", origin: "workspace" });
    expect(args?.cancel_url).toBe(
      "https://www.zaviagent.com/workspace?tab=settings&billing=cancel",
    );
  });

  it("absent origin keeps the existing /pricing behaviour", async () => {
    const args = await runWith({ tier: "starter" });
    expect(args?.cancel_url).toBe("https://www.zaviagent.com/pricing?billing=cancel");
  });

  it("origin=pricing is explicit /pricing", async () => {
    const args = await runWith({ tier: "starter", origin: "pricing" });
    expect(args?.cancel_url).toBe("https://www.zaviagent.com/pricing?billing=cancel");
  });

  const HOSTILE: { label: string; origin: unknown }[] = [
    { label: "an absolute URL", origin: "https://evil.test" },
    { label: "a traversal", origin: "../../evil" },
    { label: "a near-miss with query injection", origin: "workspace&x=1" },
    { label: "a non-string object", origin: { toString: (): string => "workspace" } },
    { label: "null", origin: null },
    { label: "a prototype key", origin: "constructor" },
  ];
  it.each(HOSTILE)("rejects $label and falls back to /pricing", async ({ origin }) => {
    const args = await runWith({ tier: "starter", origin });
    expect(args?.cancel_url).toBe("https://www.zaviagent.com/pricing?billing=cancel");
  });
});
