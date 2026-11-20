import { describe, expect, it, vi } from "vitest";
import {
  rankCustomerCandidates,
  rankFinishCandidates,
  runConfirmOutcomeFields,
  runReadOutcomeFields,
  type BaseConfig,
  type OutcomeFieldDeps,
} from "../outcome_fields";
import type { ToolContext } from "@/services/tools/types";

const col = (name: string, type: string) => ({ name, type, nullable: true });
const COLUMNS = [
  col("_id", "ObjectId"),
  col("createdAt", "Date"),
  col("updatedAt", "Date"),
  col("closedAt", "Date"),
  col("buyerId", "ObjectId"),
  col("sellerRef", "ObjectId"),
  col("status", "String"),
  col("checkout", "Document"),
];
const BASE: BaseConfig = {
  engine: "mongodb",
  booking_source: "orders",
  date_field: "createdAt",
  status_field: "status",
  revenue_field: "total",
  refund_field: null,
  refund_basis: "none",
  currency: "USD",
  amount_unit: "dollars",
  state: "confirmed",
  updated_at: "2026-10-01T00:00:00.123456+00:00",
};
const CHAT: ToolContext = {
  tenant_id: "t1",
  log: () => undefined,
  run_trigger: "chat",
  actor: { actor_user_id: "u1" } as ToolContext["actor"],
};

function deps(over: Partial<OutcomeFieldDeps> = {}): OutcomeFieldDeps {
  return {
    getBase: vi.fn(async () => BASE),
    getOutcomeMap: vi.fn(async () => ({ ok: false as const, missing: ["completed_at_field"], message: "" })),
    getCatalog: vi.fn(async () => ({ dialect: "mongodb", catalog: { tables: [{ name: "orders", rowEstimate: 1, columns: COLUMNS }] } }) as never),
    readStatusValues: vi.fn(async () => ({
      values: [
        { value: "closed", rows: 90 },
        { value: "open", rows: 10 },
      ],
      complete: true,
    })),
    isOwnerOrAdmin: vi.fn(async () => true),
    confirm: vi.fn(async () => undefined),
    ...over,
  };
}
const GOOD = {
  completed_at_field: "closedAt",
  customer_ref_field: "buyerId",
  terminal_statuses: ["closed"],
  one_row_is_one_order: true,
  mapping_revision: BASE.updated_at,
  booking_mapping_confirmed: true,
};

describe("propose", () => {
  it("ranks finish dates and customer refs generically and shows the booking mapping + its revision", async () => {
    const out = (await runReadOutcomeFields(CHAT, deps())) as Record<string, unknown> & {
      candidates: { completed_at_field: string[]; customer_ref_field: string[]; terminal_statuses: Array<{ value: string; looks_finished: boolean }> };
    };
    expect(out.status).toBe("proposal");
    expect(out.candidates.completed_at_field[0]).toBe("closedAt");
    expect(out.candidates.completed_at_field).not.toContain("createdAt");
    expect(out.candidates.customer_ref_field[0]).toBe("buyerId");
    expect(out.candidates.terminal_statuses).toEqual([
      { value: "closed", rows: 90, looks_finished: true },
      { value: "open", rows: 10, looks_finished: false },
    ]);
    expect(out.mapping_revision).toBe(BASE.updated_at);
    expect(out.booking_mapping).toMatchObject({ orders_table: "orders", revenue_field: "total" });
  });

  it("no confirmed booking mapping: says so, proposes nothing", async () => {
    const out = await runReadOutcomeFields(CHAT, deps({ getBase: vi.fn(async () => null) }));
    expect(out.status).toBe("booking_mapping_missing");
  });

  it("pure rankers ignore ids and dates in the wrong role", () => {
    expect(rankFinishCandidates(COLUMNS, "createdAt")).toEqual(["closedAt", "updatedAt"]);
    expect(rankCustomerCandidates(COLUMNS)).toEqual(["buyerId", "sellerRef"]);
  });
});

