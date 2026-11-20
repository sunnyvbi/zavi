
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_A2 = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

const tables: Record<string, Row[]> = {};
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let rpcHandler: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown };

const removed: string[][] = [];
const stored = new Set<string>();
let removeError: unknown = null;
let failUpdateOn: string | null = null;

type Extra = (row: Row) => boolean;

function matches(
  row: Row,
  eqs: [string, unknown][],
  nots: [string, string, unknown][],
  extras: Extra[] = [],
): boolean {
  for (const [col, val] of eqs) {
    if (row[col] !== val) return false;
  }
  for (const f of extras) {
    if (!f(row)) return false;
  }
  for (const [col, op, val] of nots) {
    if (op !== "is" || val !== null) throw new Error(`unsupported not(${col}, ${op})`);
    const m = col.match(/^([a-z_]+)->>([a-z_]+)$/);
    if (!m) throw new Error(`unsupported not column ${col}`);
    const parent = row[m[1]] as Record<string, unknown> | null | undefined;
    const child = parent?.[m[2]];
    if (child === undefined || child === null) return false;
  }
  return true;
}

function makeFrom(table: string) {
  const eqs: [string, unknown][] = [];
  const nots: [string, string, unknown][] = [];
  const extras: Extra[] = [];
  let mode: "select" | "update" | "delete" | null = null;
  let updateValues: Row = {};
  let limit = Infinity;

  const run = () => {
    const rows = (tables[table] ?? []).filter((r) => matches(r, eqs, nots, extras));
    if (mode === "update") {
      if (failUpdateOn === table) return { data: null, error: { message: "db down" } };
      for (const r of rows) Object.assign(r, updateValues);
      return { data: null, error: null };
    }
    if (mode === "delete") {
      if (failUpdateOn === table) return { data: null, error: { message: "db down" } };
      tables[table] = (tables[table] ?? []).filter((r) => !rows.includes(r));
      return { data: null, error: null };
    }
    return { data: rows.slice(0, limit).map((r) => ({ ...r })), error: null };
  };

  const chain: any = {
    select: () => {
      mode = "select";
      return chain;
    },
    update: (values: Row) => {
      mode = "update";
      updateValues = values;
      return chain;
    },
    delete: () => {
      mode = "delete";
      return chain;
    },
    eq: (col: string, val: unknown) => {
      eqs.push([col, val]);
      return chain;
    },
    is: (col: string, val: unknown) => {
      extras.push((r) => (r[col] ?? null) === val);
      return chain;
    },
    in: (col: string, vals: unknown[]) => {
      extras.push((r) => vals.includes(r[col]));
      return chain;
    },
    contains: (col: string, val: Record<string, unknown>) => {
      const want = (val.image_paths as string[]) ?? [];
      extras.push((r) => {
        const have = ((r[col] as Record<string, unknown> | undefined)?.image_paths ?? []) as string[];
        return Array.isArray(have) && want.every((w) => have.includes(w));
      });
      return chain;
    },
    not: (col: string, op: string, val: unknown) => {
      nots.push([col, op, val]);
      return chain;
    },
    limit: (n: number) => {
      limit = n;
      return chain;
    },
    maybeSingle: async () => {
      const { data, error } = run();
      const arr = (data ?? []) as Row[];
      return { data: arr[0] ?? null, error };
    },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => makeFrom(table),
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          if (bucket !== "agent-chat-images") throw new Error(`unexpected bucket ${bucket}`);
          if (removeError) return { data: null, error: removeError };
          removed.push([...paths]);
          for (const p of paths) stored.delete(p);
          return { data: paths.map((name) => ({ name })), error: null };
        },
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcHandler(name, args);
    },
  }),
}));

import {
  EXTENSION_CONSENT_VERSION,
  grantExtensionConsent,
  hasCurrentExtensionConsent,
  readExtensionConsent,
  revokeExtensionConsent,
  stripTenantPageContext,
} from "@/services/extension/consent";

function runWithPage(id: string, tenant_id: string): Row {
  return {
    id,
    tenant_id,
    payload: {
      thread_id: `t-${id}`,
      surface: "chrome_extension",
      page_context: {
        url: "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
        title: "Ads Manager",
        dom_scrubbed: "<p>spend 4,120</p>",
      },
    },
  };
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  removed.length = 0;
  stored.clear();
  removeError = null;
  rpcCalls.length = 0;
  rpcHandler = () => ({ data: null, error: null });
});

