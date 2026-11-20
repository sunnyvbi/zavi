
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  selfAccountClient: vi.fn(),
  deleteTenantSites: vi.fn(async (_t: string) => [] as Array<{ site_id: string; result: { complete: boolean; pending: string[] } }>),
  alert: vi.fn(async (_input: unknown) => {}),
}));

vi.mock("@/services/tenant-client", () => ({
  selfAccountClient: mocks.selfAccountClient,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/auth/tenant-cache", () => ({ invalidateCachedTenant: vi.fn() }));
vi.mock("@/services/sites/teardown", () => ({ deleteTenantSites: mocks.deleteTenantSites }));
vi.mock("@/services/logging/alert", () => ({ alert: mocks.alert }));

import {
  AccountDeletionError,
  MARK_SOFT_DELETED_TRIES,
  PURGE_GRACE_DAYS,
  planAccountDeletion,
  softDeleteAccount,
  type MembershipRow,
} from "@/services/account/delete-account";
import { invalidateCachedTenant } from "@/services/auth/tenant-cache";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function member(tenant: string, user: string, role: string | null): MembershipRow {
  return { tenant_id: tenant, user_id: user, role };
}

describe("planAccountDeletion", () => {
  it("takes a workspace where the person is the only member", () => {
    const plan = planAccountDeletion(ME, [member("t-solo", ME, "owner")]);
    expect(plan.deleted_tenants).toEqual(["t-solo"]);
    expect(plan.left_tenants).toEqual([]);
    expect(plan.blocked_tenants).toEqual([]);
  });

  it("only removes the person from a workspace that has another owner", () => {
    const plan = planAccountDeletion(ME, [
      member("t-shared", ME, "owner"),
      member("t-shared", OTHER, "owner"),
    ]);
    expect(plan.left_tenants).toEqual(["t-shared"]);
    expect(plan.deleted_tenants).toEqual([]);
  });

  it("only removes a non-owner, whoever else is there", () => {
    const plan = planAccountDeletion(ME, [
      member("t-shared", ME, "member"),
      member("t-shared", OTHER, "owner"),
    ]);
    expect(plan.left_tenants).toEqual(["t-shared"]);
  });

  it("blocks when the person is the ONLY owner of a workspace others still use", () => {
    const plan = planAccountDeletion(ME, [
      member("t-orphan", ME, "owner"),
      member("t-orphan", OTHER, "member"),
    ]);
    expect(plan.blocked_tenants).toEqual(["t-orphan"]);
    expect(plan.deleted_tenants).toEqual([]);
    expect(plan.left_tenants).toEqual([]);
  });

  it("does NOT block a workspace that has no owner row at all", () => {
    const plan = planAccountDeletion(ME, [
      member("t-drift", ME, "member"),
      member("t-drift", OTHER, "member"),
    ]);
    expect(plan.left_tenants).toEqual(["t-drift"]);
    expect(plan.blocked_tenants).toEqual([]);
  });

  it("ignores a workspace the person is not in, even if its rows were fetched", () => {
    const plan = planAccountDeletion(ME, [member("t-theirs", OTHER, "owner")]);
    expect(plan).toEqual({ deleted_tenants: [], left_tenants: [], blocked_tenants: [] });
  });

  it("sorts each bucket across several workspaces at once", () => {
    const plan = planAccountDeletion(ME, [
      member("t-b", ME, "owner"),
      member("t-a", ME, "owner"),
      member("t-c", ME, "member"),
      member("t-c", OTHER, "owner"),
    ]);
    expect(plan.deleted_tenants).toEqual(["t-a", "t-b"]);
    expect(plan.left_tenants).toEqual(["t-c"]);
  });

  it("has nothing to do for a person who never onboarded", () => {
    expect(planAccountDeletion(ME, [])).toEqual({
      deleted_tenants: [],
      left_tenants: [],
      blocked_tenants: [],
    });
  });
});

type QueryState = { table: string; op: string; cols: string; payload?: unknown };
type Result = { data?: unknown; error?: { message: string } | null };

function makeSb(cfg: {
  resolve: (state: QueryState) => Result;
  deleteUserError?: { message: string; status?: number } | null;
  deleteUserThrows?: boolean;
  rpcThrows?: string;
  email?: string | null;
}) {
  const calls: QueryState[] = [];
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const authCalls: string[] = [];
  const seq: string[] = [];

  function from(table: string) {
    const state: QueryState = { table, op: "", cols: "" };
    const settle = (): Promise<Result> => {
      calls.push({ ...state });
      seq.push(`${state.table}:${state.op}`);
      return Promise.resolve(cfg.resolve(state));
    };
    const b = {
      select(cols?: string) {
        state.cols = cols ?? "";
        if (!state.op) state.op = "select";
        return b;
      },
      insert(payload: unknown) {
        state.op = "insert";
        state.payload = payload;
        return b;
      },
      update(payload: unknown) {
        state.op = "update";
        state.payload = payload;
        return b;
      },
      delete() {
        state.op = "delete";
        return b;
      },
      eq: () => b,
      is: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      single: () => settle(),
      maybeSingle: () => settle(),
      then: (ok: (r: Result) => unknown, no?: (e: unknown) => unknown) => settle().then(ok, no),
    };
    return b;
  }

  return {
    calls,
    rpcs,
    authCalls,
    seq,
    client: {
      from,
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcs.push({ name, args });
        seq.push(`rpc:${name}`);
        if (cfg.rpcThrows === name) return Promise.reject(new Error("fetch failed"));
        return Promise.resolve(cfg.resolve({ table: `rpc:${name}`, op: "rpc", cols: "" }));
      },
      auth: {
        admin: {
          getUserById: async () => ({
            data: {
              user: {
                email: cfg.email ?? "gone@example.com",
                created_at: "2026-09-01T10:00:00Z",
                last_sign_in_at: "2026-10-20T08:30:00Z",
              },
            },
          }),
          signOut: async () => {
            authCalls.push("signOut");
            seq.push("auth:signOut");
            return { error: null };
          },
          deleteUser: async (_id: string, soft?: boolean) => {
            authCalls.push(`deleteUser:${soft === true ? "soft" : "hard"}`);
            seq.push("auth:deleteUser");
            if (cfg.deleteUserThrows) throw new Error("socket hang up");
            return { error: cfg.deleteUserError ?? null };
          },
        },
      },
    },
  };
}

function resolver(rows: MembershipRow[], overrides: (s: QueryState) => Result | null = () => null) {
  return (s: QueryState): Result => {
    const override = overrides(s);
    if (override) return override;
    if (s.table === "tenant_users" && s.op === "select") {
      return { data: rows, error: null };
    }
    if (s.table === "tenants" && s.op === "select") {
      return { data: [{ id: "t-orphan", display_name: "Acme Growth" }], error: null };
    }
    if (s.table === "account_deletions" && s.op === "insert") {
      return { data: { id: "audit-1" }, error: null };
    }
    if (s.table === "rpc:account_deletion_abort") return { data: "failed", error: null };
    if (s.table === "account_deletions" && s.op === "update" && (s.payload as { status?: string })?.status === "soft_deleted") {
      return { data: [{ id: "x" }], error: null };
    }
    if (s.table === "social_connected_accounts") return { data: [], error: null };
    return { data: null, error: null };
  };
}

describe("softDeleteAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks the account out and reports which workspaces went with it", async () => {
    const rows = [
      member("t-solo", ME, "owner"),
      member("t-shared", ME, "member"),
      member("t-shared", OTHER, "owner"),
    ];
    const sb = makeSb({ resolve: resolver(rows) });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    const result = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });

    expect(result).toEqual({
      deleted_user_id: ME,
      deleted_tenants: ["t-solo"],
      left_tenants: ["t-shared"],
    });
    expect(sb.authCalls).toEqual(["signOut", "deleteUser:soft"]);
    expect(sb.calls).toContainEqual(
      expect.objectContaining({ table: "tenant_users", op: "delete" }),
    );
    expect(invalidateCachedTenant).toHaveBeenCalledWith(ME);
  });

  it("writes the audit row BEFORE it destroys the account", async () => {
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")]) });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });

    const auditAt = sb.seq.indexOf("rpc:account_deletion_begin");
    const killAt = sb.seq.indexOf("auth:deleteUser");
    const membershipDropAt = sb.seq.indexOf("tenant_users:delete");
    expect(auditAt).toBeGreaterThanOrEqual(0);
    expect(auditAt).toBeLessThan(killAt);
    expect(killAt).toBeLessThan(membershipDropAt);

    const audit = sb.rpcs.find((r) => r.name === "account_deletion_begin")!.args;
    expect(audit.p_email_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(audit)).not.toContain("@");
    expect(audit.p_source).toBe("mobile");
    expect(audit.p_deleted_tenant_ids).toEqual(["t-solo"]);
    const days = (Date.parse(audit.p_purge_after as string) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(PURGE_GRACE_DAYS - 1);
  });

  it("kills the workspace's stored credentials immediately, not on the 30-day clock", async () => {
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")]) });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });

    expect(sb.rpcs).toContainEqual({
      name: "purge_tenant_credentials",
      args: { p_tenant_id: "t-solo" },
    });
    expect(sb.calls).toContainEqual(
      expect.objectContaining({
        table: "tenant_agent_schedules",
        op: "update",
        payload: { enabled: false },
      }),
    );
  });

  it("leaves a surviving workspace's shared connectors alone", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-shared", ME, "member"), member("t-shared", OTHER, "owner")]),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" });

    expect(sb.rpcs.map((r) => r.name)).not.toContain("purge_tenant_credentials");
    expect(sb.calls).not.toContainEqual(
      expect.objectContaining({ table: "tenants", op: "update" }),
    );
  });

  it("refuses a sole owner with other members, and changes NOTHING", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-orphan", ME, "owner"), member("t-orphan", OTHER, "member")]),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    const err = await softDeleteAccount({
      user_id: ME,
      access_token: "tok",
      session_id: null,
      source: "mobile",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AccountDeletionError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("owner_transfer_required");
    expect(err.message).toContain("Acme Growth");
    expect(err.message).toMatch(/owner/i);
    expect(sb.authCalls).toEqual([]);
    expect(sb.calls.some((c) => c.table === "account_deletions")).toBe(false);
  });

  it("refuses without touching the account when the audit row cannot be written", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner")], (s) =>
        s.table === "rpc:account_deletion_begin"
          ? { data: null, error: { message: "disk full" } }
          : null,
      ),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    await expect(
      softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "api" }),
    ).rejects.toBeInstanceOf(AccountDeletionError);
    expect(sb.authCalls).toEqual([]);
    const begun = sb.rpcs.find((r) => r.name === "account_deletion_begin")!.args.p_deletion_id;
    expect(sb.rpcs.find((r) => r.name === "account_deletion_abort")!.args).toEqual({ p_deletion_id: begun, p_definite: true });
  });

  it("reports a failure to destroy the account, without tearing anything down", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner")]),
      deleteUserError: { message: "user cannot be deleted", status: 422 },
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    const err = await softDeleteAccount({
      user_id: ME,
      access_token: "tok",
      session_id: null,
      source: "mobile",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AccountDeletionError);
    expect(err.status).toBe(500);
    expect(sb.calls).not.toContainEqual(
      expect.objectContaining({ table: "tenant_users", op: "delete" }),
    );
    const begun = sb.rpcs.find((r) => r.name === "account_deletion_begin")!.args.p_deletion_id;
    expect(sb.rpcs.find((r) => r.name === "account_deletion_abort")!.args).toEqual({ p_deletion_id: begun, p_definite: true });
    expect(sb.calls.some((c) => c.table === "account_deletions" && c.op === "update")).toBe(false);
  });

  it("still succeeds when a teardown step fails, and records where it stopped", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner")], (s) =>
        s.table === "rpc:purge_tenant_credentials"
          ? { data: null, error: { message: "vault timeout" } }
          : null,
      ),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    const result = await softDeleteAccount({
      user_id: ME,
      access_token: "tok",
      session_id: null,
      source: "mobile",
    });

    expect(result.deleted_tenants).toEqual(["t-solo"]);
    const recorded = sb.calls.find(
      (c) =>
        c.table === "account_deletions" &&
        c.op === "update" &&
        Array.isArray((c.payload as { teardown_errors?: unknown })?.teardown_errors),
    );
    expect(recorded).toBeDefined();
    expect(
      (recorded!.payload as { teardown_errors: string[] }).teardown_errors.join(),
    ).toContain("purge_credentials:t-solo");
    expect(sb.calls).toContainEqual(
      expect.objectContaining({ table: "tenant_users", op: "delete" }),
    );
  });

  it("tears down the new-flow sites of a workspace that goes with the account, and only that one", async () => {
    const sb = makeSb({
      resolve: resolver([
        member("t-solo", ME, "owner"),
        member("t-shared", ME, "member"),
        member("t-shared", OTHER, "owner"),
      ]),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    mocks.deleteTenantSites.mockResolvedValueOnce([{ site_id: "s1", result: { complete: true, pending: [] } }]);

    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });

    expect(mocks.deleteTenantSites.mock.calls).toEqual([["t-solo"]]);
    expect(
      sb.calls.some(
        (c) => c.table === "account_deletions" && c.op === "update" &&
          (c.payload as { teardown_errors?: unknown })?.teardown_errors !== undefined,
      ),
    ).toBe(false);
  });

  it("records an incomplete site teardown (and a throwing one) without failing the deletion", async () => {
    const sb = makeSb({ resolve: resolver([member("t-a", ME, "owner"), member("t-b", ME, "owner")]) });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    mocks.deleteTenantSites
      .mockResolvedValueOnce([
        { site_id: "s-ok", result: { complete: true, pending: [] } },
        { site_id: "s-left", result: { complete: false, pending: ["supabase_project", "vault"] } },
      ])
      .mockRejectedValueOnce(new Error("site store down"));

    const result = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" });

    expect(result.deleted_tenants).toEqual(["t-a", "t-b"]);
    const recorded = sb.calls.find(
      (c) => c.table === "account_deletions" && c.op === "update" &&
        Array.isArray((c.payload as { teardown_errors?: unknown })?.teardown_errors),
    );
    const errors = (recorded!.payload as { teardown_errors: string[] }).teardown_errors.join("\n");
    expect(errors).toContain("delete_sites:t-a");
    expect(errors).toContain("s-left");
    expect(errors).toContain("supabase_project");
    expect(errors).not.toContain("s-ok");
    expect(errors).toContain("delete_sites:t-b: site store down");
    expect(sb.rpcs.filter((r) => r.name === "purge_tenant_credentials")).toHaveLength(2);
  });

  it("deletes an account that never onboarded", async () => {
    const sb = makeSb({ resolve: resolver([]) });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    const result = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });

    expect(result).toEqual({ deleted_user_id: ME, deleted_tenants: [], left_tenants: [] });
    expect(sb.authCalls).toEqual(["signOut", "deleteUser:soft"]);
  });

  it("emails Ravi with who left, what went with them and whether they paid", async () => {
    const rows = [
      member("t-solo", ME, "owner"),
      member("t-shared", ME, "member"),
      member("t-shared", OTHER, "owner"),
    ];
    const sb = makeSb({
      email: "leaver@example.com",
      resolve: resolver(rows, (s) => {
        if (s.table === "tenants" && s.op === "select" && s.cols.includes("slug")) {
          return {
            data: [
              { id: "t-solo", display_name: "Solo Co", slug: "solo-co" },
              { id: "t-shared", display_name: "Shared Co", slug: "shared-co" },
            ],
            error: null,
          };
        }
        if (s.table === "tenant_subscriptions") {
          return {
            data: [
              { tenant_id: "t-solo", tier: "pro", status: "active", stripe_subscription_id: "sub_1", comp_expires_at: null },
            ],
            error: null,
          };
        }
        if (s.table === "agent_runs") return { data: [{ created_at: "2026-10-21T12:00:00Z" }], error: null };
        return null;
      }),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" });
    await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledTimes(1));

    const call = mocks.alert.mock.calls[0][0] as {
      msg: string;
      email: { dedupeKey: string; subjectDetail: string; detail: string };
    };
    const begun = sb.rpcs.find((r) => r.name === "account_deletion_begin")!.args.p_deletion_id;
    expect(call.email.dedupeKey).toBe(`account_deleted:${begun}`);
    expect(call.email.subjectDetail).toBe("Account deleted: leaver@example.com");
    const d = call.email.detail;
    expect(d).toContain("Email: leaver@example.com");
    expect(d).toContain("Signed up: 2026-09-01 10:00 UTC");
    expect(d).toContain("Last sign-in: 2026-10-20 08:30 UTC");
    expect(d).toContain("Latest agent run in their companies: 2026-10-21 12:00 UTC");
    expect(d).toContain("Paid plan: yes");
    expect(d).toMatch(/Companies deleted \(1\):\n {2}- Solo Co \(solo-co, t-solo\), plan: pro, paid/);
    expect(d).toMatch(/Companies left, others still there \(1\):\n {2}- Shared Co \(shared-co, t-shared\), plan: free/);
    expect(call.msg).not.toContain("@");
  });

  async function alertDetailFor(rows: ReturnType<typeof member>[], subs: { data: unknown; error: unknown }) {
    const sb = makeSb({
      resolve: resolver(rows, (s) => (s.table === "tenant_subscriptions" ? (subs as never) : null)),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" });
    await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalled());
    const call = mocks.alert.mock.calls.at(-1)![0] as { email: { detail: string } };
    return call.email.detail;
  }

  it("counts a live App Store plan as paid", async () => {
    const d = await alertDetailFor([member("t-solo", ME, "owner")], {
      data: [{ tenant_id: "t-solo", tier: "pro", status: "active", source: "app_store", stripe_subscription_id: null, comp_expires_at: null }],
      error: null,
    });
    expect(d).toContain("Paid plan: yes");
    expect(d).toContain("plan: pro, paid (app_store, active)");
    expect(d).toContain("Check the deleted companies' subscriptions were cancelled.");
  });

  it("says unknown, not unpaid, when the plan read fails", async () => {
    const d = await alertDetailFor([member("t-solo", ME, "owner")], { data: null, error: { message: "boom" } });
    expect(d).toContain("Paid plan: unknown");
    expect(d).not.toContain("Paid plan: no");
    expect(d).toContain("Check the deleted companies' subscriptions were cancelled.");
  });

  it("does not ask to cancel the plan of a company the person only left", async () => {
    const d = await alertDetailFor(
      [member("t-shared", ME, "member"), member("t-shared", OTHER, "owner")],
      {
        data: [{ tenant_id: "t-shared", tier: "pro", status: "active", stripe_subscription_id: "sub_9", comp_expires_at: null }],
        error: null,
      },
    );
    expect(d).toContain("Paid plan: yes");
    expect(d).not.toContain("subscriptions were cancelled");
  });

  it("still deletes, and answers, when the email to Ravi fails", async () => {
    mocks.alert.mockRejectedValueOnce(new Error("sendgrid down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")]) });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    const result = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });

    expect(result).toEqual({ deleted_user_id: ME, deleted_tenants: ["t-solo"], left_tenants: [] });
    expect(sb.authCalls).toEqual(["signOut", "deleteUser:soft"]);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("sendgrid down")));
    warn.mockRestore();
  });

  it("sends no email when the deletion is refused", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-orphan", ME, "owner"), member("t-orphan", OTHER, "member")]),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);

    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});

