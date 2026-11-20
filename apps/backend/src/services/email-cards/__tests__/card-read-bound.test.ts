import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));

import { emailCardHandlers } from "@/routes/email-cards";
import type { CardDeps } from "../cards";

const BOUND_MS = 3_000;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "33333333-3333-4333-8333-333333333333";
const CARD = "22222222-2222-4222-8222-222222222222";
const DRAFTED = 4_321;

const body = {
  tool: "sendgrid",
  audience_id: "L1",
  audience_name: "Members",
  audience_count: DRAFTED,
  approved_count: null,
  from_name: "Brightloop",
  from_email: "hello@brightloop.test",
  reply_to: null,
  sendgrid_suppression_group_id: "7",
  variants: [{ content: { subject: "S", preview_text: "" }, html: "<p>v</p>" }],
};

const never = <V,>() => new Promise<V>(() => undefined);
const after = <V,>(ms: number, v: V) => new Promise<V>((resolve) => setTimeout(() => resolve(v), ms));

type Vendors = {
  liveCount?: CardDeps["liveCount"];
  groupName?: CardDeps["groupName"];
  suppression?: CardDeps["suppression"];
  winLine?: () => Promise<unknown>;
  dbMs?: number;
  open?: boolean;
  retryable?: boolean;
};

function harness(v: Vendors = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = <V,>(value: V) => (v.dbMs ? after(v.dbMs, value) : Promise.resolve(value));
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "email_card_view_state") {
        return { ok: true, class: "email_campaign.create_and_send", body, open: v.open ?? true, status: v.retryable ? "failed" : "pending", role: "owner", versions: 1, retryable: v.retryable ?? false, tests: [{ variant: 1, tested_by_me: true, tested_by_approver: true }] };
      }
      if (name === "email_planned_for_card") return db(null);
      if (name === "email_card_send_facts") return db(null);
      if (name === "approve_email_card") return { ok: true, replayed: false, attempt: 1 };
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: v.liveCount ?? (async () => 204),
    groupName: v.groupName ?? (async () => "Newsletter"),
    suppression: v.suppression ?? (async () => ({ suppressed: 3, complete: true })),
    confirmedEmail: () => db("owner@brightloop.test"),
    paused: () => db(false),
    enqueue: async () => undefined,
  };
  const marks = () => db(new Set<string>());
  const winLineOf = (v.winLine ?? (async () => ({ text: "1.0% of delivered click", metric: "clicks", threshold: 0.01, frozen: false }))) as never;
  return { h: emailCardHandlers(deps, marks, winLineOf), calls };
}

