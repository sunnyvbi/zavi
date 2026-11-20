import { describe, it, expect, vi } from "vitest";
import {
  canonicalFirm,
  normalizeName,
  identityKey,
  materializeInvestors,
  type MaterializeInvestor,
} from "../materialize";

function makeStubClient() {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: "00000000-0000-0000-0000-000000000000", error: null };
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

describe("fundraising identityKey normalization", () => {
  it("is stable for a firm + partner name", () => {
    expect(identityKey("Boldstart Ventures", "Ed Sim")).toBe("boldstart|ed sim");
  });

  it("strips legal/common suffixes + punctuation; empty name yields trailing |", () => {
    expect(identityKey("Acme Capital, LLC", "")).toBe("acme|");
    expect(canonicalFirm("Acme Capital, LLC")).toBe("acme");
    expect(canonicalFirm("Sequoia Capital")).toBe("sequoia");
    expect(canonicalFirm("First Round Partners")).toBe("first round");
    expect(canonicalFirm("Foo VC")).toBe("foo");
    expect(canonicalFirm("Bar Inc")).toBe("bar");
  });

  it("is whitespace + case insensitive", () => {
    expect(identityKey("  BoldStart   Ventures ", " ED  sim ")).toBe(
      "boldstart|ed sim",
    );
    expect(normalizeName("  Ed   Sim ")).toBe("ed sim");
    expect(identityKey("boldstart ventures", "ed sim")).toBe(
      identityKey("Boldstart  VENTURES", "Ed   Sim"),
    );
  });

  it("two different firms do not collide", () => {
    expect(identityKey("Boldstart Ventures", "Ed Sim")).not.toBe(
      identityKey("Acme Capital", "Ed Sim"),
    );
  });

  it("overlay-match: a run row and a durable row with the same firm/name resolve to the SAME key", () => {
    const runRowKey = identityKey("Boldstart Ventures", "Ed Sim");
    const durableRowKey = identityKey("boldstart  ventures, LLC", " ED SIM ");
    expect(runRowKey).toBe(durableRowKey);
  });
});

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function inv(over: Partial<MaterializeInvestor>): MaterializeInvestor {
  return { firm: "Boldstart Ventures", name: "Ed Sim", ...over };
}

describe("materializeInvestors", () => {
  it("calls the upsert RPC once per investor with the stable identity_key", async () => {
    const { client, calls } = makeStubClient();
    const investors = [
      inv({ firm: "Boldstart Ventures", name: "Ed Sim" }),
      inv({ firm: "Acme Capital", name: "Jane Smith" }),
    ];
    await materializeInvestors(TENANT, investors, client);

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.fn === "fundraising_upsert_investor")).toBe(true);
    expect(calls[0].args.p_identity_key).toBe("boldstart|ed sim");
    expect(calls[1].args.p_identity_key).toBe("acme|jane smith");
  });

  it("re-running with the same input produces the SAME identity keys (dedup path)", async () => {
    const investors = [inv({}), inv({ firm: "Acme Capital", name: "Jane Smith" })];

    const run1 = makeStubClient();
    await materializeInvestors(TENANT, investors, run1.client);
    const run2 = makeStubClient();
    await materializeInvestors(TENANT, investors, run2.client);

    const keys1 = run1.calls.map((c) => c.args.p_identity_key);
    const keys2 = run2.calls.map((c) => c.args.p_identity_key);
    expect(keys2).toEqual(keys1);
    expect(keys1).toEqual(["boldstart|ed sim", "acme|jane smith"]);
  });

  it("passes the trusted tenantId through to every RPC call (never overridden)", async () => {
    const { client, calls } = makeStubClient();
    await materializeInvestors(
      TENANT,
      [inv({}), inv({ firm: "X Capital", name: "Y Z" })],
      client,
    );
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.args.p_tenant_id).toBe(TENANT);
    }
  });

  it("normalizes email to null when blank, passes a real email through", async () => {
    const { client, calls } = makeStubClient();
    await materializeInvestors(
      TENANT,
      [
        inv({ email: "" }),
        inv({ firm: "Acme Capital", name: "Jane Smith", email: " ed@x.com " }),
      ],
      client,
    );
    expect(calls[0].args.p_email).toBeNull();
    expect(calls[1].args.p_email).toBe("ed@x.com");
  });

  it("is best-effort: a single-row RPC error does not stop the rest", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let n = 0;
    const client = {
      rpc: vi.fn(async (_fn: string, args: Record<string, unknown>) => {
        calls.push(args);
        n += 1;
        if (n === 1) return { data: null, error: { message: "boom" } };
        return { data: "id", error: null };
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    await materializeInvestors(
      TENANT,
      [inv({}), inv({ firm: "Acme Capital", name: "Jane Smith" })],
      client,
    );
    expect(calls).toHaveLength(2);
  });

  it("no-ops on a missing tenantId (defensive guard)", async () => {
    const { client, calls } = makeStubClient();
    await materializeInvestors("", [inv({})], client);
    expect(calls).toHaveLength(0);
  });

  it("skips a degenerate '|' identity_key row (pure-suffix firm + blank name)", async () => {
    const { client, calls } = makeStubClient();
    expect(identityKey("Capital", "")).toBe("|");
    await materializeInvestors(
      TENANT,
      [inv({ firm: "Capital", name: "" })],
      client,
    );
    expect(calls).toHaveLength(0);
  });

  it("two distinct '|' rows do NOT collide onto one durable upsert — both skipped", async () => {
    const { client, calls } = makeStubClient();
    await materializeInvestors(
      TENANT,
      [inv({ firm: "Capital", name: "" }), inv({ firm: "Ventures", name: "" })],
      client,
    );
    expect(calls).toHaveLength(0);
  });

  it("still materializes a '|'-firm row when it carries a real email (dedupes on email, not identity_key)", async () => {
    const { client, calls } = makeStubClient();
    await materializeInvestors(
      TENANT,
      [inv({ firm: "Capital", name: "", email: "partner@capital.com" })],
      client,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_email).toBe("partner@capital.com");
  });

  it("a real firm next to a degenerate row still upserts (guard is row-scoped)", async () => {
    const { client, calls } = makeStubClient();
    await materializeInvestors(
      TENANT,
      [inv({ firm: "Capital", name: "" }), inv({ firm: "Acme Capital", name: "Jane Smith" })],
      client,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_identity_key).toBe("acme|jane smith");
  });
});

