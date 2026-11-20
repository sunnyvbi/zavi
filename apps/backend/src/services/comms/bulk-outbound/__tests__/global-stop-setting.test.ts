import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: { app_setting: [] as Row[], tenant_app_setting: [] as Row[] } as Record<string, Row[]>,
  failRead: new Set<string>(),
  blob: {} as Record<string, unknown>,
  hold: null as Row | null,
  workspaceFlag: true,
}));

function table(name: string) {
  const filters: Array<[string, unknown]> = [];
  const matches = () => (db.tables[name] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const readErr = () => (db.failRead.has(name) ? { message: `${name} down` } : null);
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => {
      filters.push([k, v]);
      return b;
    },
    maybeSingle: async () => (readErr() ? { data: null, error: readErr() } : { data: matches()[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve(readErr() ? { data: null, error: readErr() } : { data: matches(), error: null }).then(ok, ko),
    upsert: async (row: Row, opts: { onConflict: string }) => {
      const keys = opts.onConflict.split(",");
      const list = (db.tables[name] ??= []);
      const i = list.findIndex((r) => keys.every((k) => r[k] === row[k]));
      if (i >= 0) list[i] = { ...list[i], ...row };
      else list.push({ ...row });
      return { error: null };
    },
    delete: () => {
      const d: Record<string, unknown> = {
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return d;
        },
        then: (ok: (v: unknown) => unknown) => {
          db.tables[name] = (db.tables[name] ?? []).filter((r) => !filters.every(([k, v]) => r[k] === v));
          return Promise.resolve({ error: null }).then(ok);
        },
      };
      return d;
    },
  };
  return b;
}

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ from: table }) }));
vi.mock("@/services/agents/seat-identity", () => ({ seatLabelForToken: () => "seat" }));
vi.mock("@/services/auth/staff-middleware", () => ({ assertStaff: () => ({ user_id: "u-1", email: "staff@zaviagent.com" }) }));
vi.mock("@/services/staff/audit", () => ({ writeStaffAudit: vi.fn(async () => undefined) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  applySecretListEditRpc: vi.fn(),
  StaleRevisionError: class extends Error {},
  staffCrossTenantClient: () => ({ from: table }),
  globalClient: () => ({
    from: (name: string) => {
      if (name === "app_setting") return table(name);
      if (name !== "system_config") throw new Error(`unexpected global table ${name}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { blob: db.blob }, error: null }) }) }) };
    },
  }),
  tenantClient: () => ({
    from: (name: string) => {
      if (name === "email_bulk_abuse_holds") return { select: () => ({ maybeSingle: async () => ({ data: db.hold, error: null }) }) };
      return table(name);
    },
  }),
}));

import { staffSettingsGet, staffSettingsPut } from "@/routes/admin/settings";
import { _resetSettingsCache, getBoolSettingStrictResolved } from "@/services/settings";
import { bulkSendingStoppedGlobally, readGlobalBulkStop } from "../config";
import { emailSendHeld } from "@/services/email-cards/pause";

const T = "11111111-1111-4111-8111-111111111111";

type Res = Response & { body: unknown; code: number };

function res(): Res {
  const r = { body: undefined, code: 200 } as unknown as Res;
  r.status = ((c: number) => {
    r.code = c;
    return r;
  }) as unknown as Res["status"];
  r.json = ((b: unknown) => {
    r.body = b;
    return r;
  }) as unknown as Res["json"];
  return r;
}

async function put(body: Record<string, unknown>) {
  const r = res();
  await staffSettingsPut({ body } as Request, r);
  return r;
}

beforeEach(() => {
  db.tables = { app_setting: [], tenant_app_setting: [] };
  db.failRead.clear();
  db.blob = {};
  db.hold = null;
  _resetSettingsCache();
});

describe("bulk_email_send_enabled: Zavi's own bulk sender stop, as a staff setting", () => {
  it("the staff settings list shows it as a global boolean, on by default", async () => {
    const r = res();
    await staffSettingsGet({} as Request, r);
    const rows = (r.body as { settings: Array<Record<string, unknown>> }).settings;
    const row = rows.find((s) => s.key === "bulk_email_send_enabled");
    expect(row).toMatchObject({
      type: "boolean",
      scope: "global",
      defaultValue: true,
      globalValue: true,
      tenantOverrides: [],
      description: "Zavi's own bulk email sender. Off stops every workspace's Zavi-list sends; email tools still send.",
    });
  });

  it("nothing stored: the sender runs and the founder sees no hold", async () => {
    expect(await readGlobalBulkStop()).toBe("running");
    expect(await bulkSendingStoppedGlobally()).toBe(false);
    expect(await emailSendHeld(T)).toBeNull();
  });

  it("staff switch it off: every send stops and the founder badge reads global; switching it back on restarts it", async () => {
    const off = await put({ key: "bulk_email_send_enabled", scope: "global", value: false });
    expect(off.body).toEqual({ ok: true });
    expect(db.tables.app_setting).toEqual([expect.objectContaining({ key: "bulk_email_send_enabled", value: false, updated_by: "staff@zaviagent.com" })]);
    expect(await readGlobalBulkStop()).toBe("stopped");
    expect(await bulkSendingStoppedGlobally()).toBe(true);
    expect(await emailSendHeld(T)).toBe("global");

    const on = await put({ key: "bulk_email_send_enabled", scope: "global", value: true });
    expect(on.body).toEqual({ ok: true });
    expect(await readGlobalBulkStop()).toBe("running");
    expect(await bulkSendingStoppedGlobally()).toBe(false);
    expect(await emailSendHeld(T)).toBeNull();
  });

  it("the staff toggle's string form 'false' also stops it", async () => {
    await put({ key: "bulk_email_send_enabled", scope: "global", value: "false" });
    expect(await readGlobalBulkStop()).toBe("stopped");
  });

  it("a stored null is not a stop", async () => {
    db.tables.app_setting.push({ key: "bulk_email_send_enabled", value: null });
    expect(await readGlobalBulkStop()).toBe("running");
    expect(await emailSendHeld(T)).toBeNull();
  });

  it("there is no per-workspace override: a tenant write is refused and changes nothing", async () => {
    const r = await put({ key: "bulk_email_send_enabled", scope: "tenant", tenant_id: T, value: false });
    expect(r.code).toBe(400);
    expect(db.tables.tenant_app_setting).toEqual([]);
    expect(await readGlobalBulkStop()).toBe("running");
  });

  it("the setting cannot be read: sending stops (fail closed), and the founder sees held-unknown, not a global stop and not 'no hold'", async () => {
    db.failRead.add("app_setting");
    expect(await readGlobalBulkStop()).toBe("unreadable");
    expect(await bulkSendingStoppedGlobally()).toBe(true);
    expect(await emailSendHeld(T)).toBe("unknown");
  });

  it("a read that failed is not remembered: once the store is back, a staff stop is seen at once", async () => {
    db.failRead.add("app_setting");
    expect(await readGlobalBulkStop()).toBe("unreadable");
    db.failRead.clear();
    db.tables.app_setting.push({ key: "bulk_email_send_enabled", value: false });
    expect(await readGlobalBulkStop()).toBe("stopped");
  });

  it("a stop written straight to the store by another process is seen on the very next read, with no cache wait", async () => {
    await put({ key: "bulk_email_send_enabled", scope: "global", value: true });
    expect(await readGlobalBulkStop()).toBe("running");
    db.tables.app_setting[0].value = false;
    expect(await readGlobalBulkStop()).toBe("stopped");
    expect(await bulkSendingStoppedGlobally()).toBe(true);
    expect(await emailSendHeld(T)).toBe("global");
    db.tables.app_setting[0].value = "FALSE";
    expect(await readGlobalBulkStop()).toBe("stopped");
    db.tables.app_setting[0].value = true;
    expect(await readGlobalBulkStop()).toBe("running");
  });

  it("a malformed stored value is not read as running: sending stops, and it shows as held-unknown", async () => {
    for (const value of ["off", 0, 1, "", { on: true }, ["false"]]) {
      db.tables.app_setting = [{ key: "bulk_email_send_enabled", value }];
      expect(await readGlobalBulkStop()).toBe("unreadable");
      expect(await bulkSendingStoppedGlobally()).toBe(true);
      expect(await emailSendHeld(T)).toBe("unknown");
    }
  });

  it("a legacy system_config value stored as text is parsed strictly: \"false\" stops, junk fails closed", async () => {
    db.blob = { bulk_email_send_enabled: "false" };
    expect(await readGlobalBulkStop()).toBe("stopped");
    expect(await emailSendHeld(T)).toBe("global");
    db.blob = { bulk_email_send_enabled: " FALSE " };
    expect(await readGlobalBulkStop()).toBe("stopped");
    db.blob = { bulk_email_send_enabled: "true" };
    expect(await readGlobalBulkStop()).toBe("running");
    db.blob = { bulk_email_send_enabled: "off" };
    expect(await readGlobalBulkStop()).toBe("unreadable");
    expect(await bulkSendingStoppedGlobally()).toBe(true);
  });

  it("a stop in the setting wins over an old system_config blob that says on", async () => {
    db.tables.app_setting.push({ key: "bulk_email_send_enabled", value: false });
    db.blob = { bulk_email_send_enabled: true };
    expect(await readGlobalBulkStop()).toBe("stopped");
  });

  it("the old system_config stop still stops sending while the setting is on", async () => {
    db.blob = { bulk_email_send_enabled: false };
    expect(await readGlobalBulkStop()).toBe("stopped");
    expect(await emailSendHeld(T)).toBe("global");
  });

  it("switching it off leaves each workspace's own bulk switch untouched", async () => {
    await put({ key: "bulk_email_send_enabled", scope: "global", value: false });
    expect(await getBoolSettingStrictResolved("bulk_outbound_enabled", T)).toBe(true);
    expect(db.tables.tenant_app_setting).toEqual([]);
  });
});
