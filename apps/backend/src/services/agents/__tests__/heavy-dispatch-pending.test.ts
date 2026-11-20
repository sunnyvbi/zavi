import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => {
    throw new Error("tests inject sb");
  },
  asTenantId: (t: string) => t,
}));

import {
  armHeavyDispatchPending,
  claimHeavyDispatchPending,
  restoreHeavyDispatchPending,
  clearHeavyDispatchPending,
  readHeavyDispatchPending,
  parsePending,
  isFreshPending,
  PENDING_TTL_MS,
  type HeavyConfirmPending,
} from "../heavy-dispatch-pending";
import { fakeSb } from "./fake-sb";

const T = "t1";
const TH = "th1";

function world() {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    agent_threads: [{ id: TH, tenant_id: T, heavy_confirm_pending: null }],
  };
  return { tables, sb: fakeSb(tables) };
}

const armArgs = {
  tenant_id: T,
  thread_id: TH,
  armed_run_id: "run-1",
  user_id: "u1",
  target: "engineer",
  intent: "Build a blood donation platform",
  context: { full_build: true },
  est_credits: 2000,
};

describe("armHeavyDispatchPending", () => {
  it("stores the FULL handoff (target, intent, context) with a nonce", async () => {
    const { sb } = world();
    const p = (await armHeavyDispatchPending(armArgs, sb))!;
    const stored = await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, sb);
    expect(stored).toEqual(p);
    expect(p.intent).toBe("Build a blood donation platform");
    expect(p.context).toEqual({ full_build: true });
    expect(p.nonce).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a second call in the same run replaces the first (the card starts the LAST handoff)", async () => {
    const { sb } = world();
    const a = (await armHeavyDispatchPending(armArgs, sb))!;
    const b = (await armHeavyDispatchPending({ ...armArgs, intent: "corrected intent" }, sb))!;
    expect(b.nonce).not.toBe(a.nonce);
    expect((await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, sb))?.intent).toBe(
      "corrected intent",
    );
  });

  it("returns null when the write lands on no thread (no card is promised)", async () => {
    const { sb } = world();
    expect(await armHeavyDispatchPending({ ...armArgs, thread_id: "missing" }, sb)).toBeNull();
  });

  it("a different run re-arms with a new nonce", async () => {
    const { sb } = world();
    const a = (await armHeavyDispatchPending(armArgs, sb))!;
    const b = (await armHeavyDispatchPending({ ...armArgs, armed_run_id: "run-2" }, sb))!;
    expect(b.nonce).not.toBe(a.nonce);
  });
});

describe("claimHeavyDispatchPending", () => {
  it("returns the stored build once, and clears it (single winner)", async () => {
    const { sb, tables } = world();
    const p = (await armHeavyDispatchPending(armArgs, sb))!;
    const [first, second] = await Promise.all([
      claimHeavyDispatchPending({ tenant_id: T, thread_id: TH, nonce: p.nonce }, sb),
      claimHeavyDispatchPending({ tenant_id: T, thread_id: TH, nonce: p.nonce }, sb),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(tables.agent_threads[0].heavy_confirm_pending).toBeNull();
  });

  it("refuses a wrong nonce (an old card cannot start a newer build)", async () => {
    const { sb } = world();
    await armHeavyDispatchPending(armArgs, sb);
    const got = await claimHeavyDispatchPending(
      { tenant_id: T, thread_id: TH, nonce: "00000000-0000-0000-0000-000000000000" },
      sb,
    );
    expect(got).toBeNull();
  });

  it("refuses a stale token", async () => {
    const { sb, tables } = world();
    const p = (await armHeavyDispatchPending(armArgs, sb))!;
    (tables.agent_threads[0].heavy_confirm_pending as HeavyConfirmPending).armed_at = new Date(
      Date.now() - PENDING_TTL_MS - 1000,
    ).toISOString();
    expect(
      await claimHeavyDispatchPending({ tenant_id: T, thread_id: TH, nonce: p.nonce }, sb),
    ).toBeNull();
  });

  it("restore puts it back only onto an empty slot", async () => {
    const { sb } = world();
    const p = (await armHeavyDispatchPending(armArgs, sb))!;
    await claimHeavyDispatchPending({ tenant_id: T, thread_id: TH, nonce: p.nonce }, sb);
    await restoreHeavyDispatchPending({ tenant_id: T, thread_id: TH, pending: p }, sb);
    expect((await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, sb))?.nonce).toBe(
      p.nonce,
    );
    const newer = (await armHeavyDispatchPending({ ...armArgs, armed_run_id: "run-9" }, sb))!;
    await restoreHeavyDispatchPending({ tenant_id: T, thread_id: TH, pending: p }, sb);
    expect((await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, sb))?.nonce).toBe(
      newer.nonce,
    );
  });
});