describe("softDeleteAccount safety (20261116200000)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const staff = (answer: Result) => (s: QueryState) => (s.table === "rpc:account_deletion_staff_block" ? answer : null);

  it("asks the staff check with the verified session, before anything else", async () => {
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")]) });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: "sess-1", source: "web" });
    expect(sb.rpcs[0]).toEqual({ name: "account_deletion_staff_block", args: { p_user_id: ME, p_session_id: "sess-1" } });
  });

  it("refuses a sign-in it cannot identify (no session id), and changes NOTHING", async () => {
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")], staff({ data: "unknown_session", error: null })) });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    const err = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" }).catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.code).toBe("unknown_session");
    expect(err.message).toMatch(/sign in again/);
    expect(sb.authCalls).toEqual([]);
    expect(sb.calls).toEqual([]);
  });

  it("refuses a session minted by a staff login-as, and changes NOTHING", async () => {
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")], staff({ data: "staff_session", error: null })) });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    const err = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: "sess-1", source: "web" }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountDeletionError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("staff_session");
    expect(sb.authCalls).toEqual([]);
    expect(sb.calls).toEqual([]);
    expect(sb.rpcs.map((r) => r.name)).toEqual(["account_deletion_staff_block"]);
  });

  it("refuses within 24 hours of a staff login-as on the person", async () => {
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")], staff({ data: "recent_staff_login", error: null })) });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    const err = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: "own", source: "mobile" }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("recent_staff_access");
    expect(err.message).toMatch(/24 hours/);
    expect(sb.authCalls).toEqual([]);
    expect(sb.calls).toEqual([]);
  });

  it("fails closed when the staff check cannot run or answers something unknown", async () => {
    for (const answer of [{ data: null, error: { message: "db down" } }, { data: "maybe", error: null }]) {
      const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")], staff(answer)) });
      mocks.selfAccountClient.mockReturnValue(sb.client);
      const err = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" }).catch((e) => e);
      expect(err.status).toBe(503);
      expect(sb.authCalls).toEqual([]);
      expect(sb.calls).toEqual([]);
    }
  });

  it("writes the request as pending, and makes it soft_deleted only after GoTrue deleted the login", async () => {
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")]) });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });
    const marks = sb.calls.filter((c) => c.table === "account_deletions" && c.op === "update");
    expect(marks.map((c) => c.payload)).toEqual([{ status: "soft_deleted" }]);
    expect(sb.seq.indexOf("account_deletions:update")).toBeGreaterThan(sb.seq.indexOf("auth:deleteUser"));
    expect(sb.rpcs.map((r) => r.name)).not.toContain("account_deletion_abort");
  });

  it("never marks the request soft_deleted when GoTrue failed (it stays failed or pending)", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner")], (s) =>
        s.table === "account_deletions" && s.op === "update" ? { data: null, error: { message: "write lost" } } : null,
      ),
      deleteUserError: { message: "user cannot be deleted", status: 422 },
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    const err = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" }).catch((e) => e);
    expect(err.status).toBe(500);
    expect(sb.calls.filter((c) => c.table === "account_deletions" && c.op === "update")).toEqual([]);
    expect(sb.rpcs.map((r) => r.name)).toContain("account_deletion_abort");
  });

  it("an unclear login-delete answer (5xx, timeout, dropped connection) is not settled: the request stays pending and staff are paged", async () => {
    for (const cfg of [{ deleteUserError: { message: "504 gateway timeout", status: 504 } }, { deleteUserError: { message: "fetch failed" } }, { deleteUserThrows: true }]) {
      vi.clearAllMocks();
      const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")]), ...cfg });
      mocks.selfAccountClient.mockReturnValue(sb.client);
      const err = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" }).catch((e) => e);
      expect(err.status).toBe(500);
      expect(sb.rpcs.map((r) => r.name)).not.toContain("account_deletion_abort");
      expect(sb.calls.some((c) => c.table === "account_deletions" && c.op === "update")).toBe(false);
      expect(sb.calls.some((c) => c.table === "tenant_users" && c.op === "delete")).toBe(false);
      expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ code: "deletion_unconfirmed" }));
    }
  });

  it("pages when a refused login delete cannot even be settled", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner")], (s) =>
        s.table === "rpc:account_deletion_abort" ? { data: null, error: { message: "db down" } } : null,
      ),
      deleteUserError: { message: "bad request", status: 400 },
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    const err = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" }).catch((e) => e);
    expect(err.status).toBe(500);
    expect(sb.rpcs.map((r) => r.name)).toContain("account_deletion_abort");
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ code: "deletion_abort_failed" }));
    expect(sb.calls.some((c) => c.table === "tenant_users" && c.op === "delete")).toBe(false);
  });

  it("a soft_deleted write that keeps failing leaves the request pending, pages staff, and still finishes the deletion", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner")], (s) =>
        s.table === "account_deletions" && s.op === "update" && (s.payload as { status?: string })?.status === "soft_deleted"
          ? { data: null, error: { message: "timeout" } }
          : null,
      ),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    const result = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });
    expect(result.deleted_tenants).toEqual(["t-solo"]);
    const tries = sb.calls.filter(
      (c) => c.table === "account_deletions" && c.op === "update" && (c.payload as { status?: string })?.status === "soft_deleted",
    );
    expect(tries).toHaveLength(MARK_SOFT_DELETED_TRIES);
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ code: "soft_deleted_status_not_written" }));
    const recorded = sb.calls.find(
      (c) => c.table === "account_deletions" && c.op === "update" && Array.isArray((c.payload as { teardown_errors?: unknown })?.teardown_errors),
    )!;
    expect((recorded.payload as { teardown_errors: string[] }).teardown_errors.join()).toContain("mark_soft_deleted: timeout");
  });

  it("revokes the open invites of a workspace that goes with the account, and only that one", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner"), member("t-shared", ME, "member"), member("t-shared", OTHER, "owner")]),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" });
    const revokes = sb.calls.filter((c) => c.table === "tenant_member_invites");
    expect(revokes).toHaveLength(1);
    expect(revokes[0].op).toBe("update");
    expect(Object.keys(revokes[0].payload as object)).toEqual(["revoked_at"]);
  });

  it("begins the deletion (request + workspace marks, one transaction) before the login kill; teardown does not re-mark", async () => {
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner"), member("t-shared", ME, "member"), member("t-shared", OTHER, "owner")]) });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" });
    expect(sb.rpcs.map((r) => r.name).slice(0, 2)).toEqual(["account_deletion_staff_block", "account_deletion_begin"]);
    const args = sb.rpcs[1].args;
    expect(args.p_user_id).toBe(ME);
    expect(args.p_deleted_tenant_ids).toEqual(["t-solo"]);
    expect(args.p_left_tenant_ids).toEqual(["t-shared"]);
    expect(String(args.p_deletion_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(sb.calls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
    expect(sb.calls.some((c) => c.table === "account_deletions" && c.op === "insert")).toBe(false);
  });

  it("refuses, destroying nothing, when someone joined a workspace or a deletion is already under way", async () => {
    for (const [msg, code] of [
      ["account_deletion: workspace_changed (...)", "workspace_changed"],
      ["account_deletion: already_in_progress (...)", "deletion_in_progress"],
    ] as const) {
      const sb = makeSb({
        resolve: resolver([member("t-solo", ME, "owner")], (s) =>
          s.table === "rpc:account_deletion_begin" ? { data: null, error: { message: msg } } : null,
        ),
      });
      mocks.selfAccountClient.mockReturnValue(sb.client);
      const err = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" }).catch((e) => e);
      expect(err).toBeInstanceOf(AccountDeletionError);
      expect(err.status).toBe(409);
      expect(err.code).toBe(code);
      expect(sb.authCalls).toEqual([]);
      expect(sb.calls.some((c) => c.table === "account_deletions")).toBe(false);
    }
  });

  it("a begin whose answer was lost is undone by the same id, and nothing is destroyed", async () => {
    const sb = makeSb({ resolve: resolver([member("t-solo", ME, "owner")]), rpcThrows: "account_deletion_begin" });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    const err = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "web" }).catch((e) => e);
    expect(err.status).toBe(500);
    const begun = sb.rpcs.find((r) => r.name === "account_deletion_begin")!.args.p_deletion_id;
    expect(sb.rpcs.find((r) => r.name === "account_deletion_abort")!.args).toEqual({ p_deletion_id: begun, p_definite: true });
    expect(sb.authCalls).toEqual([]);
  });

  it("finishes the deletion when the login kill errored but the login is in fact gone", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner")], (s) =>
        s.table === "rpc:account_deletion_abort" ? { data: "soft_deleted", error: null } : null,
      ),
      deleteUserError: { message: "User not found", status: 404 },
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    const result = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });
    expect(result.deleted_tenants).toEqual(["t-solo"]);
    expect(sb.calls.some((c) => c.table === "tenant_users" && c.op === "delete")).toBe(true);
    expect(sb.calls.some((c) => c.table === "account_deletions" && c.op === "update" &&
      (c.payload as { status?: string })?.status !== undefined)).toBe(false);
  });

  it("a begin whose answer was lost after an earlier kill is finished, not left half-done", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner")], (s) =>
        s.table === "rpc:account_deletion_abort" ? { data: "soft_deleted", error: null } : null,
      ),
      rpcThrows: "account_deletion_begin",
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    const result = await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });
    expect(result.deleted_tenants).toEqual(["t-solo"]);
    expect(sb.authCalls).toEqual([]);
    expect(sb.calls.some((c) => c.table === "tenant_users" && c.op === "delete")).toBe(true);
  });

  it("a pending -> soft_deleted switch that finds no pending row is reported, not taken as done", async () => {
    const sb = makeSb({
      resolve: resolver([member("t-solo", ME, "owner")], (s) =>
        s.table === "account_deletions" && s.op === "update" && (s.payload as { status?: string })?.status === "soft_deleted"
          ? { data: [], error: null }
          : null,
      ),
    });
    mocks.selfAccountClient.mockReturnValue(sb.client);
    await softDeleteAccount({ user_id: ME, access_token: "tok", session_id: null, source: "mobile" });
    expect(sb.calls.filter((c) => c.table === "account_deletions" && (c.payload as { status?: string })?.status === "soft_deleted")).toHaveLength(1);
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ code: "soft_deleted_status_not_written" }));
  });
});
