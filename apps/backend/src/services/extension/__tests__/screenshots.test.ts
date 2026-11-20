
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_A2 = "22222222-2222-4222-8222-222222222222";
const P1 = `${TENANT_A}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg`;
const P2 = `${TENANT_A}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg`;

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

function makeFrom(table: string) {
  const preds: ((r: Row) => boolean)[] = [];
  let inserted: Row[] | null = null;
  const run = () => {
    if (inserted) {
      (tables[table] ??= []).push(...inserted);
      return { data: null, error: null };
    }
    return { data: (tables[table] ?? []).filter((r) => preds.every((p) => p(r))), error: null };
  };
  const chain: any = {
    select: () => chain,
    insert: (rows: Row[]) => {
      inserted = rows;
      return chain;
    },
    eq: (c: string, v: unknown) => {
      preds.push((r) => r[c] === v);
      return chain;
    },
    is: (c: string, v: unknown) => {
      preds.push((r) => (r[c] ?? null) === v);
      return chain;
    },
    maybeSingle: async () => {
      const { data } = run();
      return { data: (data as Row[])[0] ?? null, error: null };
    },
    then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
  };
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: (t: string) => makeFrom(t) }),
}));

import {
  recordExtensionScreenshot,
  validateScreenshotTurn,
} from "@/services/extension/screenshots";

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  tables.extension_screenshots = [
    { id: "r1", tenant_id: TENANT_A, user_id: USER_A, image_path: P1, deleted_at: null },
    { id: "r2", tenant_id: TENANT_A, user_id: USER_A2, image_path: P2, deleted_at: null },
  ];
});

const v = (image_paths: string[] | undefined, user_id = USER_A, tenant_id = TENANT_A) =>
  validateScreenshotTurn({ tenant_id, user_id, image_paths });

describe("validateScreenshotTurn", () => {
  it("accepts exactly one live screenshot owned by this user in this tenant", async () => {
    expect(await v([P1])).toEqual({ ok: true });
  });

  it("0 or 2 image_paths → refused", async () => {
    expect((await v([])).ok).toBe(false);
    expect((await v(undefined)).ok).toBe(false);
    expect((await v([P1, P1])).ok).toBe(false);
    expect((await v([P1, P2])).ok).toBe(false);
  });

  it("a path with no ledger row (e.g. a pasted chat image) → refused", async () => {
    const pasted = `${TENANT_A}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg`;
    const r = await v([pasted]);
    expect(r).toMatchObject({ ok: false, code: "screenshot_not_found" });
  });

  it("a TEAMMATE's screenshot → refused", async () => {
    expect((await v([P2])).ok).toBe(false);
  });

  it("the same user's path read from ANOTHER tenant → refused", async () => {
    expect((await v([P1], USER_A, TENANT_B)).ok).toBe(false);
  });

  it("a revoked (soft-deleted) screenshot → refused", async () => {
    tables.extension_screenshots[0].deleted_at = "2026-09-17T00:00:00Z";
    expect((await v([P1])).ok).toBe(false);
  });
});

describe("recordExtensionScreenshot", () => {
  it("stamps tenant_id from the scope (never from the caller's row)", async () => {
    await recordExtensionScreenshot(TENANT_B, USER_A, `${TENANT_B}/x.jpg`);
    const row = tables.extension_screenshots.at(-1)!;
    expect(row).toMatchObject({ tenant_id: TENANT_B, user_id: USER_A, image_path: `${TENANT_B}/x.jpg` });
  });
});