function res() {
  return {
    statusCode: 200,
    body: undefined as any,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

const req = (extra: Record<string, unknown> = {}) => ({ params: { rail: "channel_actions", id: CARD }, body: extra }) as never;
const as = (tenant = T1) => mocks.requireAuth.mockResolvedValue({ tenant_id: tenant, user_id: "u-owner" });

async function read(h: ReturnType<typeof harness>["h"], ms = BOUND_MS) {
  const r = res();
  const started = Date.now();
  let at: number | null = null;
  void h.view(req(), r as never).then(() => {
    at = Date.now() - started;
  });
  await vi.advanceTimersByTimeAsync(ms);
  return { r, took: at };
}

beforeEach(() => {
  vi.useFakeTimers();
  as();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a card read does not wait on a vendor", () => {
  it.each([
    ["the live list count", { liveCount: () => never<number | null>() }],
    ["the unsubscribe group name", { groupName: () => never<string | null>() }],
    ["the suppression read", { suppression: () => never<null>() }],
    ["the win line, which asks Composio about Google Analytics", { winLine: () => never<unknown>() }],
    ["all four together", { liveCount: () => never<number | null>(), groupName: () => never<string | null>(), suppression: () => never<null>(), winLine: () => never<unknown>() }],
  ] as Array<[string, Vendors]>)("%s never answers: the card still answers inside the bound", async (_what, vendors) => {
    const { h } = harness(vendors);
    const { r, took } = await read(h);
    expect(took, "the card was still held past the bound").not.toBeNull();
    expect(took as unknown as number).toBeLessThanOrEqual(BOUND_MS);
    expect(r.statusCode).toBe(200);
  });

  it("with nothing known, a vendor that never answers shows no number, invents none, and says it could not check", async () => {
    const { h } = harness({ liveCount: () => never<number | null>(), groupName: () => never<string | null>(), suppression: () => never<null>(), winLine: () => never<unknown>() });
    const { r } = await read(h);
    const card = r.body?.card;
    expect(card?.list).toEqual({ name: "Members", people: null, unchecked: true });
    expect(card.unsubscribe_group_name).toBeNull();
    expect(card.suppression).toEqual({ suppressed: 0, complete: false });
    expect(card.win_line).toBeNull();
    expect(JSON.stringify({ ...card, versions: undefined })).not.toContain(String(DRAFTED));
  });

  it("slow does not add up: reads that each take a second finish in about a second, not the sum", async () => {
    const { h } = harness({
      dbMs: 200,
      liveCount: () => after(1_000, 204),
      groupName: () => after(1_000, "Newsletter"),
      suppression: () => after(1_000, { suppressed: 3, complete: true }),
      winLine: () => after(1_000, null),
    });
    const { r, took } = await read(h, 6_000);
    expect(took).not.toBeNull();
    expect(took as unknown as number).toBeLessThanOrEqual(1_400);
    expect(r.body.card.list).toEqual({ name: "Members", people: 204 });
    expect(r.body.card.unsubscribe_group_name).toBe("Newsletter");
  });
});

describe("a slow vendor falls back to the last real read", () => {
  it("shows the last live number with the could-not-check flag, never the drafted one", async () => {
    let answer: () => Promise<number | null> = async () => 204;
    const { h } = harness({ liveCount: () => answer(), groupName: async () => "Newsletter" });
    expect((await read(h)).r.body.card.list).toEqual({ name: "Members", people: 204 });
    answer = () => never();
    const { r, took } = await read(h);
    expect(took).not.toBeNull();
    expect(r.body.card.list).toEqual({ name: "Members", people: 204, unchecked: true });
  });

  it("keeps the last group name, suppression and win line when those go slow", async () => {
    let slow = false;
    const line = { text: "1.0% of delivered click", metric: "clicks", threshold: 0.01, frozen: false };
    const { h } = harness({
      groupName: () => (slow ? never() : Promise.resolve("Newsletter")),
      suppression: () => (slow ? never() : Promise.resolve({ suppressed: 3, complete: true })),
      winLine: () => (slow ? never() : Promise.resolve(line)),
    });
    await read(h);
    slow = true;
    const { r } = await read(h);
    expect(r.body.card.unsubscribe_group_name).toBe("Newsletter");
    expect(r.body.card.suppression).toEqual({ suppressed: 3, complete: true });
    expect(r.body.card.win_line).toEqual(line);
  });

  it("a read that fails outright drops the old number: a refused list is not shown as still counted", async () => {
    let answer: () => Promise<number | null> = async () => 204;
    const { h } = harness({ liveCount: () => answer() });
    await read(h);
    answer = async () => {
      throw new Error("tool down");
    };
    await read(h);
    answer = () => never();
    const { r } = await read(h);
    expect(r.body.card.list).toEqual({ name: "Members", people: null, unchecked: true });
  });

  it("a late answer is ready for the next read, which needs no second vendor call to show it", async () => {
    let settle: (n: number) => void = () => undefined;
    const liveCount = vi.fn<Parameters<CardDeps["liveCount"]>, ReturnType<CardDeps["liveCount"]>>(() => new Promise((resolve) => { settle = resolve; }));
    const { h } = harness({ liveCount });
    const first = await read(h);
    expect(first.r.body.card.list).toEqual({ name: "Members", people: null, unchecked: true });
    settle(187);
    await vi.advanceTimersByTimeAsync(1);
    liveCount.mockImplementation(() => never());
    const second = await read(h);
    expect(second.r.body.card.list).toEqual({ name: "Members", people: 187, unchecked: true });
  });

  it("another workspace never sees the number: same list id, same card, other tenant", async () => {
    let answer: () => Promise<number | null> = async () => 204;
    const { h } = harness({ liveCount: () => answer(), groupName: async () => "Brightloop private group" });
    await read(h);
    answer = () => never();
    as(T2);
    const { r } = await read(h);
    expect(r.body.card.list).toEqual({ name: "Members", people: null, unchecked: true });
  });

  it("the other workspace does not join the first one's call in flight", async () => {
    const liveCount = vi.fn<Parameters<CardDeps["liveCount"]>, ReturnType<CardDeps["liveCount"]>>(() => never());
    const { h } = harness({ liveCount });
    await read(h);
    as(T2);
    await read(h);
    expect(liveCount.mock.calls.map((c) => c[0])).toEqual([T1, T2]);
  });
});

describe("re-reads do not pile up on a stuck vendor", () => {
  it("six reads at once share one vendor call for the list, the group and the suppression", async () => {
    const liveCount = vi.fn<Parameters<CardDeps["liveCount"]>, ReturnType<CardDeps["liveCount"]>>(() => after(500, 204));
    const groupName = vi.fn<Parameters<CardDeps["groupName"]>, ReturnType<CardDeps["groupName"]>>(() => after(500, "Newsletter"));
    const suppression = vi.fn<Parameters<CardDeps["suppression"]>, ReturnType<CardDeps["suppression"]>>(() => after(500, { suppressed: 3, complete: true }));
    const { h } = harness({ liveCount, groupName, suppression });
    const rs = Array.from({ length: 6 }, () => res());
    const going = Promise.all(rs.map((r) => h.view(req(), r as never)));
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    await going;
    expect(rs.every((r) => r.body.card.list.people === 204)).toBe(true);
    expect(liveCount).toHaveBeenCalledTimes(1);
    expect(groupName).toHaveBeenCalledTimes(1);
    expect(suppression).toHaveBeenCalledTimes(1);
  });

  it("a read stuck for good is retried after the give-up time, so one hang does not freeze the card", async () => {
    const liveCount = vi.fn<Parameters<CardDeps["liveCount"]>, ReturnType<CardDeps["liveCount"]>>(() => never());
    const { h } = harness({ liveCount });
    await read(h);
    await read(h);
    expect(liveCount).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(31_000);
    liveCount.mockImplementation(async () => 99);
    const { r } = await read(h);
    expect(liveCount).toHaveBeenCalledTimes(2);
    expect(r.body.card.list).toEqual({ name: "Members", people: 99 });
  });
});

describe("approve is untouched by what a read remembers", () => {
  it("approve counts the list itself, stamps its own fresh number, and ignores the remembered one", async () => {
    const liveCount = vi.fn<Parameters<CardDeps["liveCount"]>, ReturnType<CardDeps["liveCount"]>>(async () => 204);
    const { h, calls } = harness({ liveCount });
    await read(h);
    liveCount.mockClear();
    liveCount.mockImplementation(async () => 150);
    const r = res();
    const going = h.approve(req({ variant: 1, request_id: "req-12345678" }), r as never);
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    await going;
    expect(liveCount).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.name === "approve_email_card")?.args.p_approved_count).toBe(150);
  });

  it("a retry whose count cannot be read is still refused, even with a number remembered", async () => {
    let answer: () => Promise<number | null> = async () => 204;
    const { h, calls } = harness({ liveCount: () => answer(), retryable: true, open: false });
    await read(h);
    answer = async () => null;
    const r = res();
    const going = h.approve(req({ variant: 1, request_id: "req-12345678" }), r as never);
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    await going;
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe("count_required");
    expect(calls.some((c) => c.name === "approve_email_card")).toBe(false);
  });

  it("the /count number behind seen_people is a fresh read too, never the remembered one", async () => {
    const liveCount = vi.fn<Parameters<CardDeps["liveCount"]>, ReturnType<CardDeps["liveCount"]>>(async () => 204);
    const { h } = harness({ liveCount, suppression: async () => null });
    await read(h);
    liveCount.mockImplementation(async () => 150);
    const r = res();
    const going = h.count(req(), r as never);
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    await going;
    expect(r.body.people).toBe(150);
  });
});
