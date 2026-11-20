import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  global: vi.fn(),
  setting: vi.fn(),
  appSetting: vi.fn(),
  hold: vi.fn(),
  tables: [] as string[],
}));

vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: m.setting }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: vi.fn(),
  globalClient: () => ({
    from: (table: string) => {
      if (table === "app_setting") return { select: () => ({ eq: () => ({ maybeSingle: () => m.appSetting() }) }) };
      if (table !== "system_config") throw new Error(`unexpected global table ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: () => m.global() }) }) };
    },
  }),
  tenantClient: () => ({
    from: (table: string) => {
      m.tables.push(table);
      return { select: () => ({ maybeSingle: () => m.hold() }) };
    },
  }),
}));

import { emailSendHeld } from "../pause";

const T = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  m.tables.length = 0;
  m.global.mockResolvedValue({ data: { blob: {} }, error: null });
  m.setting.mockResolvedValue(true);
  m.appSetting.mockResolvedValue({ data: null, error: null });
  m.hold.mockResolvedValue({ data: null, error: null });
});

describe("emailSendHeld", () => {
  it("nothing stopped: null", async () => {
    expect(await emailSendHeld(T)).toBeNull();
    expect(m.setting).toHaveBeenCalledWith("bulk_outbound_enabled", T);
    expect(m.tables).toEqual(["email_bulk_abuse_holds"]);
  });

  it("the global stop wins over everything else", async () => {
    m.global.mockResolvedValue({ data: { blob: { bulk_email_send_enabled: false } }, error: null });
    m.setting.mockResolvedValue(false);
    expect(await emailSendHeld(T)).toBe("global");
  });

  it("an unreadable global switch is not reported as a global stop, nor as no hold: held-unknown", async () => {
    m.global.mockResolvedValue({ data: null, error: { message: "timeout" } });
    expect(await emailSendHeld(T)).toBe("unknown");
    m.global.mockResolvedValue({ data: { blob: {} }, error: null });
    m.appSetting.mockResolvedValue({ data: null, error: { message: "timeout" } });
    expect(await emailSendHeld(T)).toBe("unknown");
  });

  it("the staff setting off is a global stop", async () => {
    m.appSetting.mockResolvedValue({ data: { value: false }, error: null });
    expect(await emailSendHeld(T)).toBe("global");
  });

  it("a thrown global read is not reported as a global stop, and the workspace's own state still shows", async () => {
    m.global.mockRejectedValue(new Error("socket hang up"));
    m.setting.mockResolvedValue(false);
    expect(await emailSendHeld(T)).toBe("disabled");
  });

  it("a global switch explicitly on is not a stop", async () => {
    m.global.mockResolvedValue({ data: { blob: { bulk_email_send_enabled: true } }, error: null });
    expect(await emailSendHeld(T)).toBeNull();
  });

  it("the workspace switched off with no abuse hold on file (a staff switch-off): disabled, never abuse", async () => {
    m.setting.mockResolvedValue(false);
    expect(await emailSendHeld(T)).toBe("disabled");
    expect(m.tables).toEqual(["email_bulk_abuse_holds"]);
  });

  it("switched off after an abuse hold that was later cleared: disabled", async () => {
    m.setting.mockResolvedValue(false);
    m.hold.mockResolvedValue({ data: { cleared_at: "2026-10-01T00:00:00Z" }, error: null });
    expect(await emailSendHeld(T)).toBe("disabled");
  });

  it("switched off by the abuse shutoff with the hold still open: abuse", async () => {
    m.setting.mockResolvedValue(false);
    m.hold.mockResolvedValue({ data: { cleared_at: null }, error: null });
    expect(await emailSendHeld(T)).toBe("abuse");
  });

  it("switched off but the hold cannot be read: throws instead of guessing abuse or disabled", async () => {
    m.setting.mockResolvedValue(false);
    m.hold.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(emailSendHeld(T)).rejects.toThrow();
  });

  it("an open abuse hold whose switch-off write failed: still abuse", async () => {
    m.hold.mockResolvedValue({ data: { cleared_at: null }, error: null });
    expect(await emailSendHeld(T)).toBe("abuse");
  });

  it("a cleared abuse hold: null", async () => {
    m.hold.mockResolvedValue({ data: { cleared_at: "2026-10-01T00:00:00Z" }, error: null });
    expect(await emailSendHeld(T)).toBeNull();
  });

  it("an unreadable hold throws instead of saying nothing is stopped", async () => {
    m.hold.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(emailSendHeld(T)).rejects.toThrow();
  });
});
