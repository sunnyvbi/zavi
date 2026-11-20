import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ error: null as null | { code?: string; message: string } }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({ insert: async () => ({ error: m.error }) }) }),
}));

import { recordActivity } from "../recordActivity";

const base = { tenant_id: "t1", verb: "card.copy_clicked", actor_type: "operator" as const, dedupe_key: "k" };

beforeEach(() => {
  m.error = null;
});

describe("recordActivity", () => {
  it("returns inserted on a clean insert", async () => {
    expect(await recordActivity(base)).toBe("inserted");
  });

  it("returns duplicate for a unique violation on its dedupe_key, failed otherwise", async () => {
    m.error = { code: "23505", message: "duplicate key" };
    expect(await recordActivity(base)).toBe("duplicate");
    expect(await recordActivity({ ...base, dedupe_key: null })).toBe("failed");
    m.error = { code: "42501", message: "denied" };
    expect(await recordActivity(base)).toBe("failed");
  });
});
