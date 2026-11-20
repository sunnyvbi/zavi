import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  firstNameOf,
  withRequestedByFooter,
  buildRequestedByFooter,
  withApprovedByFooter,
  resolveApproverLabel,
} from "@/services/tools/slack/provenance-footer";
import type { ActorAuthorityEnvelopeV1 } from "@/services/agents/actor-envelope";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

function svcWithName(displayName: string | null): SupabaseClient {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) builder[m] = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => ({
    data: displayName === null ? null : { team_members: { display_name: displayName } },
    error: null,
  }));
  return { from: vi.fn(() => builder) } as unknown as SupabaseClient;
}

const verifiedSlack: ActorAuthorityEnvelopeV1 = {
  actor_user_id: "user-1",
  actor_source: "slack",
  slack_user_id: "U1",
  resolved_tenant_member: true,
  provenance_label: "verified member",
};

describe("firstNameOf", () => {
  it("takes the first word", () => {
    expect(firstNameOf("Ana Sharma")).toBe("Ana");
    expect(firstNameOf("  Ravi  ")).toBe("Ravi");
  });
  it("null/empty → null", () => {
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf("   ")).toBeNull();
  });
});

describe("withRequestedByFooter", () => {
  it("verified Slack member → appends 'Requested by <FirstName>'", async () => {
    const out = await withRequestedByFooter(svcWithName("Ana Sharma"), TENANT, verifiedSlack, "The report is ready.");
    expect(out).toContain("The report is ready.");
    expect(out).toMatch(/_Requested by Ana_/);
  });

  it("is idempotent — a second pass does not double-stamp", async () => {
    const once = await withRequestedByFooter(svcWithName("Ana"), TENANT, verifiedSlack, "hi");
    const twice = await withRequestedByFooter(svcWithName("Ana"), TENANT, verifiedSlack, once);
    expect(twice).toBe(once);
    expect((twice.match(/Requested by/g) ?? []).length).toBe(1);
  });

  it("unverified external sender → NO footer", async () => {
    const unverified = { ...verifiedSlack, resolved_tenant_member: false, provenance_label: "unverified external" };
    const out = await withRequestedByFooter(svcWithName("Whoever"), TENANT, unverified, "hi");
    expect(out).toBe("hi");
  });

  it("non-slack actor (chat/cron) → NO footer", async () => {
    const chat = { actor_user_id: "u", actor_source: "chat" as const, resolved_tenant_member: true, provenance_label: "signed-in user" };
    expect(await withRequestedByFooter(svcWithName("X"), TENANT, chat, "hi")).toBe("hi");
    const cron = { actor_user_id: null, actor_source: "cron" as const, resolved_tenant_member: false, provenance_label: "scheduled run" };
    expect(await withRequestedByFooter(svcWithName("X"), TENANT, cron, "hi")).toBe("hi");
  });

  it("no actor → NO footer", async () => {
    expect(await withRequestedByFooter(svcWithName("X"), TENANT, undefined, "hi")).toBe("hi");
  });

  it("verified member but name unresolvable → NO footer (post still goes)", async () => {
    expect(await buildRequestedByFooter(svcWithName(null), TENANT, verifiedSlack, "hi")).toBeNull();
    expect(await withRequestedByFooter(svcWithName(null), TENANT, verifiedSlack, "hi")).toBe("hi");
  });
});

function svcResolver(rows: Array<{ user_id: string; label: string }> | null, error: unknown = null) {
  return { rpc: (_fn: string, _args: unknown) => Promise.resolve({ data: rows, error }) } as unknown as SupabaseClient;
}

describe("withApprovedByFooter", () => {
  it("human-approved member → appends 'Approved by <FirstName>'", async () => {
    const svc = svcResolver([{ user_id: "u-app", label: "Ravi Ramadasu" }]);
    const out = await withApprovedByFooter(svc, TENANT, "u-app", "Posting the update.");
    expect(out).toContain("Posting the update.");
    expect(out).toMatch(/_Approved by Ravi_/);
  });

  it("staff approver → 'Approved by Zavi staff' (verbatim, no first-word split, no email)", async () => {
    const svc = svcResolver([{ user_id: "u-staff", label: "Zavi staff" }]);
    const out = await withApprovedByFooter(svc, TENANT, "u-staff", "hi");
    expect(out).toMatch(/_Approved by Zavi staff_/);
  });

  it("a CGO approval (source cgo) reads 'Approved by Autopilot', never the owner's name", async () => {
    const svc = svcResolver([{ user_id: "u-owner", label: "Ravi Ramadasu" }]);
    const out = await withApprovedByFooter(svc, TENANT, "u-owner", "hi", "cgo");
    expect(out).toMatch(/_Approved by Autopilot_/);
    expect(out).not.toMatch(/Ravi/);
  });

  it("auto-fired (no approver) → NO footer", async () => {
    const svc = svcResolver([]);
    expect(await withApprovedByFooter(svc, TENANT, null, "hi")).toBe("hi");
  });

  it("unresolvable approver → NO footer, post still goes", async () => {
    const svc = svcResolver([]);
    expect(await withApprovedByFooter(svc, TENANT, "u-missing", "hi")).toBe("hi");
  });

  it("RPC error → best-effort, text unchanged", async () => {
    const svc = svcResolver(null, { code: "XX000" });
    expect(await resolveApproverLabel(svc, TENANT, "u-app")).toBeNull();
    expect(await withApprovedByFooter(svc, TENANT, "u-app", "hi")).toBe("hi");
  });

  it("idempotent — a second pass does not double-stamp", async () => {
    const svc = svcResolver([{ user_id: "u-app", label: "Ana" }]);
    const once = await withApprovedByFooter(svc, TENANT, "u-app", "hi");
    const twice = await withApprovedByFooter(svc, TENANT, "u-app", once);
    expect(twice).toBe(once);
    expect((twice.match(/Approved by/g) ?? []).length).toBe(1);
  });
});

describe("Requested-by name lookup is scoped to the actor's workspace", () => {
  it("filters the identity by the actor's slack_team_id when the envelope carries one", async () => {
    const svc = svcWithName("Ana Sharma");
    const out = await withRequestedByFooter(svc, TENANT, { ...verifiedSlack, slack_team_id: "T_ACME" }, "hi");
    expect(out).toMatch(/_Requested by Ana_/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = (svc.from as any).mock.results[0].value;
    expect(builder.eq).toHaveBeenCalledWith("team_id", "T_ACME");
  });
});
