import { describe, it, expect, vi, beforeEach } from "vitest";

import { notifyThreadOwner, sendPushForEvent, type FanoutDeps } from "../push-fanout";

type Row = Record<string, unknown>;

type Fixture = {
  flagOn: boolean | undefined;
  devicesByTenant: Record<string, Row[]>;
  settingsByTenant: Record<string, Row[]>;
};

function makeDb(fx: Fixture, calls: { table: string; eqs: [string, unknown][] }[]) {
  function builder(table: string) {
    const eqs: [string, unknown][] = [];
    const ins: [string, unknown[]][] = [];
    const rec = { table, eqs };
    calls.push(rec);

    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        eqs.push([col, val]);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        ins.push([col, vals]);
        return api;
      },
      maybeSingle: async () => {
        if (table === "system_config") {
          return {
            data: { blob: fx.flagOn === undefined ? {} : { push_notifications_enabled: fx.flagOn } },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      then: (resolve: (v: { data: Row[]; error: null }) => void) => {
        let data: Row[] = [];
        if (table === "devices") {
          const tenantEq = eqs.find(([c]) => c === "tenant_id");
          const tid = tenantEq?.[1] as string | undefined;
          data = tid ? fx.devicesByTenant[tid] ?? [] : [];
          const userEq = eqs.find(([c]) => c === "user_id");
          if (userEq) data = data.filter((r) => r.user_id === userEq[1]);
        } else if (table === "notification_settings") {
          const tenantEq = eqs.find(([c]) => c === "tenant_id");
          const tid = tenantEq?.[1] as string | undefined;
          let rows = tid ? fx.settingsByTenant[tid] ?? [] : [];
          const userIn = ins.find(([c]) => c === "user_id");
          if (userIn) {
            const allowed = new Set(userIn[1] as string[]);
            rows = rows.filter((r) => allowed.has(r.user_id as string));
          }
          data = rows;
        }
        resolve({ data, error: null });
      },
    };
    return api;
  }
  return { from: builder };
}

const BASE = {
  agent_slug: "growth-lead",
  thread_id: "11111111-1111-1111-1111-111111111111",
  title: "t",
  body: "b",
  user_id: "u1",
};

const T1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const T2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("sendPushForEvent", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchMock: any;
  let sentBodies: any[][];

  beforeEach(() => {
    sentBodies = [];
    fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      sentBodies.push(init?.body ? JSON.parse(init.body) : []);
      return { ok: true, status: 200 } as Response;
    });
  });

  function deps(fx: Fixture, calls: { table: string; eqs: [string, unknown][] }[]): FanoutDeps {
    return { db: makeDb(fx, calls) as any, fetchFn: fetchMock as any };
  }

  it("a result milestone reaches only its person's devices in this tenant, carries its type, and obeys their setting", async () => {
    const devices = {
      [T1]: [
        { user_id: "u1", expo_push_token: "ExpoTok[owner]" },
        { user_id: "u9", expo_push_token: "ExpoTok[teammate]" },
      ],
    };
    const milestone = { ...BASE, tenant_id: T1, kind: "result_milestone" as const, thread_id: null };
    const res = await sendPushForEvent(milestone, deps({ flagOn: true, devicesByTenant: devices, settingsByTenant: {} }, []));
    expect(res.sent).toBe(1);
    expect(sentBodies[0].map((m) => m.to)).toEqual(["ExpoTok[owner]"]);
    expect(sentBodies[0][0].data).toEqual({ type: "result_milestone", agent_slug: "growth-lead", thread_id: null });

    const off = await sendPushForEvent(
      milestone,
      deps(
        {
          flagOn: true,
          devicesByTenant: devices,
          settingsByTenant: { [T1]: [{ user_id: "u1", agent_replies: false, approvals: true, daily_brief: false }] },
        },
        [],
      ),
    );
    expect(off).toEqual({ sent: 0, skipped_reason: "no_eligible_users" });
  });

  it("(a) NEVER selects another tenant's device (cross-tenant isolation)", async () => {
    const fx: Fixture = {
      flagOn: true,
      devicesByTenant: {
        [T1]: [{ user_id: "u1", expo_push_token: "ExpoTok[T1-u1]" }],
        [T2]: [{ user_id: "u2", expo_push_token: "ExpoTok[T2-u2]" }],
      },
      settingsByTenant: {},
    };
    const calls: { table: string; eqs: [string, unknown][] }[] = [];

    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "agent_reply" },
      deps(fx, calls),
    );

    const deviceRead = calls.find((c) => c.table === "devices");
    expect(deviceRead).toBeTruthy();
    expect(deviceRead!.eqs).toContainEqual(["tenant_id", T1]);
    expect(
      calls.every((c) => !c.eqs.some(([col, v]) => col === "tenant_id" && v === T2)),
    ).toBe(true);

    expect(res.sent).toBe(1);
    const allTokens = sentBodies.flat().map((m: any) => m.to);
    expect(allTokens).toEqual(["ExpoTok[T1-u1]"]);
    expect(allTokens).not.toContain("ExpoTok[T2-u2]");
  });

  it("(b) settings filter — an approvals-off user gets no approval push", async () => {
    const fx: Fixture = {
      flagOn: true,
      devicesByTenant: {
        [T1]: [
          { user_id: "u1", expo_push_token: "tok-u1" },
          { user_id: "u2", expo_push_token: "tok-u2" },
        ],
      },
      settingsByTenant: {
        [T1]: [
          { user_id: "u1", agent_replies: true, approvals: true, daily_brief: false },
          { user_id: "u2", agent_replies: true, approvals: false, daily_brief: false },
        ],
      },
    };
    const calls: { table: string; eqs: [string, unknown][] }[] = [];

    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "approval" },
      deps(fx, calls),
    );

    expect(res.sent).toBe(1);
    const tokens = sentBodies.flat().map((m: any) => m.to);
    expect(tokens).toEqual(["tok-u1"]);
    expect(tokens).not.toContain("tok-u2");
    expect(sentBodies.flat()[0].data).toEqual({
      type: "approval",
      agent_slug: BASE.agent_slug,
      thread_id: BASE.thread_id,
    });
  });

  it("(b2) a user with NO settings row gets agent_reply + approval by default", async () => {
    const fx: Fixture = {
      flagOn: true,
      devicesByTenant: { [T1]: [{ user_id: "u1", expo_push_token: "tok-u1" }] },
      settingsByTenant: {},
    };
    const calls: { table: string; eqs: [string, unknown][] }[] = [];

    const reply = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "agent_reply" },
      deps(fx, calls),
    );
    expect(reply.sent).toBe(1);

    const approval = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "approval" },
      deps(fx, calls),
    );
    expect(approval.sent).toBe(1);
  });

  it("(c) flag OFF → zero sends, no fetch call", async () => {
    const fx: Fixture = {
      flagOn: false,
      devicesByTenant: { [T1]: [{ user_id: "u1", expo_push_token: "tok-u1" }] },
      settingsByTenant: {},
    };
    const calls: { table: string; eqs: [string, unknown][] }[] = [];

    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "agent_reply" },
      deps(fx, calls),
    );

    expect(res.skipped_reason).toBe("flag_off");
    expect(res.sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.some((c) => c.table === "devices")).toBe(false);
  });

  it("flag-read error fails CLOSED (treated as OFF)", async () => {
    const erroringDb = {
      from: (_t: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: { message: "boom" } }),
          }),
        }),
      }),
    };
    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "agent_reply" },
      { db: erroringDb as any, fetchFn: fetchMock as any },
    );
    expect(res.skipped_reason).toBe("flag_off");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendPushForEvent — reply pushes go only to the chat owner", () => {
  const fx = {
    flagOn: true,
    devicesByTenant: {
      [T1]: [
        { user_id: "u1", expo_push_token: "tok-u1" },
        { user_id: "u2", expo_push_token: "tok-u2" },
      ],
    },
    settingsByTenant: { [T1]: [] },
  };

  function fakeFetch() {
    const bodies: unknown[] = [];
    const fn = vi.fn(async (_u: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    return { fn, bodies };
  }

  it("agent_reply reaches only the owner's device, never a teammate's", async () => {
    const calls: { table: string; eqs: [string, unknown][] }[] = [];
    const f = fakeFetch();
    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "agent_reply", user_id: "u1" },
      { db: makeDb(fx, calls), fetchFn: f.fn },
    );
    expect(res.sent).toBe(1);
    const tos = (f.bodies.flat() as { to: string }[]).map((m) => m.to);
    expect(tos).toEqual(["tok-u1"]);
  });

  it("agent_reply with no owner sends nothing", async () => {
    const calls: { table: string; eqs: [string, unknown][] }[] = [];
    const f = fakeFetch();
    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "agent_reply", user_id: null },
      { db: makeDb(fx, calls), fetchFn: f.fn },
    );
    expect(res).toEqual({ sent: 0, skipped_reason: "no_owner" });
    expect(f.fn).not.toHaveBeenCalled();
  });

  it("approval still reaches every member's device", async () => {
    const calls: { table: string; eqs: [string, unknown][] }[] = [];
    const f = fakeFetch();
    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "approval", user_id: null },
      { db: makeDb(fx, calls), fetchFn: f.fn },
    );
    expect(res.sent).toBe(2);
  });
});

