
import { describe, it, expect, vi } from "vitest";
import { __test__ } from "../post-run";
import { materializeInvestors, type MaterializeInvestor } from "../materialize";
import type { FundraisingInvestor } from "../output-schema";

const { groundAndDedupInvestors } = __test__;

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

const FIRM_PAGE_URL = "https://riverstone.vc/team";
const FIRM_PAGE =
  "<untrusted_web_content>\nRiverstone Ventures backs seed-stage marketplaces. " +
  "The fund invests at seed and leads rounds across mobility.\n</untrusted_web_content>";

function getText(url: string): string | null {
  return url === FIRM_PAGE_URL ? FIRM_PAGE : null;
}

function webRow(over: Partial<FundraisingInvestor>): FundraisingInvestor {
  return {
    firm: "Riverstone Ventures",
    name: "",
    tier: 1,
    focus: "",
    stage_focus: "",
    check_size: "",
    fit_rationale: "fits",
    contact_hint: "",
    suggested_message: "",
    source: "web",
    source_url: FIRM_PAGE_URL,
    evidence_text: "Riverstone Ventures backs seed-stage marketplaces",
    evidence_span:
      "Riverstone Ventures backs seed-stage marketplaces. The fund invests at seed and leads rounds across mobility.",
    source_kind: "investor_directory",
    ...over,
  };
}

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

describe("KILL-TEST: identity_key freeze — two partners at one firm stay two rows", () => {
  it("two DIFFERENT unverified partners at the SAME firm survive dedup AND upsert under two DISTINCT identity keys", async () => {
    const rows = [
      webRow({ name: "Ghostly McNotreal" }),
      webRow({ name: "Phantom Nobody" }),
    ];

    const gate = groundAndDedupInvestors(rows, getText, () => false);

    expect(gate.kept).toHaveLength(2);
    expect(gate.webVerified).toBe(2);
    expect(gate.merged).toBe(0);
    expect(gate.kept.map((i) => i.name)).toEqual(["", ""]);

    const { client, calls } = makeStubClient();
    await materializeInvestors(
      TENANT,
      gate.kept as unknown as MaterializeInvestor[],
      client,
      gate.frozenIdentityKeys as unknown as ReadonlyMap<MaterializeInvestor, string>,
    );

    expect(calls).toHaveLength(2);
    const keys = calls.map((c) => c.args.p_identity_key as string);
    expect(new Set(keys).size).toBe(2);
    expect(keys).not.toContain("riverstone|");
    expect(new Set(keys)).toEqual(
      new Set(["riverstone|ghostly mcnotreal", "riverstone|phantom nobody"]),
    );
    for (const c of calls) expect(c.args.p_tenant_id).toBe(TENANT);
  });

  it("REGRESSION PROOF: recomputing the key from the blanked name WOULD have collapsed them", async () => {
    const rows = [
      webRow({ name: "Ghostly McNotreal" }),
      webRow({ name: "Phantom Nobody" }),
    ];
    const gate = groundAndDedupInvestors(rows, getText, () => false);

    const { client, calls } = makeStubClient();
    await materializeInvestors(
      TENANT,
      gate.kept as unknown as MaterializeInvestor[],
      client,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_identity_key).toBe("riverstone|");
  });

  it("a VERIFIED partner keeps the exact key format earlier runs already wrote (cross-run dedupe unchanged)", async () => {
    const page =
      "<untrusted_web_content>\nRiverstone Ventures backs seed-stage marketplaces. " +
      "Partner Jane Smith invests at seed and leads rounds.\n</untrusted_web_content>";
    const rows = [
      webRow({
        name: "Jane Smith",
        evidence_span:
          "Riverstone Ventures backs seed-stage marketplaces. Partner Jane Smith invests at seed and leads rounds.",
      }),
    ];
    const gate = groundAndDedupInvestors(
      rows,
      (u) => (u === FIRM_PAGE_URL ? page : null),
      () => false,
    );
    expect(gate.kept).toHaveLength(1);
    expect(gate.kept[0].name).toBe("Jane Smith");

    const withFreeze = makeStubClient();
    await materializeInvestors(
      TENANT,
      gate.kept as unknown as MaterializeInvestor[],
      withFreeze.client,
      gate.frozenIdentityKeys as unknown as ReadonlyMap<MaterializeInvestor, string>,
    );
    const withoutFreeze = makeStubClient();
    await materializeInvestors(
      TENANT,
      gate.kept as unknown as MaterializeInvestor[],
      withoutFreeze.client,
    );

    expect(withFreeze.calls[0].args.p_identity_key).toBe("riverstone|jane smith");
    expect(withoutFreeze.calls[0].args.p_identity_key).toBe(
      withFreeze.calls[0].args.p_identity_key,
    );
  });

  it("frozen keys are exposed ONLY for surviving rows", () => {
    const rows = [
      webRow({ name: "Ghostly McNotreal" }),
      webRow({ name: "Dropped Person", source_url: "https://never-fetched.example/x" }),
    ];
    const gate = groundAndDedupInvestors(rows, getText, () => false);
    expect(gate.kept).toHaveLength(1);
    expect(gate.frozenIdentityKeys.size).toBe(1);
    expect(gate.frozenIdentityKeys.get(gate.kept[0])).toBe(
      "riverstone|ghostly mcnotreal",
    );
  });
});

describe("materialize — nameless `firm|` key guard", () => {
  function inv(over: Partial<MaterializeInvestor>): MaterializeInvestor {
    return { firm: "Acme Capital", name: "", ...over };
  }

  it("skips a SECOND nameless `firm|` row rather than overwriting the first", async () => {
    const { client, calls } = makeStubClient();
    await materializeInvestors(TENANT, [inv({}), inv({})], client);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.p_identity_key).toBe("acme|");
  });

  it("does NOT skip when the nameless rows carry real emails (they dedupe on email)", async () => {
    const { client, calls } = makeStubClient();
    await materializeInvestors(
      TENANT,
      [inv({ email: "a@acme.com" }), inv({ email: "b@acme.com" })],
      client,
    );
    expect(calls).toHaveLength(2);
  });

  it("nameless rows at DIFFERENT firms both write (guard is per-key, not blanket)", async () => {
    const { client, calls } = makeStubClient();
    await materializeInvestors(
      TENANT,
      [inv({ firm: "Acme Capital" }), inv({ firm: "Northwind Capital" })],
      client,
    );
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.args.p_identity_key)).toEqual([
      "acme|",
      "northwind|",
    ]);
  });

  it("a frozen key overrides the recompute even when the row's live name is blank", async () => {
    const { client, calls } = makeStubClient();
    const a = inv({ name: "" });
    const b = inv({ name: "" });
    const frozen = new Map<MaterializeInvestor, string>([
      [a, "acme|jane smith"],
      [b, "acme|bob lee"],
    ]);
    await materializeInvestors(TENANT, [a, b], client, frozen);
    expect(calls.map((c) => c.args.p_identity_key)).toEqual([
      "acme|jane smith",
      "acme|bob lee",
    ]);
  });
});