describe("hold writes that fail (PostgREST returns { error }, codex review of #3272)", () => {
  const failingThreads = (tables: Record<string, Array<Record<string, unknown>>>) =>
    fakeSb(tables, { failUpdate: (t) => t === "agent_threads" });

  it("arm: an update error returns null, so the gate never promises a Start card", async () => {
    const { tables } = world();
    expect(await armHeavyDispatchPending(armArgs, failingThreads(tables))).toBeNull();
  });

  it("restore reports whether the token is back", async () => {
    const { sb, tables } = world();
    const p = (await armHeavyDispatchPending(armArgs, sb))!;
    await claimHeavyDispatchPending({ tenant_id: T, thread_id: TH, nonce: p.nonce }, sb);
    expect(
      await restoreHeavyDispatchPending({ tenant_id: T, thread_id: TH, pending: p }, failingThreads(tables)),
    ).toBe(false);
    expect(await restoreHeavyDispatchPending({ tenant_id: T, thread_id: TH, pending: p }, sb)).toBe(true);
    await armHeavyDispatchPending({ ...armArgs, armed_run_id: "run-9" }, sb);
    expect(await restoreHeavyDispatchPending({ tenant_id: T, thread_id: TH, pending: p }, sb)).toBe(false);
  });

  it("clear reports a failed write and leaves the token in place", async () => {
    const { sb, tables } = world();
    const p = (await armHeavyDispatchPending(armArgs, sb))!;
    expect(
      await clearHeavyDispatchPending({ tenant_id: T, thread_id: TH, nonce: p.nonce }, failingThreads(tables)),
    ).toBe(false);
    expect((await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, sb))?.nonce).toBe(p.nonce);
    expect(await clearHeavyDispatchPending({ tenant_id: T, thread_id: TH, nonce: p.nonce }, sb)).toBe(true);
    expect(await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, sb)).toBeNull();
  });

  it("clear is keyed on the nonce: it never drops a newer card, and zero rows is not success", async () => {
    const { sb } = world();
    const old = (await armHeavyDispatchPending(armArgs, sb))!;
    const newer = (await armHeavyDispatchPending({ ...armArgs, armed_run_id: "run-2" }, sb))!;
    expect(await clearHeavyDispatchPending({ tenant_id: T, thread_id: TH, nonce: old.nonce }, sb)).toBe(false);
    expect((await readHeavyDispatchPending({ tenant_id: T, thread_id: TH }, sb))?.nonce).toBe(newer.nonce);
  });
});

describe("parsePending / isFreshPending", () => {
  it("reads an old-shape token (hash only, no intent) as null so the gate re-arms", () => {
    expect(
      parsePending({
        intent_hash: "x",
        armed_run_id: "r",
        target: "engineer",
        est_credits: 2000,
        armed_at: new Date().toISOString(),
      }),
    ).toBeNull();
  });
  it("freshness follows the TTL", () => {
    const p = parsePending({
      nonce: "n",
      target: "engineer",
      intent: "i",
      armed_at: new Date().toISOString(),
    })!;
    expect(isFreshPending(p)).toBe(true);
    expect(isFreshPending(p, Date.now() + PENDING_TTL_MS + 1)).toBe(false);
  });
});
