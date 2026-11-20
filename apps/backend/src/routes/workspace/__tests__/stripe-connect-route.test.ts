import { describe, it, expect, vi, beforeEach } from "vitest";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";

let AUTH: { user_id: string; tenant_id: string; access_token: string } | null = {
  user_id: "u1",
  tenant_id: "t1",
  access_token: "tok",
};
let ROLE: string | null = "owner";
let CONNECTED_ACCT: string | null = null;
let ENSURE_IMPL: () => Promise<unknown> = async () => ({
  external_ref: { stripe_account_id: "acct_new", onboarding_url: "https://kyc/new" },
  vault_keys: {},
});

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (!AUTH) {
      res.status(401).json({ error: { code: "unauthorized" } });
      return null;
    }
    return AUTH;
  },
}));

vi.mock("@/services/auth/tenant-role", () => ({
  loadTenantRole: async () => ROLE,
  requireTenantRole: async (
    _auth: unknown,
    allowed: readonly string[],
    res: { status: (n: number) => { json: (b: unknown) => void } },
  ) => {
    if (!ROLE || !allowed.includes(ROLE)) {
      res.status(403).json({ error: { code: "forbidden" } });
      return false;
    }
    return true;
  },
}));

const setTenantResource = vi.fn(async () => ({ error: null }));
const rpcMoneyModel = vi.fn(async () => ({ error: null }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: setTenantResource }),
  serverClientFromBearer: () => ({ rpc: rpcMoneyModel }),
}));

vi.mock("@/services/tools/stripe/_platform-client", () => ({
  resolveConnectedAccountId: async () => CONNECTED_ACCT,
}));

vi.mock("@/services/tools/stripe/payout-account", () => ({
  resolvePayoutAccountState: async () => ({
    rail_enabled: true,
    money_model: "path_b",
    account: null,
    state: "no_account",
  }),
}));

vi.mock("@/services/tools/stripe/onboarding-link", () => ({
  createOnboardingLink: async () => "https://kyc/fresh",
}));

