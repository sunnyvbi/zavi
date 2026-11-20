
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  createCreatorExpressLoginLink,
  createCreatorOnboardingLink,
  creatorTransfersActive,
  ensureCreatorPayoutAccount,
  refreshCreatorPayoutAccount,
  type CreatorPayoutAccountDeps,
} from "../payout-accounts";
import type { CreatorPayoutAccountRow } from "../db";

const CREATOR = "33333333-3333-3333-3333-333333333333";

function harness(opts: { existing?: CreatorPayoutAccountRow | null; livemode?: boolean } = {}) {
  const stripe = {
    accounts: {
      create: vi.fn<any[], any>(async () => ({
        id: "acct_new",
        details_submitted: false,
        payouts_enabled: false,
        capabilities: { card_payments: "inactive", transfers: "inactive" },
      })),
      retrieve: vi.fn<any[], any>(async () => ({
        id: "acct_new",
        details_submitted: true,
        payouts_enabled: true,
        capabilities: { transfers: "active" },
        requirements: { disabled_reason: null },
      })),
      createLoginLink: vi.fn<any[], any>(async () => ({
        url: "https://connect.stripe.com/express/login",
      })),
    },
    accountLinks: {
      create: vi.fn<any[], any>(async () => ({ url: "https://connect.stripe.com/setup/x" })),
    },
  };
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  let existing = opts.existing ?? null;

  const deps: CreatorPayoutAccountDeps = {
    stripe: () => stripe as unknown as Stripe,
    livemode: () => opts.livemode ?? false,
    loadAccount: async () => existing,
    insertAccount: async (row) => {
      inserted.push(row);
      return "inserted";
    },
    updateFlags: async (args) => {
      updated.push(args);
    },
    publicBase: () => "https://www.zaviagent.com",
  };

  return {
    deps,
    stripe,
    inserted,
    updated,
    setExisting: (row: CreatorPayoutAccountRow | null) => {
      existing = row;
    },
  };
}

describe("ensureCreatorPayoutAccount", () => {
  it("creates an Express account with EXACTLY the config the spike proved", async () => {
    const h = harness();
    const row = await ensureCreatorPayoutAccount(
      { human_member_id: CREATOR, country: "us", email: "creator@example.com" },
      h.deps,
    );

    const [params, options] = h.stripe.accounts.create.mock.calls[0];
    expect(params.country).toBe("US");
    expect(params.controller).toEqual({
      stripe_dashboard: { type: "express" },
      fees: { payer: "application" },
      losses: { payments: "application" },
    });
    expect(params.capabilities).toEqual({
      card_payments: { requested: true },
      transfers: { requested: true },
    });
    expect(params.email).toBe("creator@example.com");
    expect(options).toEqual({ idempotencyKey: `cr-acct-${CREATOR}-test` });

    expect(h.inserted).toEqual([
      {
        human_member_id: CREATOR,
        stripe_account_id: "acct_new",
        livemode: false,
        country: "US",
        details_submitted: false,
        payouts_enabled: false,
      },
    ]);
    expect(row.stripe_account_id).toBe("acct_new");
  });

  it("uses a live-mode idempotency key under a live key", async () => {
    const h = harness({ livemode: true });
    await ensureCreatorPayoutAccount({ human_member_id: CREATOR, country: "GB" }, h.deps);
    expect(h.stripe.accounts.create.mock.calls[0][1]).toEqual({
      idempotencyKey: `cr-acct-${CREATOR}-live`,
    });
  });

  it("returns the existing account without calling Stripe", async () => {
    const existing: CreatorPayoutAccountRow = {
      id: "pa1",
      human_member_id: CREATOR,
      stripe_account_id: "acct_old",
      livemode: false,
      country: "US",
      details_submitted: true,
      payouts_enabled: true,
      disabled_reason: null,
    };
    const h = harness({ existing });
    const row = await ensureCreatorPayoutAccount({ human_member_id: CREATOR, country: "US" }, h.deps);
    expect(row).toBe(existing);
    expect(h.stripe.accounts.create).not.toHaveBeenCalled();
  });

  it("re-reads the winner when a concurrent create won the unique row", async () => {
    const h = harness();
    const winner: CreatorPayoutAccountRow = {
      id: "pa_winner",
      human_member_id: CREATOR,
      stripe_account_id: "acct_winner",
      livemode: false,
      country: "US",
      details_submitted: false,
      payouts_enabled: false,
      disabled_reason: null,
    };
    const deps: CreatorPayoutAccountDeps = {
      ...h.deps,
      loadAccount: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner),
      insertAccount: async () => "duplicate",
    };
    const row = await ensureCreatorPayoutAccount({ human_member_id: CREATOR, country: "US" }, deps);
    expect(row).toBe(winner);
  });

  it("refuses a creator outside Stripe's payout reach (invariant 7)", async () => {
    const h = harness();
    await expect(
      ensureCreatorPayoutAccount({ human_member_id: CREATOR, country: "IN" }, h.deps),
    ).rejects.toThrowError(/outside Stripe's payout reach/);
    expect(h.stripe.accounts.create).not.toHaveBeenCalled();
  });
});