describe("reading consent (fails closed)", () => {
  it("reports NOT granted when no row exists", async () => {
    tables.extension_consent = [];
    const state = await readExtensionConsent(TENANT_A, USER_A);
    expect(state.granted).toBe(false);
    expect(state.version).toBeNull();
    expect(state.current_version).toBe(EXTENSION_CONSENT_VERSION);
    expect(await hasCurrentExtensionConsent(TENANT_A, USER_A)).toBe(false);
  });

  it("reports granted for a live row at the current version", async () => {
    tables.extension_consent = [
      {
        tenant_id: TENANT_A,
        user_id: USER_A,
        version: EXTENSION_CONSENT_VERSION,
        granted_at: "2026-09-11T00:00:00Z",
        revoked_at: null,
      },
    ];
    expect(await hasCurrentExtensionConsent(TENANT_A, USER_A)).toBe(true);
  });

  it("reports NOT granted once revoked_at is set", async () => {
    tables.extension_consent = [
      {
        tenant_id: TENANT_A,
        user_id: USER_A,
        version: EXTENSION_CONSENT_VERSION,
        granted_at: "2026-09-11T00:00:00Z",
        revoked_at: "2026-09-11T01:00:00Z",
      },
    ];
    expect(await hasCurrentExtensionConsent(TENANT_A, USER_A)).toBe(false);
  });

  it("reports NOT granted when the person consented to OLDER wording", async () => {
    tables.extension_consent = [
      {
        tenant_id: TENANT_A,
        user_id: USER_A,
        version: `${EXTENSION_CONSENT_VERSION}-stale`,
        granted_at: "2026-01-01T00:00:00Z",
        revoked_at: null,
      },
    ];
    expect(await hasCurrentExtensionConsent(TENANT_A, USER_A)).toBe(false);
  });

  it.each(["1", "2", "3"])("reports NOT granted for a live v%s row", async (stale) => {
    expect(EXTENSION_CONSENT_VERSION).toBe("4");
    tables.extension_consent = [
      {
        tenant_id: TENANT_A,
        user_id: USER_A,
        version: stale,
        granted_at: "2026-09-11T00:00:00Z",
        revoked_at: null,
      },
    ];
    const state = await readExtensionConsent(TENANT_A, USER_A);
    expect(state.granted).toBe(false);
    expect(state.version).toBe(stale);
    expect(state.current_version).toBe("4");
  });

  it("is PER PERSON — a teammate's consent does not cover another user", async () => {
    tables.extension_consent = [
      {
        tenant_id: TENANT_A,
        user_id: USER_A,
        version: EXTENSION_CONSENT_VERSION,
        granted_at: "2026-09-11T00:00:00Z",
        revoked_at: null,
      },
    ];
    expect(await hasCurrentExtensionConsent(TENANT_A, USER_A)).toBe(true);
    expect(await hasCurrentExtensionConsent(TENANT_A, USER_A2)).toBe(false);
  });

  it("is PER TENANT — the same person in another workspace is not covered", async () => {
    tables.extension_consent = [
      {
        tenant_id: TENANT_A,
        user_id: USER_A,
        version: EXTENSION_CONSENT_VERSION,
        granted_at: "2026-09-11T00:00:00Z",
        revoked_at: null,
      },
    ];
    expect(await hasCurrentExtensionConsent(TENANT_B, USER_A)).toBe(false);
  });
});

describe("granting", () => {
  it("records the CURRENT version and a timestamp, with the tenant INJECTED", async () => {
    rpcHandler = (_name, args) => ({
      data: {
        tenant_id: args.p_tenant_id,
        user_id: args.p_user_id,
        version: args.p_version,
        granted_at: "2026-09-11T12:00:00Z",
        revoked_at: null,
      },
      error: null,
    });

    const state = await grantExtensionConsent(TENANT_A, USER_A);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe("grant_extension_consent");
    expect(rpcCalls[0].args.p_tenant_id).toBe(TENANT_A);
    expect(rpcCalls[0].args.p_user_id).toBe(USER_A);
    expect(rpcCalls[0].args.p_version).toBe(EXTENSION_CONSENT_VERSION);

    expect(state.granted).toBe(true);
    expect(state.version).toBe(EXTENSION_CONSENT_VERSION);
    expect(state.granted_at).toBe("2026-09-11T12:00:00Z");
    expect(state.revoked_at).toBeNull();
  });
});

const USER_B = "33333333-3333-4333-8333-333333333333";
const shot = (tenant: string, n: string) =>
  `${tenant}/${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}.jpg`;

function screenshotRun(id: string, tenant_id: string, path: string, actor_user_id: string): Row {
  return {
    id,
    tenant_id,
    actor_user_id,
    payload: {
      thread_id: `t-${id}`,
      surface: "chrome_extension",
      image_paths: [path],
      page_context: { mode: "screenshot", url: "https://app.slack.com/client/T1", title: "Slack" },
    },
  };
}

