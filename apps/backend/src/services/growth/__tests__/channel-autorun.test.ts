import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "@zavi/shared";

type Row = Record<string, unknown>;
const rows: Row[] = [];
let autopilot = true;
const autopilotReads: boolean[] = [];
let failTable: string | null = null;

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      let out = rows.filter((r) => r.table === table && r.tenant_id === tid);
      const fail = () => (failTable === table ? { message: `${table} down` } : null);
      const b = {
        select: () => b,
        eq(c: string, v: unknown) {
          out = out.filter((r) => r[c] === v);
          return b;
        },
        maybeSingle: async () => ({ data: fail() ? null : (out[0] ?? null), error: fail() }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: fail() ? null : out, error: fail() }).then(ok),
      };
      return b;
    },
  }),
}));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: async () => autopilotReads.shift() ?? autopilot }));

import {
  buildAutorunView,
  founderAskFirstSinceOn,
  readChannelAutorunView,
  readEffectiveAutorun,
  resolveChannelAutorun,
  noteAutorunDrift,
  _resetAutorunDriftLog,
} from "../channel-autorun";

const BAKERY = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const ON = "2026-10-12T09:00:00.000Z";
const ap = (on_at: string | null = ON) => ({ enabled: true, on_at });
const founderOff = (channel_slug: string, autorun_set_at: string | null) => ({ channel_slug, autorun: false, autorun_set_by: "founder", autorun_set_at });

beforeEach(() => {
  rows.length = 0;
  autopilot = true;
  autopilotReads.length = 0;
  failTable = null;
  _resetAutorunDriftLog();
});

describe("the rule, pure", () => {
  it("Autopilot on: a channel with no row, a plan-written off and a stored on are all on", () => {
    expect(resolveChannelAutorun(ap(), "seo", null)).toMatchObject({ effective: true, reason: "autopilot" });
    expect(resolveChannelAutorun(ap(), "seo", { channel_slug: "seo", autorun: false, autorun_set_by: "plan" }).effective).toBe(true);
    expect(resolveChannelAutorun(ap(), "seo", { channel_slug: "seo", autorun: true }).effective).toBe(true);
  });

  it("the founder's ask-first after the latest ON is off; before it (or unstamped) is on", () => {
    expect(resolveChannelAutorun(ap(), "seo", founderOff("seo", "2026-10-12T09:00:01.000Z"))).toMatchObject({ effective: false, reason: "ask_first" });
    expect(resolveChannelAutorun(ap(), "seo", founderOff("seo", "2026-10-12T08:59:59.000Z")).effective).toBe(true);
    expect(resolveChannelAutorun(ap(), "seo", founderOff("seo", null)).effective).toBe(true);
  });

  it("Autopilot on again (a newer ON) resets the ask-first", () => {
    const row = founderOff("seo", "2026-10-12T10:00:00.000Z");
    expect(resolveChannelAutorun(ap(ON), "seo", row).effective).toBe(false);
    expect(resolveChannelAutorun(ap("2026-10-13T00:00:00.000Z"), "seo", row).effective).toBe(true);
  });

  it("a concurrent ON and founder OFF resolve by their stamps, the same way on every read; a tie goes to the founder's ask-first (fail closed)", () => {
    const t = "2026-10-12T09:00:00.000Z";
    const tie = founderOff("seo", t);
    const reads = Array.from({ length: 5 }, () => resolveChannelAutorun(ap(t), "seo", tie).effective);
    expect(reads).toEqual([false, false, false, false, false]);
    expect(founderAskFirstSinceOn(founderOff("seo", "2026-10-12T09:00:00.001Z"), t)).toBe(true);
    expect(founderAskFirstSinceOn(founderOff("seo", "2026-10-12T08:59:59.999Z"), t)).toBe(false);
  });

  it("compares at the stamps' full microsecond precision, as Postgres and PostgREST give them", () => {
    const on = "2026-10-12T09:00:00.813400+00:00";
    expect(founderAskFirstSinceOn(founderOff("seo", "2026-10-12T09:00:00.813900+00:00"), on)).toBe(true);
    expect(founderAskFirstSinceOn(founderOff("seo", "2026-10-12T09:00:00.813100+00:00"), on)).toBe(false);
    expect(founderAskFirstSinceOn(founderOff("seo", "2026-10-12T09:00:00.8134+00:00"), on)).toBe(true);
  });

  it("Autopilot on with no recorded ON (a fleet-wide setting): a stamped founder ask-first counts", () => {
    expect(resolveChannelAutorun(ap(null), "seo", founderOff("seo", "2026-01-01T00:00:00Z")).effective).toBe(false);
    expect(resolveChannelAutorun(ap(null), "seo", founderOff("seo", null)).effective).toBe(true);
  });

  it("ChatGPT Ads needs its paid consent even under Autopilot", () => {
    expect(resolveChannelAutorun(ap(), "chatgpt_ads", null)).toMatchObject({ effective: false, reason: "no_paid_consent" });
    expect(resolveChannelAutorun(ap(), "chatgpt_ads", { channel_slug: "chatgpt_ads", autorun: false, autorun_set_by: "plan" }).effective).toBe(false);
    expect(resolveChannelAutorun(ap(), "chatgpt_ads", { channel_slug: "chatgpt_ads", autorun: true, autorun_set_by: "founder", chatgpt_autopilot_consent_at: ON }).effective).toBe(true);
  });

  it("Autopilot off: nothing is effective; the page keeps the stored switch", () => {
    const off = { enabled: false, on_at: null };
    expect(resolveChannelAutorun(off, "seo", { channel_slug: "seo", autorun: true })).toEqual({ effective: false, stored: true, display: true, reason: "autopilot_off" });
    expect(resolveChannelAutorun(off, "seo", null)).toEqual({ effective: false, stored: false, display: false, reason: "autopilot_off" });
  });

  it("the view: every registry channel cgo may run, even with no row; empty when Autopilot is off", () => {
    const view = buildAutorunView(ap(), [founderOff("seo", "2026-10-12T10:00:00Z")]);
    const set = view.effectiveSet();
    expect(set.has("seo")).toBe(false);
    expect(set.has("chatgpt_ads")).toBe(false);
    for (const c of CHANNELS) if (c.slug !== "seo" && c.slug !== "chatgpt_ads") expect(set.has(c.slug)).toBe(true);
    expect(buildAutorunView({ enabled: false, on_at: null }, []).effectiveSet().size).toBe(0);
  });
});