vi.mock("@/services/provisioning/stripe-connect", () => ({
  createStripeConnectProvisioner: () => ({
    provider: "stripe-connect",
    ensure: ENSURE_IMPL,
  }),
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));

import {
  getStripePayoutAccount,
  postStripePayoutAccount,
  postStripeOnboardingLink,
  postStripeMoneyModel,
} from "../stripe-connect";

function mockRes() {
  const out: { code: number; body: unknown } = { code: 200, body: undefined };
  const res = {
    status(n: number) {
      out.code = n;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  };
  return { res: res as never, out };
}

beforeEach(() => {
  AUTH = { user_id: "u1", tenant_id: "t1", access_token: "tok" };
  ROLE = "owner";
  CONNECTED_ACCT = null;
  ENSURE_IMPL = async () => ({
    external_ref: { stripe_account_id: "acct_new", onboarding_url: "https://kyc/new" },
    vault_keys: {},
  });
  setTenantResource.mockClear();
  rpcMoneyModel.mockClear();
});

describe("getStripePayoutAccount", () => {
  it("returns state + role + can_write for a member", async () => {
    ROLE = "member";
    const { res, out } = mockRes();
    await getStripePayoutAccount({} as never, res);
    expect(out.code).toBe(200);
    expect(out.body).toMatchObject({ state: "no_account", role: "member", can_write: false });
  });

  it("can_write true for owner", async () => {
    ROLE = "owner";
    const { res, out } = mockRes();
    await getStripePayoutAccount({} as never, res);
    expect(out.body).toMatchObject({ can_write: true });
  });
});

describe("postStripePayoutAccount", () => {
  it("403s a non-owner/admin member (money path is owner/admin only)", async () => {
    ROLE = "member";
    const { res, out } = mockRes();
    await postStripePayoutAccount({ body: { company_name: "Acme" } } as never, res);
    expect(out.code).toBe(403);
    expect(setTenantResource).not.toHaveBeenCalled();
  });

  it("creates a new account for an owner and persists it", async () => {
    const { res, out } = mockRes();
    await postStripePayoutAccount({ body: { company_name: "Acme" } } as never, res);
    expect(out.code).toBe(200);
    expect(out.body).toMatchObject({ created: true, account_id: "acct_new", onboarding_url: "https://kyc/new" });
    expect(setTenantResource).toHaveBeenCalledWith("set_tenant_resource", expect.objectContaining({
      p_resource_kind: "stripe",
      p_mode: "provisioned",
      p_status: "ready",
    }));
  });

  it("is idempotent: an existing account is never duplicated", async () => {
    CONNECTED_ACCT = "acct_existing";
    const { res, out } = mockRes();
    await postStripePayoutAccount({ body: { company_name: "Acme" } } as never, res);
    expect(out.body).toMatchObject({ created: false, account_id: "acct_existing", state: "exists" });
    expect(setTenantResource).not.toHaveBeenCalled();
  });

  it("rail gated off → clean rail_disabled 200, not a 500", async () => {
    ENSURE_IMPL = async () => {
      throw new CredentialNotConfigured("STRIPE_PROVISIONING_ENABLED");
    };
    const { res, out } = mockRes();
    await postStripePayoutAccount({ body: { company_name: "Acme" } } as never, res);
    expect(out.code).toBe(200);
    expect(out.body).toMatchObject({ created: false, state: "rail_disabled" });
  });

  it("Stripe rejects create (e.g. Connect off) → 502 with a clean one-line reason, not a raw 500 blob", async () => {
    ENSURE_IMPL = async () => {
      throw new Error(
        'stripe account create failed (400): {\n "error": {\n "message": "You can only create new accounts if you have signed up for Connect.",\n "type": "invalid_request_error"\n }\n}',
      );
    };
    const { res, out } = mockRes();
    await postStripePayoutAccount({ body: { company_name: "Acme" } } as never, res);
    expect(out.code).toBe(502);
    expect(out.body).toMatchObject({
      error: {
        code: "stripe_create_failed",
        message: "You can only create new accounts if you have signed up for Connect.",
      },
    });
  });
});

describe("postStripeOnboardingLink", () => {
  it("400s when no account exists yet", async () => {
    CONNECTED_ACCT = null;
    const { res, out } = mockRes();
    await postStripeOnboardingLink({ body: {} } as never, res);
    expect(out.code).toBe(400);
    expect(out.body).toMatchObject({ error: { code: "no_account" } });
  });

  it("returns a fresh onboarding link for an existing account", async () => {
    CONNECTED_ACCT = "acct_z";
    const { res, out } = mockRes();
    await postStripeOnboardingLink({ body: {} } as never, res);
    expect(out.body).toMatchObject({ onboarding_url: "https://kyc/fresh" });
  });
});

describe("postStripeMoneyModel", () => {
  it("rejects an invalid money_model", async () => {
    const { res, out } = mockRes();
    await postStripeMoneyModel({ body: { money_model: "path_c" } } as never, res);
    expect(out.code).toBe(400);
    expect(rpcMoneyModel).not.toHaveBeenCalled();
  });

  it("403s a non-owner/admin member", async () => {
    ROLE = "member";
    const { res, out } = mockRes();
    await postStripeMoneyModel({ body: { money_model: "path_a" } } as never, res);
    expect(out.code).toBe(403);
    expect(rpcMoneyModel).not.toHaveBeenCalled();
  });

  it("sets money_model via the bearer client RPC", async () => {
    const { res, out } = mockRes();
    await postStripeMoneyModel({ body: { money_model: "path_b" } } as never, res);
    expect(out.body).toMatchObject({ money_model: "path_b" });
    expect(rpcMoneyModel).toHaveBeenCalledWith("set_tenant_money_model", {
      p_tenant_id: "t1",
      p_money_model: "path_b",
    });
  });
});