function makeClient(
  baseline: Array<{ identity_key?: string | null; normalized_email?: string | null }>,
  opts: { error?: boolean } = {},
) {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const eqCalls: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {
    from: () => chain,
    select: () => chain,
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return chain;
    },
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve(
        opts.error
          ? { data: null, error: { message: "boom" } }
          : { data: baseline, error: null },
      ).then(res),
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);
      return { data: null, error: null };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: chain as any, rpcCalls, eqCalls };
}

describe("materializeInvestors — the added / already_saved split", () => {
  it("splits new rows from ones the tenant already had", async () => {
    const { client } = makeClient([
      { identity_key: "riverstone|ed sim", normalized_email: null },
    ]);
    const summary = await materializeInvestors(
      TENANT,
      [
        inv({ firm: "Riverstone Ventures", name: "Ed Sim" }),
        inv({ firm: "Acme Capital", name: "Jane Smith" }),
        inv({ firm: "Boldstart Ventures", name: "Ann Lee" }),
      ],
      client,
    );
    expect(summary).toEqual({ added: 2, already_saved: 1 });
  });

  it("a run where EVERY row was already saved reports added: 0 — a real zero, not a missing number", async () => {
    const { client } = makeClient([
      { identity_key: "riverstone|ed sim", normalized_email: null },
      { identity_key: "acme|jane smith", normalized_email: null },
    ]);
    const summary = await materializeInvestors(
      TENANT,
      [
        inv({ firm: "Riverstone Ventures", name: "Ed Sim" }),
        inv({ firm: "Acme Capital", name: "Jane Smith" }),
      ],
      client,
    );
    expect(summary).toEqual({ added: 0, already_saved: 2 });
  });

  it("dedupes on EMAIL for email-bearing rows, exactly as the upsert RPC does", async () => {
    const { client } = makeClient([
      { identity_key: null, normalized_email: "ed@riverstone.vc" },
    ]);
    const summary = await materializeInvestors(
      TENANT,
      [
        inv({ name: "Ed Sim", email: "  ED@Riverstone.VC " }),
        inv({ firm: "Acme Capital", name: "Jane Smith", email: "jane@acme.vc" }),
      ],
      client,
    );
    expect(summary).toEqual({ added: 1, already_saved: 1 });
  });

  it("two rows that collapse onto ONE durable row count ONCE, not as new-then-already-saved", async () => {
    const { client } = makeClient([]);
    const summary = await materializeInvestors(
      TENANT,
      [
        inv({ firm: "Acme Capital", name: "Jane Smith" }),
        inv({ firm: "Acme Capital, LLC", name: "  JANE   smith " }),
      ],
      client,
    );
    expect(summary).toEqual({ added: 1, already_saved: 0 });
  });

  it("scopes the baseline read to the tenant (explicit filter, on top of RLS)", async () => {
    const { client, eqCalls } = makeClient([]);
    await materializeInvestors(TENANT, [inv({})], client);
    expect(eqCalls).toContainEqual(["tenant_id", TENANT]);
  });

  it("returns null — NOT zeros — when the baseline can't be read", async () => {
    const { client, rpcCalls } = makeClient([], { error: true });
    const summary = await materializeInvestors(TENANT, [inv({})], client);
    expect(summary).toBeNull();
    expect(rpcCalls).toHaveLength(1);
  });
});

describe("materializeInvestors — the email-added-later trap", () => {
  it("counts a no-email row as ADDED when the only matching key belongs to an email-bearing row", async () => {
    const { client } = makeClient([
      { identity_key: "riverstone|ed sim", normalized_email: "ed@riverstone.vc" },
    ]);
    const summary = await materializeInvestors(
      TENANT,
      [inv({ firm: "Riverstone Ventures", name: "Ed Sim" })],
      client,
    );
    expect(summary).toEqual({ added: 1, already_saved: 0 });
  });

  it("still counts already_saved when the existing row genuinely has NO email", async () => {
    const { client } = makeClient([
      { identity_key: "riverstone|ed sim", normalized_email: null },
    ]);
    const summary = await materializeInvestors(
      TENANT,
      [inv({ firm: "Riverstone Ventures", name: "Ed Sim" })],
      client,
    );
    expect(summary).toEqual({ added: 0, already_saved: 1 });
  });
});

describe("materializeInvestors — a partial failure forfeits the receipt", () => {
  it("returns null when any upsert failed, rather than an authoritative-looking partial total", async () => {
    const { client } = makeClient([]);
    let call = 0;
    (client as unknown as { rpc: unknown }).rpc = async () => {
      call += 1;
      return call === 2 ? { error: { message: "boom" } } : { error: null };
    };
    const summary = await materializeInvestors(
      TENANT,
      [
        inv({ firm: "Acme Capital", name: "Jane Smith" }),
        inv({ firm: "Boldstart Ventures", name: "Ann Lee" }),
        inv({ firm: "Riverstone Ventures", name: "Ed Sim" }),
      ],
      client,
    );
    expect(summary).toBeNull();
  });
});
