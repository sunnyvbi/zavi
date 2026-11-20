import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const m = vi.hoisted(() => {
  const state: {
    globals: Array<Record<string, unknown>>;
    overrides: Array<Record<string, unknown>>;
  } = { globals: [], overrides: [] };

  const order = vi.fn(async () => ({ data: state.globals, error: null }));
  const globalsSelect = vi.fn(() => ({ order }));
  const overridesSelect = vi.fn(async () => ({ data: state.overrides, error: null }));
  const from = vi.fn((tbl: string) => {
    if (tbl === "decision_classes") return { select: globalsSelect };
    if (tbl === "tenant_decision_class_overrides") return { select: overridesSelect };
    return {};
  });
  const serverClientFromBearer = vi.fn(() => ({ from }));
  const requireAuth = vi.fn().mockResolvedValue({
    user_id: "10000000-0000-0000-0000-000000000001",
    tenant_id: "00000000-0000-0000-0000-000000000001",
    access_token: "fake-jwt",
  });
  return { state, order, globalsSelect, overridesSelect, from, serverClientFromBearer, requireAuth };
});

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: m.serverClientFromBearer,
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));

import { autonomyList } from "../../routes/approvals/autonomy";

function mkRes(): { res: Response; status: () => number; body: () => unknown } {
  let _s = 200;
  let _b: unknown = null;
  const res = {
    status(c: number) { _s = c; return res; },
    json(b: unknown) { _b = b; return res; },
  } as unknown as Response;
  return { res, status: () => _s, body: () => _b };
}
const mkReq = () => ({ params: {}, query: {}, body: {} } as unknown as Request);

beforeEach(() => {
  m.state.globals = [];
  m.state.overrides = [];
});

type ClassRow = {
  slug: string;
  effective: string;
  never_auto: boolean;
  click_allowlistable: boolean;
  tenant_override: string | null;
};

describe("GET /api/approvals/autonomy — never_auto effective honesty", () => {
  it("a never_auto class with an 'auto' override reports effective='approval'", async () => {
    m.state.globals = [
      {
        slug: "browser.action",
        default_autonomy: "approval",
        description: null,
        dispatch_handler: null,
        never_auto: true,
        click_allowlistable: false,
      },
    ];
    m.state.overrides = [{ decision_class: "browser.action", autonomy: "auto" }];

    const { res, status, body } = mkRes();
    await autonomyList(mkReq(), res);
    expect(status()).toBe(200);
    const classes = (body() as { classes: ClassRow[] }).classes;
    const row = classes.find((c) => c.slug === "browser.action")!;
    expect(row.never_auto).toBe(true);
    expect(row.tenant_override).toBe("auto");
    expect(row.effective).toBe("approval");
  });

  it("a normal class honors its override + exposes click_allowlistable", async () => {
    m.state.globals = [
      {
        slug: "send_email",
        default_autonomy: "approval",
        description: null,
        dispatch_handler: "gmail.send",
        never_auto: false,
        click_allowlistable: true,
      },
    ];
    m.state.overrides = [{ decision_class: "send_email", autonomy: "auto" }];

    const { res, body } = mkRes();
    await autonomyList(mkReq(), res);
    const classes = (body() as { classes: ClassRow[] }).classes;
    const row = classes.find((c) => c.slug === "send_email")!;
    expect(row.never_auto).toBe(false);
    expect(row.click_allowlistable).toBe(true);
    expect(row.effective).toBe("auto");
  });
});