describe("onboarding + Express login links", () => {
  it("mints a hosted onboarding link back to the creator Earnings screen", async () => {
    const h = harness();
    const url = await createCreatorOnboardingLink("acct_new", h.deps);
    expect(url).toBe("https://connect.stripe.com/setup/x");
    expect(h.stripe.accountLinks.create).toHaveBeenCalledWith({
      account: "acct_new",
      type: "account_onboarding",
      refresh_url: "https://www.zaviagent.com/creator/earnings/stripe/refresh",
      return_url: "https://www.zaviagent.com/creator/earnings/stripe/return",
    });
  });

  it("mints an Express login link for the Earnings Tax forms button (T2)", async () => {
    const h = harness();
    const url = await createCreatorExpressLoginLink("acct_new", h.deps);
    expect(url).toBe("https://connect.stripe.com/express/login");
    expect(h.stripe.accounts.createLoginLink).toHaveBeenCalledWith("acct_new");
  });
});

describe("refreshCreatorPayoutAccount + creatorTransfersActive", () => {
  it("caches the live flags on the row", async () => {
    const h = harness();
    const status = await refreshCreatorPayoutAccount("acct_new", h.deps);
    expect(status).toEqual({
      stripe_account_id: "acct_new",
      details_submitted: true,
      payouts_enabled: true,
      transfers_active: true,
      disabled_reason: null,
      action_required: false,
    });
    expect(h.updated).toEqual([
      {
        stripe_account_id: "acct_new",
        details_submitted: true,
        payouts_enabled: true,
        disabled_reason: null,
        keepDisconnected: true,
      },
    ]);
  });

  it.each([
    [{ capabilities: { transfers: "active" } }, true],
    [{ capabilities: { transfers: "inactive" } }, false],
    [{ capabilities: { transfers: "pending" } }, false],
    [{ capabilities: {} }, false],
    [{}, false],
  ])("transfers capability %o -> active=%s", (account, expected) => {
    expect(creatorTransfersActive(account as { capabilities?: { transfers?: string } })).toBe(expected);
  });
});

describe("action_required: the creator still owes Stripe something", () => {
  it("is true when onboarding was left early (details not submitted)", async () => {
    const h = harness();
    h.stripe.accounts.retrieve.mockResolvedValueOnce({
      id: "acct_new", details_submitted: false, payouts_enabled: false,
      capabilities: { transfers: "inactive" }, requirements: { currently_due: [] },
    });
    expect((await refreshCreatorPayoutAccount("acct_new", h.deps)).action_required).toBe(true);
  });

  it("is true when Stripe asks for more after submission", async () => {
    const h = harness();
    h.stripe.accounts.retrieve.mockResolvedValueOnce({
      id: "acct_new", details_submitted: true, payouts_enabled: false,
      capabilities: { transfers: "pending" }, requirements: { currently_due: ["individual.verification.document"] },
    });
    expect((await refreshCreatorPayoutAccount("acct_new", h.deps)).action_required).toBe(true);
  });

  it("is false while Stripe is only confirming", async () => {
    const h = harness();
    h.stripe.accounts.retrieve.mockResolvedValueOnce({
      id: "acct_new", details_submitted: true, payouts_enabled: false,
      capabilities: { transfers: "pending" }, requirements: { currently_due: [], past_due: [] },
    });
    const s = await refreshCreatorPayoutAccount("acct_new", h.deps);
    expect(s.action_required).toBe(false);
    expect(s.transfers_active).toBe(false);
  });
});