describe("the reads, live and tenant-bound", () => {
  it("Autopilot on: the bakery's ask-first channel is off, another tenant's row is not read", async () => {
    rows.push({ table: "cgo_autopilot_state", tenant_id: BAKERY, on_at: ON });
    rows.push({ table: "tenant_channels", tenant_id: BAKERY, ...founderOff("email_marketing", "2026-10-12T10:00:00Z") });
    rows.push({ table: "tenant_channels", tenant_id: OTHER, ...founderOff("seo", "2026-10-12T10:00:00Z") });
    expect(await readEffectiveAutorun(BAKERY, "email_marketing")).toBe(false);
    expect(await readEffectiveAutorun(BAKERY, "seo")).toBe(true);
    const view = await readChannelAutorunView(BAKERY);
    expect(view.effectiveSet().has("email_marketing")).toBe(false);
    expect(view.effectiveSet().has("instagram_organic")).toBe(true);
  });

  it("Autopilot off: false without reading a channel row", async () => {
    autopilot = false;
    rows.push({ table: "tenant_channels", tenant_id: BAKERY, channel_slug: "seo", autorun: true });
    failTable = "tenant_channels";
    expect(await readEffectiveAutorun(BAKERY, "seo")).toBe(false);
  });

  it("Autopilot turned off between the first read and the rest: answered off, never on (one consistent answer)", async () => {
    rows.push({ table: "cgo_autopilot_state", tenant_id: BAKERY, on_at: ON });
    autopilotReads.push(true, false);
    expect(await readEffectiveAutorun(BAKERY, "seo")).toBe(false);
    autopilotReads.push(true, true, false);
    expect(await readEffectiveAutorun(BAKERY, "seo")).toBe(false);
    autopilotReads.push(true, true, false);
    expect((await readChannelAutorunView(BAKERY)).effectiveSet().size).toBe(0);
  });

  it("a failed read throws (every caller fails closed)", async () => {
    failTable = "cgo_autopilot_state";
    await expect(readEffectiveAutorun(BAKERY, "seo")).rejects.toThrow(/autopilot state read failed/);
    failTable = "tenant_channels";
    await expect(readChannelAutorunView(BAKERY)).rejects.toThrow(/autorun read failed/);
  });
});

describe("observability", () => {
  it("logs once when the effective answer differs from the stored column, never for a match", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const differs = resolveChannelAutorun(ap(), "seo", { channel_slug: "seo", autorun: false, autorun_set_by: "plan" });
    noteAutorunDrift(BAKERY, "seo", differs, "test");
    noteAutorunDrift(BAKERY, "seo", differs, "test");
    noteAutorunDrift(BAKERY, "meta_ads", resolveChannelAutorun(ap(), "meta_ads", { channel_slug: "meta_ads", autorun: true }), "test");
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      evt: "channel_autorun.effective_differs",
      tenant_id: BAKERY,
      channel_slug: "seo",
      stored: false,
      effective: true,
      reason: "autopilot",
      where: "test",
    });
    info.mockRestore();
  });
});
