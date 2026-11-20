
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ThreadRow = { id: string; wa_id: string | null; display_name: string | null };

const { fromMock, state } = vi.hoisted(() => {
  const s = {
    memberRole: "admin" as string | null,
    enabledCount: 1,
    pendingCount: 0,
    threadRows: [{ id: "th-1", wa_id: "16692256032", display_name: "Aryaan" }] as ThreadRow[],
  };
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    let headCount: number | null = null;
    builder.select = vi.fn((_cols: string, opts?: { head?: boolean }) => {
      if (opts?.head) headCount = s.enabledCount;
      return builder;
    });
    builder.eq = vi.fn((col: string, val: string) => {
      if (col === "status" && val === "pending") headCount = s.pendingCount;
      return builder;
    });
    builder.order = vi.fn(() => builder);
    builder.limit = vi.fn(async () => ({ data: s.threadRows, error: null }));
    builder.maybeSingle = vi.fn(async () =>
      s.memberRole === null ? { data: null, error: null } : { data: { role: s.memberRole }, error: null },
    );
    builder.then = (resolve: (v: unknown) => unknown) =>
      resolve({ count: headCount, data: null, error: null });
    void table;
    return builder;
  });
  return { fromMock: from, state: s };
});

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: fromMock, rpc: vi.fn(async () => ({ data: null, error: null })) }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ user_id: "u-1", tenant_id: "t-1" })),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { whatsappStatus } from "@/routes/connectors/whatsapp";

function res() {
  const r: Record<string, unknown> & { statusCode: number; body: unknown } = {
    statusCode: 200,
    body: null,
    status(code: number) { r.statusCode = code; return r; },
    json(b: unknown) { r.body = b; return r; },
  };
  return r;
}
const req = () => ({ body: {}, headers: {} }) as never;
const body = (r: ReturnType<typeof res>) =>
  r.body as {
    connected: boolean;
    threads: number;
    handsets?: Array<{ id: string; name: string | null; number: string }>;
  };

describe("GET /api/connectors/whatsapp/status — named, masked handsets", () => {
  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = "tok";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "pnid";
    process.env.WHATSAPP_APP_SECRET = "sec";
    process.env.WHATSAPP_VERIFY_TOKEN = "verify";
    state.memberRole = "admin";
    state.enabledCount = 1;
    state.threadRows = [{ id: "th-1", wa_id: "16692256032", display_name: "Aryaan" }];
  });
  afterEach(() => {
    for (const k of [
      "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID",
      "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN",
    ]) delete process.env[k];
  });

  it("gives an admin the name, the thread id and the masked number — never the raw number", async () => {
    const r = res();
    await whatsappStatus(req(), r as never);
    expect(body(r).handsets).toEqual([{ id: "th-1", name: "Aryaan", number: "+1 ••• ••• 6032" }]);
    expect(JSON.stringify(r.body)).not.toContain("16692256032");
    expect(JSON.stringify(r.body)).not.toContain("6692256032");
  });

  it("keeps several phones apart by name, oldest first as the server returned them", async () => {
    state.enabledCount = 2;
    state.threadRows = [
      { id: "th-1", wa_id: "16692256032", display_name: "Aryaan" },
      { id: "th-2", wa_id: "19255797710", display_name: "Ravi" },
    ];
    const r = res();
    await whatsappStatus(req(), r as never);
    expect(body(r).handsets?.map((h) => h.name)).toEqual(["Aryaan", "Ravi"]);
    expect(body(r).handsets?.map((h) => h.number)).toEqual(["+1 ••• ••• 6032", "+1 ••• ••• 7710"]);
  });

  it("sends a null name for a phone that had no profile name, so the tile falls back to the number", async () => {
    state.threadRows = [{ id: "th-1", wa_id: "16692256032", display_name: null }];
    const r = res();
    await whatsappStatus(req(), r as never);
    expect(body(r).handsets).toEqual([{ id: "th-1", name: null, number: "+1 ••• ••• 6032" }]);
  });

  it("shapes the profile name as untrusted text — whitespace collapsed, invisible characters gone", async () => {
    const RLO = String.fromCharCode(0x202e), ZWSP = String.fromCharCode(0x200b);
    state.threadRows = [{ id: "th-1", wa_id: "16692256032", display_name: `  Ravi${RLO}   R${ZWSP} ` }];
    const r = res();
    await whatsappStatus(req(), r as never);
    expect(body(r).handsets?.[0]?.name).toBe("Ravi R");
  });

  it("withholds the handsets from a member, but still says connected", async () => {
    state.memberRole = "member";
    const r = res();
    await whatsappStatus(req(), r as never);
    expect(body(r).handsets).toEqual([]);
    expect(body(r).connected).toBe(true);
  });

  it("withholds them from a non-member of the tenant too", async () => {
    state.memberRole = null;
    const r = res();
    await whatsappStatus(req(), r as never);
    expect(body(r).handsets).toEqual([]);
  });

  it("returns no handsets when nothing is bound", async () => {
    state.enabledCount = 0;
    state.threadRows = [];
    const r = res();
    await whatsappStatus(req(), r as never);
    expect(body(r).connected).toBe(false);
    expect(body(r).handsets).toEqual([]);
  });

  it("drops a junk wa_id rather than rendering a bullet-only entry", async () => {
    state.threadRows = [
      { id: "th-1", wa_id: "16692256032", display_name: "Aryaan" },
      { id: "th-2", wa_id: "12", display_name: "Junk" },
      { id: "th-3", wa_id: null, display_name: null },
    ];
    const r = res();
    await whatsappStatus(req(), r as never);
    expect(body(r).handsets?.map((h) => h.id)).toEqual(["th-1"]);
  });
});