describe("confirm", () => {
  it("refuses outside a founder-typed chat turn, and for a non-admin", async () => {
    await expect(runConfirmOutcomeFields({ ...CHAT, run_trigger: "cron" }, GOOD, deps())).rejects.toMatchObject({ code: "outcome_fields_denied" });
    await expect(runConfirmOutcomeFields(CHAT, GOOD, deps({ isOwnerOrAdmin: vi.fn(async () => false) }))).rejects.toMatchObject({
      code: "outcome_fields_denied",
    });
  });

  it("refuses without the founder's two confirmations", async () => {
    await expect(runConfirmOutcomeFields(CHAT, { ...GOOD, one_row_is_one_order: false }, deps())).rejects.toMatchObject({ code: "outcome_fields_bad_input" });
    const { booking_mapping_confirmed: _drop, ...noMapping } = GOOD;
    await expect(runConfirmOutcomeFields(CHAT, noMapping, deps())).rejects.toMatchObject({ code: "outcome_fields_bad_input" });
  });

  it("refuses when the mapping moved after the founder saw it", async () => {
    const d = deps();
    await expect(runConfirmOutcomeFields(CHAT, { ...GOOD, mapping_revision: "2026-09-01T00:00:00+00:00" }, d)).rejects.toMatchObject({
      code: "outcome_fields_mapping_changed",
    });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("refuses a field that is not in the catalog, or the created-at field as the finish", async () => {
    await expect(runConfirmOutcomeFields(CHAT, { ...GOOD, completed_at_field: "deliveredAt" }, deps())).rejects.toMatchObject({
      code: "outcome_fields_unknown_field",
    });
    await expect(runConfirmOutcomeFields(CHAT, { ...GOOD, completed_at_field: "createdAt" }, deps())).rejects.toMatchObject({
      code: "outcome_fields_same_as_created",
    });
    const d = deps();
    await runConfirmOutcomeFields(CHAT, { ...GOOD, completed_at_field: "checkout.at" }, d);
    expect(d.confirm).toHaveBeenCalled();
  });

  it("an unseen status is the founder's call: saved with a note, never refused", async () => {
    const d = deps();
    const out = (await runConfirmOutcomeFields(CHAT, { ...GOOD, terminal_statuses: ["closed", "archived"] }, d)) as { notes?: string[] };
    expect(out.notes?.join(" ")).toMatch(/archived/);
    expect(d.confirm).toHaveBeenCalledWith({
      tenant_id: "t1",
      completed_at_field: "closedAt",
      customer_ref_field: "buyerId",
      terminal_statuses: ["closed", "archived"],
      confirmed_by: "u1",
      expected_updated_at: BASE.updated_at,
    });
  });

  it("the tenant and confirmer come from the run, never the input", async () => {
    await expect(runConfirmOutcomeFields(CHAT, { ...GOOD, tenant_id: "t2" }, deps())).rejects.toMatchObject({ code: "outcome_fields_bad_input" });
  });

  it("an already-confirmed map can be corrected: the read returns the mapping and its revision", async () => {
    const d = deps({
      getOutcomeMap: vi.fn(async () => ({
        ok: true as const,
        map: { completed_at_field: "closedAt", customer_ref_field: "buyerId", terminal_statuses: ["closed"], outcome_confirmed_at: "2026-10-02" } as never,
      })),
    });
    const out = (await runReadOutcomeFields(CHAT, d)) as Record<string, unknown>;
    expect(out.status).toBe("confirmed");
    expect(out.mapping_revision).toBe(BASE.updated_at);
    expect(out.booking_mapping).toMatchObject({ orders_table: "orders" });
  });

  it("Postgres: a finish field with no time zone is refused", async () => {
    const pg = { ...BASE, engine: "postgres" as const, date_field: "created_at" };
    const cols = [col("created_at", "timestamp with time zone"), col("closed_at", "timestamp without time zone"), col("buyer_id", "uuid")];
    const d = deps({ getBase: vi.fn(async () => pg), getCatalog: vi.fn(async () => ({ catalog: { tables: [{ name: "orders", columns: cols }] } }) as never) });
    await expect(runConfirmOutcomeFields(CHAT, { ...GOOD, completed_at_field: "closed_at", customer_ref_field: "buyer_id" }, d)).rejects.toMatchObject({
      code: "outcome_fields_no_time_zone",
    });
  });
});