function ledger(id: string, tenant_id: string, user_id: string, image_path: string): Row {
  return { id, tenant_id, user_id, image_path, created_at: "2026-09-17T01:00:00Z", deleted_at: null };
}

describe("revocation erases THIS person's screenshots (user-scoped)", () => {
  const A_MINE_1 = shot(TENANT_A, "a");
  const A_MINE_ORPHAN = shot(TENANT_A, "b");
  const A_TEAMMATE = shot(TENANT_A, "c");
  const B_SAME_USER = shot(TENANT_B, "d");

  beforeEach(() => {
    rpcHandler = (_name, args) => ({
      data: {
        tenant_id: args.p_tenant_id,
        user_id: args.p_user_id,
        version: EXTENSION_CONSENT_VERSION,
        granted_at: "2026-09-11T00:00:00Z",
        revoked_at: "2026-09-11T02:00:00Z",
      },
      error: null,
    });
    tables.extension_screenshots = [
      ledger("l1", TENANT_A, USER_A, A_MINE_1),
      ledger("l2", TENANT_A, USER_A, A_MINE_ORPHAN),
      ledger("l3", TENANT_A, USER_A2, A_TEAMMATE),
      ledger("l4", TENANT_B, USER_A, B_SAME_USER),
    ];
    tables.agent_runs = [
      screenshotRun("r-mine", TENANT_A, A_MINE_1, USER_A),
      screenshotRun("r-teammate", TENANT_A, A_TEAMMATE, USER_A2),
      { ...runWithPage("r-typed-teammate", TENANT_A), actor_user_id: USER_A2 },
      { ...runWithPage("r-typed-mine", TENANT_A), actor_user_id: USER_A },
      screenshotRun("r-other-tenant", TENANT_B, B_SAME_USER, USER_A),
      { id: "r-plain", tenant_id: TENANT_A, actor_user_id: USER_A, payload: { thread_id: "t", image_paths: [A_MINE_1] } },
    ];
  });

  const payloadOf = (id: string) =>
    tables.agent_runs.find((r) => r.id === id)!.payload as Record<string, unknown>;
  const rowOf = (id: string) => tables.extension_screenshots.find((r) => r.id === id)!;

  it("deletes only this user's objects and strips only this user's runs", async () => {
    const { runs_cleared } = await revokeExtensionConsent(TENANT_A, USER_A);

    expect(runs_cleared).toBe(2);
    expect(removed).toEqual([[A_MINE_1, A_MINE_ORPHAN]]);

    expect(payloadOf("r-mine")).not.toHaveProperty("page_context");
    expect(payloadOf("r-mine").image_paths).toEqual([A_MINE_1]);
    expect(payloadOf("r-typed-mine")).not.toHaveProperty("page_context");
    expect(payloadOf("r-teammate")).toHaveProperty("page_context");
    expect(payloadOf("r-typed-teammate")).toHaveProperty("page_context");
    expect(payloadOf("r-other-tenant")).toHaveProperty("page_context");
  });

  it("erases this user's legacy typed capture even when they have no screenshots", async () => {
    tables.extension_screenshots = [];
    const { runs_cleared } = await revokeExtensionConsent(TENANT_A, USER_A);
    expect(runs_cleared).toBe(2);
    expect(payloadOf("r-typed-mine")).not.toHaveProperty("page_context");
    expect(payloadOf("r-typed-teammate")).toHaveProperty("page_context");
    expect(payloadOf("r-other-tenant")).toHaveProperty("page_context");
    expect(removed).toHaveLength(0);
  });

  it("deletes an orphan upload that never reached a chat turn", async () => {
    await revokeExtensionConsent(TENANT_A, USER_A);
    expect(removed.flat()).toContain(A_MINE_ORPHAN);
  });

  it("soft-deletes this user's ledger rows so today's cap count still includes them", async () => {
    await revokeExtensionConsent(TENANT_A, USER_A);
    expect(tables.extension_screenshots).toHaveLength(4);
    expect(rowOf("l1").deleted_at).toEqual(expect.any(String));
    expect(rowOf("l2").deleted_at).toEqual(expect.any(String));
    expect(rowOf("l3").deleted_at).toBeNull();
    expect(rowOf("l4").deleted_at).toBeNull();
  });

  it("CROSS-TENANT: the same person revoking in tenant B leaves tenant A alone", async () => {
    await revokeExtensionConsent(TENANT_B, USER_A);
    expect(removed).toEqual([[B_SAME_USER]]);
    expect(payloadOf("r-other-tenant")).not.toHaveProperty("page_context");
    expect(payloadOf("r-mine")).toHaveProperty("page_context");
    expect(rowOf("l1").deleted_at).toBeNull();
  });

  it("ends this user's panel sessions and expires their pending tab ops, in this tenant only", async () => {
    tables.extension_panel_sessions = [
      { id: "s-mine", tenant_id: TENANT_A, user_id: USER_A, ended_at: null },
      { id: "s-teammate", tenant_id: TENANT_A, user_id: USER_A2, ended_at: null },
      { id: "s-other-tenant", tenant_id: TENANT_B, user_id: USER_A, ended_at: null },
    ];
    tables.extension_browser_ops = [
      { id: "o-queued", tenant_id: TENANT_A, user_id: USER_A, status: "queued", is_write: true },
      { id: "o-awaiting", tenant_id: TENANT_A, user_id: USER_A, status: "awaiting_confirm", is_write: true },
      { id: "o-delivered-write", tenant_id: TENANT_A, user_id: USER_A, status: "delivered", is_write: true },
      { id: "o-delivered-read", tenant_id: TENANT_A, user_id: USER_A, status: "delivered", is_write: false },
      { id: "o-teammate", tenant_id: TENANT_A, user_id: USER_A2, status: "queued", is_write: true },
      { id: "o-other-tenant", tenant_id: TENANT_B, user_id: USER_A, status: "queued", is_write: true },
    ];
    await revokeExtensionConsent(TENANT_A, USER_A);
    const sess = (id: string) => tables.extension_panel_sessions.find((r) => r.id === id)!;
    const op = (id: string) => tables.extension_browser_ops.find((r) => r.id === id)!.status;
    expect(sess("s-mine").ended_at).not.toBeNull();
    expect(sess("s-teammate").ended_at).toBeNull();
    expect(sess("s-other-tenant").ended_at).toBeNull();
    expect(op("o-queued")).toBe("expired");
    expect(op("o-awaiting")).toBe("expired");
    expect(op("o-delivered-read")).toBe("expired");
    expect(op("o-delivered-write")).toBe("unknown");
    expect(op("o-teammate")).toBe("queued");
    expect(op("o-other-tenant")).toBe("queued");
  });

  it("still erases screenshots when ending the tab session fails, then reports the failure", async () => {
    const before = removed.length;
    failUpdateOn = "extension_panel_sessions";
    try {
      await expect(revokeExtensionConsent(TENANT_A, USER_A)).rejects.toThrow();
    } finally {
      failUpdateOn = null;
    }
    expect(removed.length).toBeGreaterThan(before);
  });

  it("does not stop tab work when the revoke RPC fails (nothing was revoked)", async () => {
    rpcHandler = () => ({ data: null, error: { message: "boom" } });
    tables.extension_panel_sessions = [
      { id: "s-mine", tenant_id: TENANT_A, user_id: USER_A, ended_at: null },
    ];
    await expect(revokeExtensionConsent(TENANT_A, USER_A)).rejects.toThrow("boom");
    expect(tables.extension_panel_sessions[0].ended_at).toBeNull();
  });

  it("flips the flag BEFORE erasing, so no turn can capture during the erase", async () => {
    const order: string[] = [];
    const inner = rpcHandler;
    rpcHandler = (name, args) => {
      order.push(`rpc:${name}:removed=${removed.length}`);
      return inner(name, args);
    };
    await revokeExtensionConsent(TENANT_A, USER_A);
    expect(order[0]).toBe("rpc:revoke_extension_consent:removed=0");
    expect(removed).toHaveLength(1);
  });

  it("is idempotent — a second revoke erases nothing and still succeeds", async () => {
    expect((await revokeExtensionConsent(TENANT_A, USER_A)).runs_cleared).toBe(2);
    expect((await revokeExtensionConsent(TENANT_A, USER_A)).runs_cleared).toBe(0);
    expect(removed).toHaveLength(1);
  });

  it("reports NOT granted even when nothing was ever granted", async () => {
    rpcHandler = () => ({ data: null, error: null });
    tables.extension_screenshots = [];
    tables.agent_runs = [];
    const { state, runs_cleared } = await revokeExtensionConsent(TENANT_A, USER_A);
    expect(state.granted).toBe(false);
    expect(runs_cleared).toBe(0);
  });

  it("erases a tab task's step screenshots: no object and no Artifacts-tab row remain", async () => {
    const RUN = "33333333-3333-4333-8333-333333333333";
    const mineStep = `${TENANT_A}/${RUN}/aaaa1111-1111-4111-8111-111111111111.jpg`;
    const mateStep = `${TENANT_A}/${RUN}/cccc3333-3333-4333-8333-333333333333.jpg`;
    const otherTenantStep = `${TENANT_B}/${RUN}/dddd4444-4444-4444-8444-444444444444.jpg`;
    for (const p of [mineStep, mateStep, otherTenantStep]) stored.add(p);
    tables.extension_screenshots.push(
      { ...ledger("s1", TENANT_A, USER_A, mineStep), kind: "task_step", run_id: RUN },
      { ...ledger("s2", TENANT_A, USER_A2, mateStep), kind: "task_step", run_id: RUN },
      { ...ledger("s3", TENANT_B, USER_A, otherTenantStep), kind: "task_step", run_id: RUN },
    );
    const art = (id: string, tenant_id: string, storage_path: string, bucket = "agent-chat-images"): Row =>
      ({ id, tenant_id, run_id: RUN, bucket, storage_path, filename: `tab-task-${id}.jpg` });
    tables.run_artifacts = [
      art("x1", TENANT_A, mineStep),
      art("x2", TENANT_A, mateStep),
      art("x3", TENANT_B, otherTenantStep),
      art("x4", TENANT_A, mineStep, "agent-artifacts"),
    ];

    await revokeExtensionConsent(TENANT_A, USER_A);

    expect(stored.has(mineStep)).toBe(false);
    expect(tables.run_artifacts.some((r) => r.storage_path === mineStep && r.bucket === "agent-chat-images")).toBe(false);
    expect(tables.run_artifacts.map((r) => r.id).sort()).toEqual(["x2", "x3", "x4"]);
    expect(stored.has(mateStep)).toBe(true);
    expect(stored.has(otherTenantStep)).toBe(true);
  });

  it("THROWS when the Artifacts-tab rows cannot be deleted, and leaves the ledger live for a retry", async () => {
    const RUN = "33333333-3333-4333-8333-333333333333";
    const mineStep = `${TENANT_A}/${RUN}/aaaa1111-1111-4111-8111-111111111111.jpg`;
    tables.extension_screenshots.push({ ...ledger("s1", TENANT_A, USER_A, mineStep), kind: "task_step", run_id: RUN });
    tables.run_artifacts = [{ id: "x1", tenant_id: TENANT_A, bucket: "agent-chat-images", storage_path: mineStep }];
    failUpdateOn = "run_artifacts";
    try {
      await expect(revokeExtensionConsent(TENANT_A, USER_A)).rejects.toThrow("db down");
      expect(rowOf("s1").deleted_at).toBeNull();
    } finally {
      failUpdateOn = null;
    }
  });

  it("THROWS when the storage delete fails, and marks nothing deleted", async () => {
    removeError = { message: "storage down" };
    await expect(revokeExtensionConsent(TENANT_A, USER_A)).rejects.toThrow("storage down");
    expect(rowOf("l1").deleted_at).toBeNull();
    expect(payloadOf("r-mine")).toHaveProperty("page_context");
  });

  it("propagates an RPC failure instead of reporting a revocation that did not happen", async () => {
    rpcHandler = () => ({ data: null, error: { message: "boom" } });
    await expect(revokeExtensionConsent(TENANT_A, USER_A)).rejects.toThrow("boom");
    expect(removed).toHaveLength(0);
    expect(payloadOf("r-mine")).toHaveProperty("page_context");
  });
});

describe("stripTenantPageContext", () => {
  it("skips runs that never carried page content", async () => {
    tables.agent_runs = [
      { id: "plain", tenant_id: TENANT_A, payload: { thread_id: "t" } },
      runWithPage("a1", TENANT_A),
    ];
    expect(await stripTenantPageContext(TENANT_A)).toBe(1);
    expect(tables.agent_runs[0].payload).toEqual({ thread_id: "t" });
  });

  it("handles more rows than one batch", async () => {
    tables.agent_runs = Array.from({ length: 1200 }, (_, i) =>
      runWithPage(`a${i}`, TENANT_A),
    );
    expect(await stripTenantPageContext(TENANT_A)).toBe(1200);
    expect(
      tables.agent_runs.filter((r) =>
        Object.prototype.hasOwnProperty.call(r.payload as object, "page_context"),
      ),
    ).toHaveLength(0);
  });

  it("returns 0 for a tenant with nothing stored", async () => {
    tables.agent_runs = [runWithPage("b1", TENANT_B)];
    expect(await stripTenantPageContext(TENANT_A)).toBe(0);
    expect(tables.agent_runs[0].payload).toHaveProperty("page_context");
  });
});
