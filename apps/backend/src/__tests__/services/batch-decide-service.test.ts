import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  decideImpl: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/approvals/decide-service", () => ({
  decideOnDecision: m.decideImpl,
}));

import {
  rejectBatch,
  approveBatch,
  isBulkApprovable,
  neverAutoSlugSet,
  type DecisionMeta,
  type DecisionMetaLoader,
} from "@/services/approvals/batch-decide-service";

const TENANT = "00000000-0000-0000-0000-000000000001";
const ACTOR = "10000000-0000-0000-0000-000000000001";

beforeEach(() => {
  m.decideImpl.mockReset();
});

describe("isBulkApprovable — exclusion gate", () => {
  it("excludes money / customer-facing / never-auto / forbidden", () => {
    expect(isBulkApprovable({ decision_class: "meta_ads.set_status", handler: "meta_ads.set_status" }).ok).toBe(false);
    expect(isBulkApprovable({ decision_class: "refund_stripe", handler: "stripe.refund" }).ok).toBe(false);
    expect(isBulkApprovable({ decision_class: "outbound.send", handler: "outbound.send" }).ok).toBe(false);
    expect(isBulkApprovable({ decision_class: "social.publish", handler: "social.publish" }).ok).toBe(false);
    expect(isBulkApprovable({ decision_class: "browser.action", handler: "browser.action" }).ok).toBe(false);
    expect(isBulkApprovable({ decision_class: "send_email", handler: "email.send" }).ok).toBe(false);
    expect(isBulkApprovable({ decision_class: "anything", handler: null, autonomy_at_emit: "forbidden" }).ok).toBe(false);
  });
  it("excludes a never_auto class even when its name/handler look innocuous", () => {
    const r = isBulkApprovable({
      decision_class: "pm.needs_action",
      handler: "pm.needs_action",
      autonomy_at_emit: "approval",
      never_auto: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("never_auto_class");
    expect(isBulkApprovable({ decision_class: "whatever.safe_looking", handler: null, never_auto: true }).ok).toBe(false);
  });
  it("a non-never_auto low-risk class is still approvable (never_auto:false / undefined)", () => {
    expect(isBulkApprovable({ decision_class: "jira.create_issue", handler: "jira.create_issue", never_auto: false }).ok).toBe(true);
    expect(isBulkApprovable({ decision_class: "jira.create_issue", handler: "jira.create_issue" }).ok).toBe(true);
  });
  it("allows a plain low-risk class (e.g. jira/linear/digest)", () => {
    expect(isBulkApprovable({ decision_class: "jira.create_issue", handler: "jira.create_issue" }).ok).toBe(true);
    expect(isBulkApprovable({ decision_class: "chief-of-staff.daily-digest", handler: null }).ok).toBe(true);
  });
  it("excludes by handler even when the class name looks innocuous", () => {
    expect(isBulkApprovable({ decision_class: "totally_safe_name", handler: "stripe.create_connected_account" }).ok).toBe(false);
  });
});

describe("isBulkApprovable — Composio writes (spec 12) never ride a bulk click", () => {
  it("every composio.* class / the composio.execute_tool handler is skipped", () => {
    for (const cls of ["composio.write", "composio.moves_money", "composio.deletes_data"]) {
      const r = isBulkApprovable({ decision_class: cls, handler: "composio.execute_tool", never_auto: false });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^money_or_customer_facing_/);
    }
    expect(isBulkApprovable({ decision_class: "composio.write", handler: null }).ok).toBe(false);
    expect(isBulkApprovable({ decision_class: "something_else", handler: "composio.execute_tool" }).ok).toBe(false);
  });
});

describe("rejectBatch", () => {
  it("N ids → all routed through reject; cross-tenant id errors (never rejected)", async () => {
    m.decideImpl.mockImplementation(async ({ decision_id, action }: { decision_id: string; action: string }) => {
      expect(action).toBe("reject");
      if (decision_id === "x-other") {
        return { ok: false, code: "cross_tenant", changed: false, status: "proposed", decision_id };
      }
      return { ok: true, code: "ok", changed: true, status: "rejected", decision_id };
    });
    const r = await rejectBatch({
      decision_ids: ["a", "b", "x-other"],
      tenant_id: TENANT,
      actor_user_id: ACTOR,
    });
    expect(r.total).toBe(3);
    expect(r.rejected).toBe(2);
    expect(r.errored).toBe(1);
    expect(r.skipped).toBe(0);
    const other = r.results.find((x) => x.decision_id === "x-other")!;
    expect(other).toMatchObject({ outcome: "error", reason: "cross_tenant" });
    expect(m.decideImpl).toHaveBeenCalledTimes(3);
  });

  it("admin-correction capture fires once per REAL flip, NOT on a no-op or errored row", async () => {
    m.decideImpl.mockImplementation(async ({ decision_id }: { decision_id: string }) => {
      if (decision_id === "x-other") {
        return { ok: false, code: "cross_tenant", changed: false, status: "proposed", decision_id };
      }
      if (decision_id === "noop") {
        return { ok: true, code: "ok", changed: false, status: "rejected", decision_id };
      }
      return { ok: true, code: "ok", changed: true, status: "rejected", decision_id };
    });
    const captured: string[] = [];
    const captureReject = vi.fn(async (decision_id: string) => {
      captured.push(decision_id);
    });
    const r = await rejectBatch({
      decision_ids: ["a", "b", "noop", "x-other"],
      tenant_id: TENANT,
      actor_user_id: ACTOR,
      captureReject,
    });
    expect(r.rejected).toBe(3);
    expect(r.errored).toBe(1);
    expect(captureReject).toHaveBeenCalledTimes(2);
    expect(captured.sort()).toEqual(["a", "b"]);
    expect(captured).not.toContain("noop");
    expect(captured).not.toContain("x-other");
  });

  it("a capture failure NEVER breaks the reject (best-effort)", async () => {
    m.decideImpl.mockImplementation(async ({ decision_id }: { decision_id: string }) => ({
      ok: true,
      code: "ok",
      changed: true,
      status: "rejected",
      decision_id,
    }));
    const captureReject = vi.fn(async () => {
      throw new Error("capture blew up");
    });
    const r = await rejectBatch({
      decision_ids: ["a"],
      tenant_id: TENANT,
      actor_user_id: ACTOR,
      captureReject,
    });
    expect(r.rejected).toBe(1);
    expect(r.results[0]).toMatchObject({ outcome: "rejected", changed: true });
  });
});

describe("approveBatch", () => {
  const loadMeta: DecisionMetaLoader = async (ids) => {
    const meta = new Map<string, DecisionMeta>();
    for (const id of ids) {
      if (id === "money") meta.set(id, { decision_class: "meta_ads.set_status", handler: "meta_ads.set_status", autonomy_at_emit: "approval", never_auto: false });
      else if (id === "send") meta.set(id, { decision_class: "outbound.send", handler: "outbound.send", autonomy_at_emit: "approval", never_auto: false });
      else if (id === "neverauto") meta.set(id, { decision_class: "pm.needs_action", handler: "pm.needs_action", autonomy_at_emit: "approval", never_auto: true });
      else if (id === "unresolved") {  }
      else meta.set(id, { decision_class: "jira.create_issue", handler: "jira.create_issue", autonomy_at_emit: "approval", never_auto: false });
    }
    return { ok: true, meta };
  };

  it("excludes money/customer-facing rows (skipped+reason), approves the eligible ones", async () => {
    m.decideImpl.mockImplementation(async ({ decision_id, action }: { decision_id: string; action: string }) => {
      expect(action).toBe("approve");
      return { ok: true, code: "ok", changed: true, status: "approved", decision_id };
    });
    const r = await approveBatch({
      decision_ids: ["safe1", "money", "send", "safe2"],
      tenant_id: TENANT,
      actor_user_id: ACTOR,
      loadMeta,
    });
    expect(r.total).toBe(4);
    expect(r.approved).toBe(2);
    expect(r.skipped).toBe(2);
    expect(r.errored).toBe(0);
    expect(m.decideImpl).toHaveBeenCalledTimes(2);
    const money = r.results.find((x) => x.decision_id === "money")!;
    expect(money).toMatchObject({ outcome: "skipped", reason: "money_or_customer_facing_class" });
    const send = r.results.find((x) => x.decision_id === "send")!;
    expect(send).toMatchObject({ outcome: "skipped" });
  });

  it("excludes a never_auto row from the bulk sweep (skipped: never_auto_class), approves the safe one", async () => {
    m.decideImpl.mockImplementation(async ({ decision_id, action }: { decision_id: string; action: string }) => {
      expect(action).toBe("approve");
      return { ok: true, code: "ok", changed: true, status: "approved", decision_id };
    });
    const r = await approveBatch({
      decision_ids: ["safe1", "neverauto"],
      tenant_id: TENANT,
      actor_user_id: ACTOR,
      loadMeta,
    });
    expect(r.approved).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.errored).toBe(0);
    expect(m.decideImpl).toHaveBeenCalledTimes(1);
    const na = r.results.find((x) => x.decision_id === "neverauto")!;
    expect(na).toMatchObject({ outcome: "skipped", reason: "never_auto_class" });
  });

  it("FAIL CLOSED: metadata lookup ERROR → ZERO rows approved (aborted), no decideOnDecision approve fired", async () => {
    m.decideImpl.mockImplementation(async () => {
      throw new Error("decideOnDecision must NOT be called when meta lookup errored");
    });
    const erroringLoader: DecisionMetaLoader = async () => ({
      ok: false,
      error: "db blip: permission denied",
    });
    const r = await approveBatch({
      decision_ids: ["safe1", "money", "safe2"],
      tenant_id: TENANT,
      actor_user_id: ACTOR,
      loadMeta: erroringLoader,
    });
    expect(r.approved).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.errored).toBe(0);
    expect(r.results).toEqual([]);
    expect(r.aborted).toBeTruthy();
    expect(r.aborted?.reason).toContain("meta_lookup_failed");
    expect(m.decideImpl).not.toHaveBeenCalled();
  });

  it("FAIL CLOSED: a row absent from the resolved metadata map → skipped(unresolved_class), NOT approved", async () => {
    m.decideImpl.mockImplementation(async ({ decision_id, action }: { decision_id: string; action: string }) => {
      expect(action).toBe("approve");
      return { ok: true, code: "ok", changed: true, status: "approved", decision_id };
    });
    const r = await approveBatch({
      decision_ids: ["safe1", "unresolved"],
      tenant_id: TENANT,
      actor_user_id: ACTOR,
      loadMeta,
    });
    expect(r.approved).toBe(1);
    expect(r.skipped).toBe(1);
    const unresolved = r.results.find((x) => x.decision_id === "unresolved")!;
    expect(unresolved).toMatchObject({ outcome: "skipped", reason: "unresolved_class" });
    expect(m.decideImpl).toHaveBeenCalledTimes(1);
    expect(m.decideImpl).toHaveBeenCalledWith(expect.objectContaining({ decision_id: "safe1", action: "approve" }));
  });

  it("idempotent double-call: 2nd approve of an already-approved row → changed:false, still counts (no re-fire)", async () => {
    let calls = 0;
    m.decideImpl.mockImplementation(async ({ decision_id }: { decision_id: string }) => {
      calls++;
      return { ok: true, code: "ok", changed: calls === 1, status: "approved", decision_id };
    });
    const first = await approveBatch({ decision_ids: ["safe1"], tenant_id: TENANT, actor_user_id: ACTOR, loadMeta });
    expect(first.approved).toBe(1);
    expect(first.results[0]).toMatchObject({ outcome: "approved", changed: true });
    const second = await approveBatch({ decision_ids: ["safe1"], tenant_id: TENANT, actor_user_id: ACTOR, loadMeta });
    expect(second.approved).toBe(1);
    expect(second.results[0]).toMatchObject({ outcome: "approved", changed: false });
  });
});

describe("neverAutoSlugSet", () => {
  it("builds the set of never_auto slugs from decision_classes rows", () => {
    const set = neverAutoSlugSet([{ slug: "pm.needs_action" }, { slug: "browser.action" }]);
    expect(set.has("pm.needs_action")).toBe(true);
    expect(set.has("browser.action")).toBe(true);
    expect(set.has("jira.create_issue")).toBe(false);
  });
  it("ignores non-string/empty rows (defensive)", () => {
    const set = neverAutoSlugSet([{ slug: "x" }, {}, { slug: 123 as unknown as string }]);
    expect(set.has("x")).toBe(true);
    expect(set.size).toBe(1);
  });
});