describe("sendPushForEvent — on by default", () => {
  it("a blob with no push_notifications_enabled key sends", async () => {
    const calls: { table: string; eqs: [string, unknown][] }[] = [];
    const fetchFn = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "agent_reply", user_id: "u1" },
      {
        db: makeDb(
          { flagOn: undefined, devicesByTenant: { [T1]: [{ user_id: "u1", expo_push_token: "tok-u1" }] }, settingsByTenant: { [T1]: [] } },
          calls,
        ),
        fetchFn,
      },
    );
    expect(res.sent).toBe(1);
  });
});

describe("notifyThreadOwner", () => {
  it("pushes the thread's owner with the THREAD's agent slug, so the tap opens that chat", async () => {
    const bodies: unknown[] = [];
    const fetchFn = vi.fn(async (_u: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    const base = makeDb(
      {
        flagOn: true,
        devicesByTenant: { [T1]: [{ user_id: "u1", expo_push_token: "tok-u1" }, { user_id: "u2", expo_push_token: "tok-u2" }] },
        settingsByTenant: { [T1]: [] },
      },
      [],
    );
    const db = {
      from: (table: string) => {
        if (table !== "agent_threads") return base.from(table);
        const eqs: [string, unknown][] = [];
        const api: any = {
          select: () => api,
          eq: (c: string, v: unknown) => (eqs.push([c, v]), api),
          maybeSingle: async () => ({
            data: eqs.some(([c, v]) => c === "tenant_id" && v === T1) ? { user_id: "u2", agent_slug: "operator" } : null,
          }),
        };
        return api;
      },
    };
    const res = await notifyThreadOwner(
      { tenant_id: T1, thread_id: "th-1", agent_slug: "meta_ads", body: "Meta Ads answered your question." },
      { db, fetchFn },
    );
    expect(res.sent).toBe(1);
    const msgs = bodies.flat() as Array<{ to: string; data: { agent_slug: string } }>;
    expect(msgs.map((x) => x.to)).toEqual(["tok-u2"]);
    expect(msgs[0].data.agent_slug).toBe("operator");
  });

  it("sends nothing when the owner deleted the chat before the reply landed", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    const base = makeDb(
      {
        flagOn: true,
        devicesByTenant: { [T1]: [{ user_id: "u2", expo_push_token: "tok-u2" }] },
        settingsByTenant: { [T1]: [] },
      },
      [],
    );
    const db = {
      from: (table: string) => {
        if (table !== "agent_threads") return base.from(table);
        const api: any = {
          select: () => api,
          eq: () => api,
          maybeSingle: async () => ({
            data: { user_id: "u2", agent_slug: "operator", deleted_at: "2026-10-27T10:00:00Z" },
          }),
        };
        return api;
      },
    };
    const res = await notifyThreadOwner(
      { tenant_id: T1, thread_id: "th-1", agent_slug: "operator", body: "Zavi replied." },
      { db, fetchFn },
    );
    expect(res).toEqual({ sent: 0, skipped_reason: "thread_deleted" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("sendPushForEvent — Expo tickets", () => {
  function dbWithDelete(deleted: string[][]) {
    const base = makeDb(
      {
        flagOn: true,
        devicesByTenant: {
          [T1]: [
            { user_id: "u1", expo_push_token: "tok-live" },
            { user_id: "u1", expo_push_token: "tok-gone" },
          ],
        },
        settingsByTenant: { [T1]: [] },
      },
      [],
    );
    return {
      from: (table: string) => {
        const b = base.from(table);
        if (table === "devices") {
          b.delete = () => ({ in: async (_c: string, vals: string[]) => (deleted.push(vals), { error: null }) });
        }
        return b;
      },
    };
  }

  it("counts only ok tickets, sends sound + high priority, and deletes DeviceNotRegistered devices", async () => {
    const deleted: string[][] = [];
    const bodies: Array<Array<Record<string, unknown>>> = [];
    const fetchFn = vi.fn(async (_u: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "agent_reply", user_id: "u1" },
      { db: dbWithDelete(deleted), fetchFn },
    );
    expect(res.sent).toBe(1);
    expect(bodies[0][0]).toMatchObject({ sound: "default", priority: "high" });
    expect(deleted).toEqual([["tok-gone"]]);
  });

  it("an error ticket that is not DeviceNotRegistered is not counted and deletes nothing", async () => {
    const deleted: string[][] = [];
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { status: "error", details: { error: "InvalidCredentials" } },
          { status: "error", details: { error: "InvalidCredentials" } },
        ],
      }),
    })) as unknown as typeof fetch;
    const res = await sendPushForEvent(
      { ...BASE, tenant_id: T1, kind: "agent_reply", user_id: "u1" },
      { db: dbWithDelete(deleted), fetchFn },
    );
    expect(res.sent).toBe(0);
    expect(deleted).toEqual([]);
  });
});
