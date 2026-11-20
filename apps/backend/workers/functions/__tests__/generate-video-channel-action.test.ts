import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const routerMocks = vi.hoisted(() => ({
  isMediaRouterEnabled: vi.fn(),
  submitMedia: vi.fn(),
  pollMediaOnce: vi.fn(),
  cancelMedia: vi.fn(),
  generateMedia: vi.fn(),
  estimateCost: vi.fn(),
  costForJob: vi.fn(),
  downloadMedia: vi.fn(),
}));
const logMocks = vi.hoisted(() => ({ logEvent: vi.fn() }));
const { track } = vi.hoisted(() => ({ track: vi.fn() }));
const flatPricing = vi.hoisted(() => ({ on: false }));
vi.mock("@/services/billing/flat-pricing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/billing/flat-pricing")>()),
  isFlatJobPricingOn: async () => flatPricing.on,
}));
vi.mock("@/services/analytics/mixpanel", () => ({ track }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (...a: unknown[]) => logMocks.logEvent(...a) }));
const chargeMocks = vi.hoisted(() => ({ canAffordMedia: vi.fn(), checkAffordMedia: vi.fn(), flushCharges: vi.fn() }));
const meterMock = vi.hoisted(() => ({ meterPlatformGeneration: vi.fn() }));
const legacyMocks = vi.hoisted(() => ({ submitGeneration: vi.fn(), pollGenerationOnce: vi.fn() }));
const deliveryMocks = vi.hoisted(() => ({ uploadFileToThread: vi.fn(), callSlackTool: vi.fn(), deliverArtifactToThread: vi.fn() }));

vi.mock("@/services/media-router/router", () => routerMocks);
vi.mock("@/services/media-router/charge", () => chargeMocks);
vi.mock("@/services/mcp/higgsfield-meter", () => meterMock);
vi.mock("@/services/launch-video/platform-higgsfield", () => ({
  ...legacyMocks,
  generatePlatformImage: vi.fn(),
  isPlatformHiggsfieldConfigured: vi.fn(() => true),
}));
vi.mock("@/services/tools/slack/upload_file", () => ({ uploadFileToThread: deliveryMocks.uploadFileToThread }));
vi.mock("@/services/mcp/internal/slack", () => ({ callSlackTool: deliveryMocks.callSlackTool }));
vi.mock("@/services/agents/deliver-artifact-to-thread", () => ({ deliverArtifactToThread: deliveryMocks.deliverArtifactToThread }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn(() => makeSb()) }));
const finishMocks = vi.hoisted(() => ({ runFinishPass: vi.fn(), getBoolSetting: vi.fn() }));
vi.mock("@/services/launch-video/finish-pass", () => ({ runFinishPass: finishMocks.runFinishPass }));
vi.mock("@/services/settings", () => ({ getBoolSetting: finishMocks.getBoolSetting }));
const cardMocks = vi.hoisted(() => ({ setChannelActionVideoMedia: vi.fn() }));
vi.mock("@/services/channels/exec-actions", () => cardMocks);
const gateMocks = vi.hoisted(() => ({ channelPlanLock: vi.fn(), isChannelLockedStrict: vi.fn() }));
vi.mock("@/services/growth/preview-plan", () => ({ channelPlanLock: gateMocks.channelPlanLock }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: gateMocks.isChannelLockedStrict }));
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({ isGenerativeVideoEnabled: async () => true }));

import { channelVideoBlock, generateChannelVideoFn, inFlightCardVideoUsd, LEASE_RENEW_EVERY_POLLS, repairDeliveredCharges, runRoutedVideo, settleChannelVideoFailure, videoDisplayName, videoIntentKey } from "../generate-video";
import { migrationColumns, selectedColumns } from "@/__tests__/helpers/migration-columns";
import type { GenerativeVideoIntake } from "@/services/launch-video/generative-video-intake";
import { routedVideoPlan } from "@/services/launch-video/video-estimate";
import type { ChannelActionDeliveryTarget } from "@/services/launch-video/delivery-target";

type JobRow = { tenant_id: string; run_id: string; meter_key: string; model: string; job_id: string | null; status: string; result_url?: string | null; error?: string | null; created_at?: string; updated_at?: string; pending_charges?: unknown };

type Row = Record<string, unknown>;
type CardRow = {
  id: string;
  tenant_id: string;
  exec_class: string;
  exec_status: string;
  exec_claim_id: string | null;
  exec_claimed_at: string | null;
  exec_payload: { intake: GenerativeVideoIntake };
  executed_at: string | null;
  body?: { cost_credits?: number };
};

const schemaViolations: string[] = [];

afterEach(() => {
  const seen = schemaViolations.splice(0);
  expect(seen).toEqual([]);
});

function memTable(table: string, rows: Row[], failing: () => boolean) {
  const known = migrationColumns(table);
  for (const r of rows) for (const k of Object.keys(r)) if (!known.has(k)) throw new Error(`fixture column ${table}.${k} does not exist in supabase/migrations`);
  const query = (patch: Row | null) => {
    const preds: Array<(r: Row) => boolean> = [];
    let projection: string[] | null = null;
    const unknown: string[] = [];
    const use = (cols: string[]) => {
      for (const c of cols) if (!known.has(c)) unknown.push(c);
    };
    if (patch) use(Object.keys(patch));
    const run = () => {
      if (unknown.length > 0) {
        schemaViolations.push(...unknown.map((c) => `${table}.${c}`));
        return { data: null, error: { message: `column ${table}.${unknown[0]} does not exist`, code: "42703" } };
      }
      if (failing()) return { data: null, error: { message: "read failed" } };
      const m = rows.filter((r) => preds.every((pr) => pr(r)));
      if (patch) for (const r of m) Object.assign(r, patch);
      const out = projection ? m.map((r) => Object.fromEntries(projection!.map((c) => {
        const json = /^([a-z_]+):([a-z_]+)->([a-z_]+)$/.exec(c);
        if (json) return [json[1], (r[json[2]] as Row | null)?.[json[3]] ?? null];
        return [c, r[c] ?? null];
      }))) : m.map((r) => ({ ...r }));
      return { data: out, error: null };
    };
    const api: Record<string, unknown> = {
      eq: (k: string, v: unknown) => (use([k]), preds.push((r) => r[k] === v), api),
      in: (k: string, vs: unknown[]) => (use([k]), preds.push((r) => vs.includes(r[k])), api),
      gte: (k: string, v: string) => (use([k]), preds.push((r) => typeof r[k] === "string" && (r[k] as string) >= v), api),
      select: (cols?: string) => {
        if (cols) {
          projection = cols.split(",").map((c) => c.trim());
          use(selectedColumns(cols));
        }
        return api;
      },
      maybeSingle: async () => {
        const out = run();
        return { data: out.data?.[0] ?? null, error: out.error };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return api;
  };
  return { select: (cols?: string) => (query(null).select as (c?: string) => unknown)(cols), update: (patch: Row) => query(patch) };
}

function makeSb() {
  const cards: CardRow[] = [ACTION_A, ACTION_B].map((id) => cardRow(id, "dispatching"));
  const events: Row[] = [ACTION_A, ACTION_B].map((action_id, i) => approval(action_id, i));
  const ledger: Row[] = [];
  const failing = new Set<string>();
  const jobs: JobRow[] = [];
  const artifacts: Record<string, unknown>[] = [];
  const uploads: { bucket: string; path: string; bytes: number }[] = [];
  const removed: string[] = [];
  const stored: Array<{ name: string; metadata: { size: number } }> = [];

  const jobsTable = () => {
    const preds: Array<(r: JobRow) => boolean> = [];
    const jobCols = migrationColumns("generative_video_jobs");
    const check = (cols: string[]) => {
      for (const c of cols) if (!jobCols.has(c)) schemaViolations.push(`generative_video_jobs.${c}`);
    };
    let patch: Partial<JobRow> | null = null;
    let order: { k: string; asc: boolean } | null = null;
    let lim = Infinity;
    const run = () => {
      let m = jobs.filter((r) => preds.every((pr) => pr(r)));
      if (patch) {
        if (failing.has("generative_video_jobs:write")) return { data: null, error: { message: "write failed" } };
        for (const r of m) Object.assign(r, patch);
      }
      if (order) {
        const { k, asc } = order;
        m = [...m].sort((a, b) => String((a as Row)[k] ?? "").localeCompare(String((b as Row)[k] ?? "")) * (asc ? 1 : -1));
      }
      return { data: m.slice(0, lim).map((r) => ({ ...r })), error: null };
    };
    const api: Record<string, unknown> = {
      select: (cols?: string) => (cols && check(selectedColumns(cols)), api),
      eq: (k: string, v: unknown) => (check([k]), preds.push((r) => (r as Row)[k] === v), api),
      in: (k: string, vs: unknown[]) => (check([k]), preds.push((r) => vs.includes((r as Row)[k])), api),
      like: (k: string, pat: string) => {
        check([k]);
        const re = new RegExp("^" + pat.split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
        preds.push((r) => re.test(String((r as Row)[k] ?? "")));
        return api;
      },
      order: (k: string, o?: { ascending?: boolean }) => (check([k]), (order = { k, asc: o?.ascending !== false }), api),
      limit: (n: number) => ((lim = n), api),
      maybeSingle: async () => {
        const out = run();
        return { data: out.data?.[0] ?? null, error: out.error };
      },
      upsert: async (row: JobRow, opts?: { ignoreDuplicates?: boolean }) => {
        check(Object.keys(row));
        if (failing.has("generative_video_jobs:write")) return { error: { message: "write failed" } };
        const now = new Date().toISOString();
        const i = jobs.findIndex((r) => r.run_id === row.run_id && r.meter_key === row.meter_key);
        if (i >= 0 && opts?.ignoreDuplicates) return { error: null };
        if (i >= 0) jobs[i] = { ...jobs[i], ...row, updated_at: now };
        else jobs.push({ created_at: now, updated_at: now, ...row });
        return { error: null };
      },
      update: (p: Partial<JobRow>) => (check(Object.keys(p)), (patch = p), api),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return api;
  };

  return {
    _jobs: jobs,
    _artifacts: artifacts,
    _uploads: uploads,
    _removed: removed,
    _stored: stored,
    _cards: cards,
    _events: events,
    _ledger: ledger,
    _failing: failing,
    from: (t: string) => {
      if (t === "generative_video_jobs") return jobsTable();
      if (t === "channel_actions") return memTable(t, cards as unknown as Row[], () => failing.has(t));
      if (t === "channel_action_events") return memTable(t, events, () => failing.has(t));
      if (t === "tenant_credit_ledger") return memTable(t, ledger, () => failing.has(t));
      if (t === "agent_runs") {
        const q = {
          select: () => q,
          eq: () => q,
          gte: () => q,
          maybeSingle: async () => ({ data: { tenant_id: TENANT }, error: null }),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res, rej),
        };
        return q;
      }
      if (t === "run_artifacts") {
        return {
          upsert: async (row: Record<string, unknown>) => {
            artifacts.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${t}`);
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, buf: Buffer) => {
          uploads.push({ bucket, path, bytes: buf.byteLength });
          return { error: null };
        },
        download: async (_path: string) => ({ data: new Blob([new Uint8Array([1, 2, 3, 4])]), error: null }),
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/get/${path}` }, error: null }),
        createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/put/${path}` }, error: null }),
        list: async (_dir: string, opts?: { search?: string }) => ({ data: stored.filter((o) => !opts?.search || o.name.includes(opts.search)), error: null }),
        remove: async (paths: string[]) => {
          removed.push(...paths);
          return { data: [], error: null };
        },
      }),
    },
  };
}

type Sb = ReturnType<typeof makeSb>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const step = { run: (_n: string, fn: () => unknown) => Promise.resolve(fn()) } as any;
const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

const intake = (over: Partial<GenerativeVideoIntake> = {}): GenerativeVideoIntake =>
  ({ prompt: "a founder explaining Zavi", intent: "talking_head", premium: false, script: "Hi, I'm Sam and this is Zavi.", ...over }) as GenerativeVideoIntake;

const PORTRAIT = { ok: true as const, url: "https://cdn.fal/p.png", vendor: "fal" as const, model: "seedream", cost_usd: 0.0675 };
const VOICE = { ok: true as const, url: "https://cdn.fal/v.mp3", vendor: "fal" as const, model: "eleven-v3", cost_usd: 0.02 };
const JOB = { vendor: "fal" as const, model: "bytedance/seedance-2.5/reference-to-video", id: "job-1", status_url: "https://q/s", response_url: "https://q/r" };

beforeEach(() => {
  vi.clearAllMocks();
  meterMock.meterPlatformGeneration.mockResolvedValue({ decision: "charged", idempotency_key: "k" });
  chargeMocks.canAffordMedia.mockResolvedValue(true);
  chargeMocks.checkAffordMedia.mockResolvedValue("ok");
  chargeMocks.flushCharges.mockResolvedValue(undefined);
  finishMocks.getBoolSetting.mockResolvedValue(true);
  finishMocks.runFinishPass.mockResolvedValue({ ok: true, duration_s: 10.8, bytes: 777 });
  routerMocks.estimateCost.mockReturnValue(1);
  routerMocks.generateMedia.mockImplementation(async (task: string) => (task === "image.photo" ? PORTRAIT : VOICE));
  routerMocks.submitMedia.mockResolvedValue({ ok: true, job: JOB });
  routerMocks.pollMediaOnce.mockResolvedValue({ state: "done", url: "https://cdn.fal/out.mp4", duration_s: 12 });
  routerMocks.costForJob.mockImplementation((_j: unknown, _r: unknown, done: { duration_s?: number }) => (done.duration_s ?? 0) * 0.5);
  routerMocks.downloadMedia.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
  routerMocks.cancelMedia.mockResolvedValue("requested");
  cardMocks.setChannelActionVideoMedia.mockResolvedValue({ ok: true, replayed: false });
});

const ACTION_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ACTION_B = "bbbbbbbb-0000-0000-0000-000000000002";
const CLAIM = "cccccccc-0000-0000-0000-000000000003";

function cardRow(id: string, exec_status: string, over: Partial<CardRow> = {}): CardRow {
  return {
    id,
    tenant_id: TENANT,
    exec_class: "generated_video.render.v1",
    exec_status,
    exec_claim_id: CLAIM,
    exec_claimed_at: new Date().toISOString(),
    exec_payload: { intake: intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" }) },
    executed_at: exec_status === "executed" ? new Date().toISOString() : null,
    ...over,
  };
}

function approval(action_id: string, order: number): Row {
  return { tenant_id: TENANT, action_id, event: "approved", at: new Date(Date.now() - 60_000 + order * 1_000).toISOString() };
}
const card = (action_id: string): ChannelActionDeliveryTarget => ({ kind: "channel_action", action_id, claim_id: CLAIM });
const UGC_SCRIPT = "Setup took four minutes and that was the whole job. Connect the calendar, pick the shifts, and the rota fills itself.";

const driveCard = (sb: Sb, action_id: string) =>
  runRoutedVideo(
    step,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sb as any,
    {
      tenant_id: TENANT,
      run_id: RUN,
      intake: intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" }),
      target: card(action_id),
      logger: { warn: vi.fn() },
      render_key: `ca-${action_id}-${CLAIM}`,
    },
    { pollDelayMs: 0, maxPolls: 3 },
  );

describe("AI UGC Videos card render", () => {
  it("puts the video on the card, then charges; nothing goes to chat or Slack", async () => {
    const sb = makeSb();
    const order: string[] = [];
    cardMocks.setChannelActionVideoMedia.mockImplementation(async () => {
      order.push("card");
      return { ok: true, replayed: false };
    });
    chargeMocks.flushCharges.mockImplementation(async () => {
      order.push("charge");
    });
    const r = await driveCard(sb, ACTION_A);
    expect(r).toMatchObject({ ok: true });
    expect(order).toEqual(["card", "charge"]);
    const [tenant, args] = cardMocks.setChannelActionVideoMedia.mock.calls[0];
    expect(tenant).toBe(TENANT);
    expect(args).toMatchObject({ actionId: ACTION_A, runId: RUN, claimId: CLAIM, ok: true });
    expect(args.media).toMatchObject({ kind: "video", ai_generated: true, bucket: "launch-video-artifacts" });
    expect(String(args.media.storage_path).startsWith(`${TENANT}/${RUN}/`)).toBe(true);
    expect(deliveryMocks.deliverArtifactToThread).not.toHaveBeenCalled();
    expect(deliveryMocks.uploadFileToThread).not.toHaveBeenCalled();
    expect(deliveryMocks.callSlackTool).not.toHaveBeenCalled();
  });

  it("render failure: the card is settled failed and NO charge is flushed", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "vendor_error", error: "boom" });
    const sb = makeSb();
    const r = await driveCard(sb, ACTION_A);
    expect(r).toMatchObject({ skipped: "video_failed" });
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(cardMocks.setChannelActionVideoMedia).toHaveBeenCalledTimes(1);
    const [, args] = cardMocks.setChannelActionVideoMedia.mock.calls[0];
    expect(args).toMatchObject({ actionId: ACTION_A, claimId: CLAIM, ok: false });
    expect(args.error).toMatch(/not charged/);
  });

  it("a short wallet at render time settles the card failed and charges nothing", async () => {
    chargeMocks.checkAffordMedia.mockResolvedValue("short");
    const sb = makeSb();
    const r = await driveCard(sb, ACTION_A);
    expect(r).toMatchObject({ skipped: "insufficient_credits" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(cardMocks.setChannelActionVideoMedia.mock.calls[0][1]).toMatchObject({ ok: false, code: "insufficient_credits" });
  });

  it("a vendor failure carries no credits code (no top-up link for a failure that is not the wallet)", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "vendor_error", error: "boom" });
    await driveCard(makeSb(), ACTION_A);
    expect(cardMocks.setChannelActionVideoMedia.mock.calls[0][1].code).toBeNull();
  });

  it("a presenter the model refuses tells the card's founder to press Try again, and charges nothing", async () => {
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "failed", reason: "refused", error: "fal result 422: content_policy_violation" });
    expect(await driveCard(makeSb(), ACTION_A)).toMatchObject({ skipped: "video_failed" });
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(cardMocks.setChannelActionVideoMedia.mock.calls[0][1]).toMatchObject({
      ok: false,
      error: "Sorry, the video model turned down the AI presenter it was given. Press Try again and Zavi will make a new presenter. You were not charged for it.",
    });
  });

  it("a charge that errors after delivery throws out of the charge step (retried), after the card has the video", async () => {
    chargeMocks.flushCharges.mockRejectedValue(new Error("media charge failed for 1 of 3 item(s); retry"));
    await expect(driveCard(makeSb(), ACTION_A)).rejects.toThrow(/media charge failed/);
    expect(cardMocks.setChannelActionVideoMedia.mock.calls[0][1]).toMatchObject({ ok: true });
  });

  it("a card that refuses the video (no longer this attempt's) is NOT charged", async () => {
    cardMocks.setChannelActionVideoMedia.mockResolvedValue({ ok: false, code: "not_dispatching", replayed: false });
    const sb = makeSb();
    const r = await driveCard(sb, ACTION_A);
    expect(r).toMatchObject({ skipped: "card_refused" });
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("a settle RPC error throws (the step retries) instead of reading as delivered", async () => {
    cardMocks.setChannelActionVideoMedia.mockRejectedValue(new Error("db down"));
    const sb = makeSb();
    await expect(driveCard(sb, ACTION_A)).rejects.toThrow(/db down/);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("two cards from ONE run never share a meter, job or charge key", async () => {
    const sb = makeSb();
    await driveCard(sb, ACTION_A);
    await driveCard(sb, ACTION_B);
    const meterRunIds = meterMock.meterPlatformGeneration.mock.calls.map((c) => (c[0] as { run_id: string }).run_id);
    expect(new Set(meterRunIds)).toEqual(new Set([`ca-${ACTION_A}-${CLAIM}`, `ca-${ACTION_B}-${CLAIM}`]));
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(2);
    expect(sb._jobs.map((j) => j.meter_key).sort()).toEqual([`ca-${ACTION_A}-${CLAIM}:gen-video:0`, `ca-${ACTION_B}-${CLAIM}:gen-video:0`]);
    const keys = chargeMocks.flushCharges.mock.calls.flatMap((c) => (c[0] as { key: string; run_id: string }[]).map((p) => p.key));
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k.startsWith(`${RUN}:`)).toBe(false);
    for (const c of chargeMocks.flushCharges.mock.calls) for (const p of c[0] as { run_id: string }[]) expect(p.run_id).toBe(RUN);
    expect(new Set(sb._uploads.map((u) => u.path)).size).toBe(2);
  });
});

describe("a card whose video reaches Zavi but cannot be put on the card", () => {
  it("a card that refuses the video leaves nothing in the workspace's Library", async () => {
    cardMocks.setChannelActionVideoMedia.mockResolvedValue({ ok: false, code: "not_dispatching", replayed: false });
    const sb = makeSb();
    expect(await driveCard(sb, ACTION_A)).toMatchObject({ skipped: "card_refused" });
    expect(sb._artifacts).toEqual([]);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("a settle RPC that keeps failing leaves no uncharged video in the Library on any retry", async () => {
    cardMocks.setChannelActionVideoMedia.mockRejectedValue(new Error("db down"));
    const sb = makeSb();
    for (let attempt = 0; attempt < 3; attempt++) await expect(driveCard(sb, ACTION_A)).rejects.toThrow(/db down/);
    expect(sb._artifacts).toEqual([]);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("a delivered card gets its Library row only after the card holds the video, and is charged", async () => {
    const sb = makeSb();
    const rowsWhenSettled: number[] = [];
    cardMocks.setChannelActionVideoMedia.mockImplementation(async () => {
      rowsWhenSettled.push(sb._artifacts.length);
      return { ok: true, replayed: false };
    });
    expect(await driveCard(sb, ACTION_A)).toMatchObject({ ok: true });
    expect(rowsWhenSettled).toEqual([0]);
    expect(sb._artifacts).toHaveLength(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("a settle that lands on a retry (replayed) still files the Library row and charges", async () => {
    const sb = makeSb();
    cardMocks.setChannelActionVideoMedia.mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ ok: true, replayed: true });
    await expect(driveCard(sb, ACTION_A)).rejects.toThrow(/timeout/);
    expect(sb._artifacts).toEqual([]);
    expect(await driveCard(sb, ACTION_A)).toMatchObject({ ok: true });
    expect(sb._artifacts).toHaveLength(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });
});

describe("a card video's name in the Library and on download", () => {
  const VALID_SHAPE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[a-z0-9._-]+$/;
  it("is the script's opening line, not an internal id, while the stored file keeps its safe path", async () => {
    const sb = makeSb();
    await driveCard(sb, ACTION_A);
    const name = `Setup took four minutes and that was the whole job ${ACTION_A.slice(0, 8)}.mp4`;
    expect(sb._artifacts[0].filename).toBe(name);
    const media = cardMocks.setChannelActionVideoMedia.mock.calls[0][1].media;
    expect(media.filename).toBe(name);
    for (const n of [sb._artifacts[0].filename, media.filename]) expect(String(n)).not.toMatch(/ai-ugc-video-|talking_head-|[0-9a-f]{8}-[0-9a-f]{8}/);
    expect(String(sb._artifacts[0].storage_path)).toMatch(VALID_SHAPE);
    expect(String(media.storage_path)).toBe(sb._artifacts[0].storage_path);
    for (const u of sb._uploads) expect(u.path).toMatch(VALID_SHAPE);
  });

  it("two cards with the same script in one run get two Library rows, not one overwritten", async () => {
    const sb = makeSb();
    await driveCard(sb, ACTION_A);
    await driveCard(sb, ACTION_B);
    const names = sb._artifacts.map((a) => a.filename);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

describe("videoDisplayName", () => {
  it("prefers the hook, then the script's first sentence, then the prompt", () => {
    expect(videoDisplayName({ hook: "Stop paying for empty shifts", script: "Other line. More.", prompt: "p" })).toBe("Stop paying for empty shifts.mp4");
    expect(videoDisplayName({ hook: "  ", script: "Setup took four minutes! Then it ran.", prompt: "p" })).toBe("Setup took four minutes!.mp4");
    expect(videoDisplayName({ prompt: "a founder explaining Zavi" })).toBe("a founder explaining Zavi.mp4");
  });
  it("strips characters a download name cannot carry and caps the length on a word", () => {
    const n = videoDisplayName({ hook: 'Why "50%" of rotas/fail: a\nreal <story> | told by the person who fixed it twice' });
    expect(n).not.toMatch(/["/\\:*?<>|\n]/);
    expect(n.length).toBeLessThanOrEqual(65);
    expect(n).toMatch(/^Why 50% of rotas fail a real story told by the person who.*\u2026\.mp4$/);
    expect(n).not.toMatch(/ \.mp4$/);
  });
  it("keeps question and exclamation marks in the title", () => {
    expect(videoDisplayName({ hook: "Got a birthday coming up? Let's talk cake" }, "7553adc2")).toBe("Got a birthday coming up? Let's talk cake 7553adc2.mp4");
    expect(videoDisplayName({ hook: "Is your rota broken?" })).toBe("Is your rota broken?.mp4");
  });
  it("ends a shortened title with an ellipsis and leaves a short one alone", () => {
    const hook = "The worst cake problem is finding out on the birthday that it's late.";
    expect(videoDisplayName({ hook }, "7553adc2")).toBe("The worst cake problem is finding out on the birthday that\u2026 7553adc2.mp4");
    expect(videoDisplayName({ hook: "Short and sweet." })).toBe("Short and sweet.mp4");
  });
  it("falls back to Video when nothing readable is left", () => {
    expect(videoDisplayName({ hook: "///", script: "", prompt: "   " })).toBe("Video.mp4");
    expect(videoDisplayName({ prompt: "" }, "aaaaaaaa")).toBe("Video aaaaaaaa.mp4");
  });
});

describe("the plan and lock check on a card render Inngest replays", () => {
  const event = {
    data: {
      run_id: RUN,
      render_key: `ca-${ACTION_A}-${CLAIM}`,
      intake: intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" }),
      delivery_target: { kind: "channel_action", action_id: ACTION_A, claim_id: CLAIM },
    },
  };
  class EndOfRequest extends Error {}
  const replay = async (sb: Sb) => {
    const { serviceClient } = await import("@/services/supabase");
    vi.mocked(serviceClient).mockImplementation(() => sb as never);
    const memo = new Map<string, unknown>();
    const order: string[] = [];
    const replayStep = {
      run: async (name: string, fn: () => unknown) => {
        if (memo.has(name)) return memo.get(name);
        order.push(name);
        memo.set(name, await fn());
        throw new EndOfRequest(name);
      },
    };
    const handler = (generateChannelVideoFn as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;
    try {
      for (let pass = 0; pass < 100; pass++) {
        try {
          return { result: await handler({ event, step: replayStep, logger: { warn: vi.fn() } }), order };
        } catch (e) {
          if (!(e instanceof EndOfRequest)) throw e;
        }
      }
      throw new Error("the render never finished");
    } finally {
      vi.mocked(serviceClient).mockImplementation(() => makeSb() as never);
    }
  };

  beforeEach(() => {
    routerMocks.isMediaRouterEnabled.mockResolvedValue(true);
    gateMocks.channelPlanLock.mockResolvedValue(null);
  });

  it("a lock read that fails on a later replay does not kill a render already sent to the vendor", async () => {
    gateMocks.isChannelLockedStrict.mockResolvedValueOnce(false).mockRejectedValue(new Error("config unavailable"));
    const sb = makeSb();
    const { result, order } = await replay(sb);
    expect(result).toMatchObject({ ok: true });
    expect(gateMocks.isChannelLockedStrict).toHaveBeenCalledTimes(1);
    expect(order.indexOf("channel-video-block")).toBeLessThan(order.indexOf("submit-routed-gen-video-0"));
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    const settles = cardMocks.setChannelActionVideoMedia.mock.calls.map((c) => c[1].ok);
    expect(settles).toEqual([true]);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("a staff lock that lands after the video was sent does not strand it uncharged", async () => {
    gateMocks.isChannelLockedStrict.mockResolvedValueOnce(false).mockResolvedValue(true);
    const sb = makeSb();
    const { result } = await replay(sb);
    expect(result).toMatchObject({ ok: true });
    expect(cardMocks.setChannelActionVideoMedia.mock.calls.map((c) => c[1].ok)).toEqual([true]);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("a lock read that fails on the first check still stops the render before anything is spent", async () => {
    gateMocks.isChannelLockedStrict.mockRejectedValue(new Error("config unavailable"));
    const sb = makeSb();
    const { result } = await replay(sb);
    expect(result).toMatchObject({ skipped: "not_entitled" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(meterMock.meterPlatformGeneration).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(cardMocks.setChannelActionVideoMedia.mock.calls[0][1]).toMatchObject({ ok: false, error: expect.stringMatching(/could not check/) });
  });
});

describe("channelVideoBlock (re-checked before any vendor call)", () => {
  it("blocks a locked channel, an unreadable lock (fail closed) and a plan without the channel", async () => {
    expect(await channelVideoBlock(TENANT, { lockedStrict: async () => true, planLock: async () => null })).toMatch(/switched off/);
    expect(
      await channelVideoBlock(TENANT, {
        lockedStrict: async () => {
          throw new Error("config unavailable");
        },
        planLock: async () => null,
      }),
    ).toMatch(/could not check/);
    const plan = await channelVideoBlock(TENANT, {
      lockedStrict: async () => false,
      planLock: async () => ({ slug: "generated_video", required_tier: "starter" }),
    });
    expect(plan).toMatch(/plan does not include AI UGC Videos/);
    for (const m of [plan]) expect(m).not.toMatch(/\u2014/);
  });
  it("lets an entitled, unlocked tenant through", async () => {
    expect(await channelVideoBlock(TENANT, { lockedStrict: async () => false, planLock: async () => null })).toBeNull();
  });
});

describe("settleChannelVideoFailure (onFailure)", () => {
  const data = {
    run_id: RUN,
    render_key: `ca-${ACTION_A}-${CLAIM}`,
    delivery_target: { kind: "channel_action", action_id: ACTION_A, claim_id: CLAIM },
  };
  it("settles the card failed with no charge", async () => {
    await settleChannelVideoFailure(data, new Error("boom"));
    expect(cardMocks.setChannelActionVideoMedia).toHaveBeenCalledWith(TENANT, expect.objectContaining({ actionId: ACTION_A, ok: false }));
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });
  it("a failed run read throws (retried) instead of skipping the charge repair or the settle", async () => {
    const { serviceClient } = await import("@/services/supabase");
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: { message: "db blip" } }) };
    vi.mocked(serviceClient).mockReturnValueOnce({ from: () => q } as never);
    await expect(settleChannelVideoFailure(data, new Error("boom"))).rejects.toThrow(/agent_runs read failed/);
    expect(cardMocks.setChannelActionVideoMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });
  it("RETHROWS a settle error so the failure handler retries (the card never sticks in Making)", async () => {
    cardMocks.setChannelActionVideoMedia.mockRejectedValue(new Error("db down"));
    await expect(settleChannelVideoFailure(data, new Error("boom"))).rejects.toThrow(/db down/);
  });
});

describe("five starter videos approved together", () => {
  it("render side by side for one business, one render per approval", () => {
    const o = (generateChannelVideoFn as unknown as { opts: { concurrency: unknown; idempotency: unknown } }).opts;
    expect(o.concurrency).toEqual({ key: "event.data.tenant_id", limit: 5 });
    expect(o.idempotency).toBe("event.data.render_key");
  });
});

describe("AI UGC Videos card: the finish pass and a takeover", () => {
  const WORDS: Array<[string, number, number]> = [["Setup", 0.1, 0.5], ["took", 0.55, 0.8], ["four", 0.85, 1.1], ["minutes", 1.15, 1.6], ["flat.", 1.65, 2.0]];
  const withWords = () => routerMocks.generateMedia.mockImplementation(async (task: string) => (task === "image.photo" ? PORTRAIT : { ...VOICE, words: WORDS }));

  it("the edited file is what lands on the card, and the raw copy is removed once it has", async () => {
    withWords();
    cardMocks.setChannelActionVideoMedia.mockResolvedValue({ ok: true, replayed: false });
    const sb = makeSb();
    const r = await driveCard(sb, ACTION_A);
    expect(r).toMatchObject({ ok: true });
    const media = cardMocks.setChannelActionVideoMedia.mock.calls[0][1].media;
    expect(String(media.storage_path)).toContain("/edited-ai-ugc-video-");
    expect(media).toMatchObject({ kind: "video", ai_generated: true });
    expect(sb._removed).toHaveLength(1);
    expect(sb._removed[0]).not.toContain("edited-");
    expect(await finishMocks.runFinishPass.mock.calls[0][0].stillOurs()).toBe(true);
  });

  it("a card that refuses the edited video keeps the raw copy (nothing was delivered, nothing is deleted)", async () => {
    withWords();
    cardMocks.setChannelActionVideoMedia.mockResolvedValue({ ok: false, code: "not_dispatching" });
    const sb = makeSb();
    const r = await driveCard(sb, ACTION_A);
    expect(r).toMatchObject({ skipped: "card_refused" });
    expect(sb._removed).toEqual([]);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("a card taken over during the finish pass leaves nothing in the workspace's files: no artifact row, no card, no charge", async () => {
    withWords();
    const sb = makeSb();
    finishMocks.runFinishPass.mockImplementation(async () => {
      sb._cards[0].exec_claim_id = "ffffffff-0000-0000-0000-00000000000f";
      return { ok: false, reason: "lease_lost" };
    });
    const r = await driveCard(sb, ACTION_A);
    expect(r).toMatchObject({ skipped: "card_refused" });
    expect(sb._artifacts).toEqual([]);
    expect(cardMocks.setChannelActionVideoMedia).not.toHaveBeenCalledWith(TENANT, expect.objectContaining({ ok: true }));
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("a card taken over while the video renders stops the wait: no staging, no edit, no charge", async () => {
    withWords();
    const sb = makeSb();
    let polls = 0;
    routerMocks.pollMediaOnce.mockImplementation(async () => {
      if (++polls === 1) sb._cards[0].exec_claim_id = "ffffffff-0000-0000-0000-00000000000f";
      return { state: "pending" };
    });
    const r = await runRoutedVideo(
      step,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sb as any,
      { tenant_id: TENANT, run_id: RUN, intake: intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" }), target: card(ACTION_A), logger: { warn: vi.fn() }, render_key: `ca-${ACTION_A}-${CLAIM}` },
      { pollDelayMs: 0, maxPolls: 40 },
    );
    expect(r).toMatchObject({ skipped: "lease_lost" });
    expect(polls).toBeLessThan(40);
    expect(sb._uploads).toEqual([]);
    expect(finishMocks.runFinishPass).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });
});

describe("a card still rendering is reserved at what it will really cost", () => {
  it("reserves the larger of the credits the card showed and today's estimate", async () => {
    const { inFlightCardVideoUsd } = await import("../generate-video");
    const { costToCredits } = await import("@/services/agents/credits");
    const sb = makeSb();
    const today = await inFlightCardVideoUsd(sb as any, TENANT, card(ACTION_B));
    expect(today).toBeGreaterThan(0);

    sb._cards[0].body = { cost_credits: costToCredits(today + 1) };
    expect(await inFlightCardVideoUsd(sb as any, TENANT, card(ACTION_B))).toBeCloseTo(today + 1, 2);

    sb._cards[0].body = { cost_credits: 1 };
    expect(await inFlightCardVideoUsd(sb as any, TENANT, card(ACTION_B))).toBeCloseTo(today, 6);
  });
});

describe("five cards rendering at once share ONE wallet", () => {
  const ids = Array.from({ length: 5 }, (_, i) => `dddddddd-0000-0000-0000-00000000000${i + 1}`);
  const lockstep = { run: async (_n: string, fn: () => unknown) => (await new Promise((r) => setTimeout(r, 0)), fn()) } as any;

  function wallet(sb: Sb, startUsd: number) {
    let balance = startUsd;
    const charged: number[] = [];
    chargeMocks.checkAffordMedia.mockImplementation(async (_t: string, cost: number) => (cost <= balance ? "ok" : "short"));
    chargeMocks.flushCharges.mockImplementation(async (pending: { key: string; cost_usd: number }[]) => {
      for (const p of pending) {
        sb._ledger.push({ tenant_id: TENANT, kind: "media", media_key: p.key });
        balance -= p.cost_usd;
        charged.push(p.cost_usd);
      }
    });
    cardMocks.setChannelActionVideoMedia.mockImplementation(async (_t: string, a: { actionId: string; claimId: string; ok: boolean }) => {
      const c = sb._cards.find((r) => r.id === a.actionId);
      if (!c || c.exec_status !== "dispatching" || c.exec_claim_id !== a.claimId) return { ok: false, code: "not_dispatching" };
      c.exec_status = a.ok ? "executed" : "failed";
      if (a.ok) c.executed_at = new Date().toISOString();
      return { ok: true, replayed: false };
    });
    return { charged, balance: () => balance };
  }

  function seedFive(sb: Sb) {
    sb._cards.splice(0, sb._cards.length, ...ids.map((id) => cardRow(id, "dispatching")));
    sb._events.splice(0, sb._events.length, ...ids.map((id, i) => approval(id, i)));
  }

  const render = (sb: Sb, action_id: string, st = lockstep) =>
    runRoutedVideo(
      st,
      sb as any,
      {
        tenant_id: TENANT,
        run_id: RUN,
        intake: intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" }),
        target: card(action_id),
        logger: { warn: vi.fn() },
        render_key: `ca-${action_id}-${CLAIM}`,
      },
      { pollDelayMs: 0, maxPolls: 3 },
    );

  beforeEach(() => {
    routerMocks.estimateCost.mockReturnValue(1);
    routerMocks.generateMedia.mockImplementation(async (task: string) => ({ ...(task === "image.photo" ? PORTRAIT : VOICE), cost_usd: 1 }));
    routerMocks.costForJob.mockReturnValue(1);
  });

  it("a wallet that covers two renders pays fal for two, never five, and nothing is charged past the balance", async () => {
    const sb = makeSb();
    seedFive(sb);
    const w = wallet(sb, 7);
    const out = await Promise.all(ids.map((id) => render(sb, id)));

    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(2);
    expect(routerMocks.generateMedia.mock.calls.filter((c) => c[0] === "image.photo")).toHaveLength(2);
    expect(out.filter((r) => "ok" in r)).toHaveLength(2);
    expect(out.filter((r) => (r as { skipped?: string }).skipped === "insufficient_credits")).toHaveLength(3);
    expect(w.charged.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(7);
    expect(w.balance()).toBeGreaterThanOrEqual(0);
    const refused = cardMocks.setChannelActionVideoMedia.mock.calls.filter((c) => c[1].ok === false);
    expect(refused.map((c) => c[1].actionId).sort()).toEqual(ids.slice(2).sort());
    for (const c of refused) expect(c[1].code).toBe("insufficient_credits");
  });

  it("the cards approved first are the ones that render", async () => {
    const sb = makeSb();
    seedFive(sb);
    wallet(sb, 7);
    await Promise.all([...ids].reverse().map((id) => render(sb, id)));
    const made = cardMocks.setChannelActionVideoMedia.mock.calls.filter((c) => c[1].ok === true).map((c) => c[1].actionId);
    expect(made.sort()).toEqual(ids.slice(0, 2).sort());
  });

  it("a video delivered but not yet charged still holds its share of the wallet", async () => {
    const sb = makeSb();
    sb._cards.splice(0, sb._cards.length, cardRow(ids[0], "executed"), cardRow(ids[1], "dispatching"));
    sb._events.splice(0, sb._events.length, approval(ids[0], 0), approval(ids[1], 1));
    wallet(sb, 4);
    expect(await render(sb, ids[1], step)).toMatchObject({ skipped: "insufficient_credits" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();

    vi.clearAllMocks();
    routerMocks.generateMedia.mockImplementation(async (task: string) => ({ ...(task === "image.photo" ? PORTRAIT : VOICE), cost_usd: 1 }));
    routerMocks.submitMedia.mockResolvedValue({ ok: true, job: JOB });
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "done", url: "https://cdn.fal/out.mp4", duration_s: 12 });
    routerMocks.downloadMedia.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    routerMocks.costForJob.mockReturnValue(1);
    meterMock.meterPlatformGeneration.mockResolvedValue({ decision: "charged", idempotency_key: "k" });
    sb._ledger.push({ tenant_id: TENANT, kind: "media", media_key: `ca-${ids[0]}-${CLAIM}:gen-video:0` });
    sb._cards[1].exec_status = "dispatching";
    wallet(sb, 4);
    expect(await render(sb, ids[1], step)).toMatchObject({ skipped: "insufficient_credits" });
    sb._ledger.push(
      { tenant_id: TENANT, kind: "media", media_key: `ca-${ids[0]}-${CLAIM}:gen-image:0` },
      { tenant_id: TENANT, kind: "media", media_key: `ca-${ids[0]}-${CLAIM}:gen-vo:0` },
    );
    sb._cards[1].exec_status = "dispatching";
    wallet(sb, 4);
    expect(await render(sb, ids[1], step)).toMatchObject({ ok: true });
  });

  it("a second card approved while the first is still rendering is priced with the first and renders", async () => {
    const sb = makeSb();
    const r = await driveCard(sb, ACTION_B);
    expect(r).toMatchObject({ ok: true });
    const one = routedVideoPlan(intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" })).estimateUsd;
    expect(one).toBeGreaterThan(0);
    expect(chargeMocks.checkAffordMedia).toHaveBeenCalledTimes(1);
    expect(chargeMocks.checkAffordMedia).toHaveBeenCalledWith(TENANT, one * 2);
    expect(cardMocks.setChannelActionVideoMedia.mock.calls[0][1]).toMatchObject({ actionId: ACTION_B, ok: true });
  });

  it("orders the wallet queue by the approval event's own time column", async () => {
    const sb = makeSb();
    const one = routedVideoPlan(intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" })).estimateUsd;
    expect(await inFlightCardVideoUsd(sb as any, TENANT, card(ACTION_A))).toBe(0);
    expect(await inFlightCardVideoUsd(sb as any, TENANT, card(ACTION_B))).toBe(one);
    sb._events.find((e) => e.action_id === ACTION_A)!.at = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    expect(await inFlightCardVideoUsd(sb as any, TENANT, card(ACTION_B))).toBe(0);
  });

  it("the fake database refuses a column the migrations never created", async () => {
    const sb = makeSb();
    const res = await (sb.from("channel_action_events") as any).select("action_id, created_at").eq("tenant_id", TENANT);
    expect(res.error).toMatchObject({ code: "42703" });
    expect(schemaViolations.splice(0)).toEqual(["channel_action_events.created_at"]);
    sb._events.push({ ...sb._events[0], created_at: new Date().toISOString() });
    expect(() => sb.from("channel_action_events")).toThrow(/channel_action_events\.created_at does not exist/);
  });

  it("an unreadable in-flight read refuses before any vendor call, without claiming a shortfall", async () => {
    const sb = makeSb();
    sb._failing.add("channel_action_events");
    chargeMocks.checkAffordMedia.mockResolvedValue("ok");
    const r = await driveCard(sb, ACTION_A);
    expect(r).toMatchObject({ skipped: "afford_check_unavailable" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(cardMocks.setChannelActionVideoMedia.mock.calls[0][1].error).not.toMatch(/credits/);
  });
});

describe("a render longer than the 10-minute claim lease", () => {
  const LEASE_MS = 10 * 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps its card through a 12-minute fal queue, so a redelivery cannot fail it mid-render", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-01T12:00:00Z"));
    const sb = makeSb();
    const row = sb._cards.find((c) => c.id === ACTION_A)!;
    row.exec_claimed_at = new Date().toISOString();
    let takenOver = false;
    let polls = 0;
    routerMocks.pollMediaOnce.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5_000);
      if (row.exec_status === "dispatching" && Date.now() - Date.parse(row.exec_claimed_at!) > LEASE_MS) {
        row.exec_status = "failed";
        takenOver = true;
      }
      return ++polls < 144 ? { state: "pending" } : { state: "done", url: "https://cdn.fal/out.mp4", duration_s: 20 };
    });
    cardMocks.setChannelActionVideoMedia.mockImplementation(async (_t: string, a: { ok: boolean; claimId: string }) => {
      if (row.exec_status !== "dispatching" || row.exec_claim_id !== a.claimId) return { ok: false, code: "not_dispatching" };
      row.exec_status = a.ok ? "executed" : "failed";
      return { ok: true, replayed: false };
    });
    const { CHANNEL_VIDEO_MAX_POLLS } = await import("../generate-video");
    const r = await runRoutedVideo(
      step,
      sb as any,
      {
        tenant_id: TENANT,
        run_id: RUN,
        intake: intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" }),
        target: card(ACTION_A),
        logger: { warn: vi.fn() },
        render_key: `ca-${ACTION_A}-${CLAIM}`,
      },
      { pollDelayMs: 0, maxPolls: CHANNEL_VIDEO_MAX_POLLS },
    );
    expect(polls).toBe(144);
    expect(takenOver).toBe(false);
    expect(r).toMatchObject({ ok: true });
    expect(row.exec_status).toBe("executed");
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("a render that starts after its card was taken over spends nothing and leaves the card alone", async () => {
    const sb = makeSb();
    sb._cards.find((c) => c.id === ACTION_A)!.exec_status = "failed";
    const r = await driveCard(sb, ACTION_A);
    expect(r).toMatchObject({ skipped: "lease_lost" });
    expect(chargeMocks.checkAffordMedia).not.toHaveBeenCalled();
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(cardMocks.setChannelActionVideoMedia).not.toHaveBeenCalled();
  });

  it("a card re-approved under a new claim is not this render's", async () => {
    const sb = makeSb();
    sb._cards.find((c) => c.id === ACTION_A)!.exec_claim_id = "eeeeeeee-0000-0000-0000-000000000009";
    expect(await driveCard(sb, ACTION_A)).toMatchObject({ skipped: "lease_lost" });
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
  });

  it("a takeover between the voiceover and the video submit never pays for the video", async () => {
    const sb = makeSb();
    const row = sb._cards.find((c) => c.id === ACTION_A)!;
    routerMocks.generateMedia.mockImplementation(async (task: string) => {
      if (task === "audio.voiceover") row.exec_status = "failed";
      return task === "image.photo" ? PORTRAIT : VOICE;
    });
    expect(await driveCard(sb, ACTION_A)).toMatchObject({ skipped: "lease_lost" });
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("a resumed run whose card this claim already delivered still flushes its charge", async () => {
    const sb = makeSb();
    const row = sb._cards.find((c) => c.id === ACTION_A)!;
    row.exec_status = "executed";
    sb._jobs.push({ tenant_id: TENANT, run_id: RUN, meter_key: `ca-${ACTION_A}-${CLAIM}:gen-video:0`, model: JOB.model, job_id: JSON.stringify(JOB), status: "completed" });
    cardMocks.setChannelActionVideoMedia.mockResolvedValue({ ok: true, replayed: true });
    expect(await driveCard(sb, ACTION_A)).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });
});

describe("Try again after a timeout reuses the fal job it already paid for", () => {
  const CLAIM2 = "dddddddd-0000-0000-0000-00000000000f";
  const LEG_IMG = { vendor: "fal" as const, model: "bytedance/seedream/v5/pro/text-to-image", id: "leg-img", status_url: "https://q/s", response_url: "https://q/r" };
  const LEG_VO = { vendor: "fal" as const, model: "fal-ai/elevenlabs/tts/eleven-v3", id: "leg-vo", status_url: "https://q/s", response_url: "https://q/r" };

  const drive = (sb: Sb, claim: string, maxPolls = 3, st = step) =>
    runRoutedVideo(
      st,
      sb as any,
      {
        tenant_id: TENANT,
        run_id: RUN,
        intake: intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" }),
        target: { kind: "channel_action", action_id: ACTION_A, claim_id: claim },
        logger: { warn: vi.fn() },
        render_key: `ca-${ACTION_A}-${claim}`,
      },
      { pollDelayMs: 0, maxPolls },
    );

  const reclaim = (sb: Sb, claim: string) => {
    const c = sb._cards.find((r) => r.id === ACTION_A)!;
    c.exec_claim_id = claim;
    c.exec_status = "dispatching";
    c.exec_claimed_at = new Date().toISOString();
  };
  const priorRow = (over: Partial<JobRow> = {}): JobRow => ({
    tenant_id: TENANT,
    run_id: RUN,
    meter_key: `ca-${ACTION_A}-${CLAIM}:gen-video:0`,
    model: JOB.model,
    job_id: JSON.stringify({ ...JOB, intent: intentOf() }),
    status: "pending",
    updated_at: new Date().toISOString(),
    ...over,
  });
  const settleOnCard = (sb: Sb) =>
    cardMocks.setChannelActionVideoMedia.mockImplementation(async (_t: string, a: { ok: boolean; claimId: string }) => {
      const c = sb._cards.find((r) => r.id === ACTION_A)!;
      if (c.exec_status !== "dispatching" || c.exec_claim_id !== a.claimId) return { ok: false, code: "not_dispatching" };
      c.exec_status = a.ok ? "executed" : "failed";
      return { ok: true, replayed: false };
    });

  beforeEach(() => {
    routerMocks.generateMedia.mockImplementation(async (task: string, _req: unknown, opts?: { resume?: unknown; onSubmitted?: (j: unknown) => Promise<void> }) => {
      if (!opts?.resume) await opts?.onSubmitted?.(task === "image.photo" ? LEG_IMG : LEG_VO);
      return task === "image.photo" ? PORTRAIT : VOICE;
    });
    routerMocks.costForJob.mockImplementation((j: { id: string }, _r: unknown, done: { duration_s?: number }) =>
      j.id === "leg-img" ? 0.0675 : j.id === "leg-vo" ? 0.02 : (done.duration_s ?? 0) * 0.5,
    );
  });

  it("timeout: fal is told to cancel, the row keeps its JobRef, the card fails uncharged; Try again adopts it and charges once", async () => {
    const sb = makeSb();
    settleOnCard(sb);
    routerMocks.pollMediaOnce.mockResolvedValue({ state: "pending" });

    expect(await drive(sb, CLAIM)).toMatchObject({ skipped: "video_failed" });
    expect(routerMocks.cancelMedia).toHaveBeenCalledTimes(1);
    expect(routerMocks.cancelMedia.mock.calls[0][0]).toMatchObject({ id: JOB.id });
    const first = sb._jobs.find((j) => j.meter_key === `ca-${ACTION_A}-${CLAIM}:gen-video:0`)!;
    expect(first.status).toBe("pending");
    expect(first.error).toMatch(/timeout/);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
    expect(sb._cards.find((r) => r.id === ACTION_A)!.exec_status).toBe("failed");

    routerMocks.pollMediaOnce.mockResolvedValue({ state: "done", url: "https://cdn.fal/out.mp4", duration_s: 12 });
    reclaim(sb, CLAIM2);
    expect(await drive(sb, CLAIM2)).toMatchObject({ ok: true });

    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(routerMocks.generateMedia.mock.calls.filter((c) => c[0] === "image.photo")).toHaveLength(1);
    expect(routerMocks.generateMedia.mock.calls.filter((c) => c[0] === "audio.voiceover")).toHaveLength(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    const charged = chargeMocks.flushCharges.mock.calls[0][0] as { key: string; cost_usd: number }[];
    const base = `ca-${ACTION_A}-${CLAIM2}`;
    expect(charged.map((c) => c.key).sort()).toEqual([`${base}:gen-image:0`, `${base}:gen-video:0`, `${base}:gen-vo:0`]);
    expect(charged.find((c) => c.key.endsWith("gen-image:0"))!.cost_usd).toBeCloseTo(0.0675);
    expect(charged.find((c) => c.key.endsWith("gen-vo:0"))!.cost_usd).toBeCloseTo(0.02);
    expect(charged.some((c) => c.key.includes(CLAIM))).toBe(false);
  });

  it("an adopted job still running is polled to the end, not resubmitted", async () => {
    const sb = makeSb();
    sb._jobs.push(priorRow());
    reclaim(sb, CLAIM2);
    routerMocks.pollMediaOnce.mockResolvedValueOnce({ state: "pending" }).mockResolvedValue({ state: "done", url: "https://cdn.fal/out.mp4", duration_s: 12 });
    expect(await drive(sb, CLAIM2)).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
    expect(meterMock.meterPlatformGeneration).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    const keys = (chargeMocks.flushCharges.mock.calls[0][0] as { key: string }[]).map((c) => c.key);
    expect(keys).toEqual([`ca-${ACTION_A}-${CLAIM2}:gen-video:0`]);
  });

  it("a prior job fal ended without a video (refused, cancelled) is not adopted: fresh presenter, fresh video", async () => {
    const sb = makeSb();
    sb._jobs.push(priorRow({ job_id: JSON.stringify({ ...JOB, id: "old", intent: intentOf() }) }));
    reclaim(sb, CLAIM2);
    routerMocks.pollMediaOnce.mockImplementation(async (j: { id: string }) =>
      j.id === "old" ? { state: "failed", reason: "vendor_error", error: "cancelled" } : { state: "done", url: "https://cdn.fal/out.mp4", duration_s: 12 },
    );
    expect(await drive(sb, CLAIM2)).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(routerMocks.generateMedia.mock.calls.filter((c) => c[0] === "image.photo")).toHaveLength(1);
    expect(sb._jobs.find((j) => j.meter_key === `ca-${ACTION_A}-${CLAIM}:gen-video:0`)!.status).toBe("failed");
  });

  it("a different script on the same card is a different video: not adopted", async () => {
    const sb = makeSb();
    sb._jobs.push(priorRow({ job_id: JSON.stringify({ ...JOB, intent: "someother" }) }));
    reclaim(sb, CLAIM2);
    expect(await drive(sb, CLAIM2)).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
  });

  it("a completed output older than its fal lifetime is not adopted (the URL would be dead)", async () => {
    const sb = makeSb();
    sb._jobs.push(priorRow({ status: "completed", updated_at: new Date(Date.now() - 50 * 60_000).toISOString() }));
    reclaim(sb, CLAIM2);
    expect(await drive(sb, CLAIM2)).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
  });

  it("two attempts racing for one card pay fal for ONE video: the stale one never submits", async () => {
    const sb = makeSb();
    reclaim(sb, CLAIM2);
    const lockstep = { run: async (_n: string, fn: () => unknown) => (await new Promise((r) => setTimeout(r, 0)), fn()) } as any;
    const [stale, live] = await Promise.all([drive(sb, CLAIM, 3, lockstep), drive(sb, CLAIM2, 3, lockstep)]);
    expect(stale).toMatchObject({ skipped: "lease_lost" });
    expect(live).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("the earlier attempt still polling the shared job is refused by the card and charges nothing", async () => {
    const sb = makeSb();
    settleOnCard(sb);
    sb._jobs.push(priorRow());
    reclaim(sb, CLAIM2);
    expect(await drive(sb, CLAIM2)).toMatchObject({ ok: true });
    expect(await drive(sb, CLAIM)).toMatchObject({ skipped: "lease_lost" });
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("a JobRef that cannot be recorded never fails the card: the job is polled and delivered, charged once", async () => {
    const sb = makeSb();
    routerMocks.generateMedia.mockImplementation(async (task: string) => (task === "image.photo" ? PORTRAIT : VOICE));
    const real = sb.from.bind(sb);
    let videoWrites = 0;
    (sb as any).from = (t: string) => {
      const tbl = real(t) as any;
      if (t !== "generative_video_jobs") return tbl;
      const up = tbl.upsert;
      tbl.upsert = async (row: JobRow) => (row.meter_key.endsWith(":gen-video:0") && videoWrites < 2 ? (videoWrites++, { error: { message: "db down" } }) : up(row));
      return tbl;
    };
    expect(await drive(sb as Sb, CLAIM)).toMatchObject({ ok: true });
    expect(videoWrites).toBe(2);
    expect(routerMocks.cancelMedia).not.toHaveBeenCalled();
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("an unrecorded job is written by its own step BEFORE polling, so a lost lease or a timeout still leaves it adoptable", async () => {
    const sb = makeSb();
    routerMocks.generateMedia.mockImplementation(async (task: string) => (task === "image.photo" ? PORTRAIT : VOICE));
    const real = sb.from.bind(sb);
    let fails = 2;
    const pollsSeenRow: boolean[] = [];
    routerMocks.pollMediaOnce.mockImplementation(async () => {
      pollsSeenRow.push(sb._jobs.some((j) => j.meter_key === `ca-${ACTION_A}-${CLAIM}:gen-video:0`));
      return { state: "pending" };
    });
    (sb as any).from = (t: string) => {
      const tbl = real(t) as any;
      if (t !== "generative_video_jobs") return tbl;
      const up = tbl.upsert;
      tbl.upsert = async (row: JobRow) => (row.meter_key.endsWith(":gen-video:0") && fails > 0 ? (fails--, { error: { message: "db down" } }) : up(row));
      return tbl;
    };
    expect(await drive(sb as Sb, CLAIM)).toMatchObject({ skipped: "video_failed" });
    expect(pollsSeenRow.every(Boolean)).toBe(true);
    const row = sb._jobs.find((j) => j.meter_key === `ca-${ACTION_A}-${CLAIM}:gen-video:0`)!;
    expect(row).toMatchObject({ status: "pending" });
    expect(JSON.parse(row.job_id!)).toMatchObject({ id: JOB.id, intent: intentOf() });
  });

  it("a record step that still cannot write throws (Inngest retries it) instead of polling an invisible job", async () => {
    const sb = makeSb();
    routerMocks.generateMedia.mockImplementation(async (task: string) => (task === "image.photo" ? PORTRAIT : VOICE));
    const real = sb.from.bind(sb);
    (sb as any).from = (t: string) => {
      const tbl = real(t) as any;
      if (t !== "generative_video_jobs") return tbl;
      const up = tbl.upsert;
      tbl.upsert = async (row: JobRow) => (row.meter_key.endsWith(":gen-video:0") ? { error: { message: "db down" } } : up(row));
      return tbl;
    };
    await expect(drive(sb as Sb, CLAIM)).rejects.toThrow(/still not recorded/);
    expect(routerMocks.pollMediaOnce).not.toHaveBeenCalled();
    expect(cardMocks.setChannelActionVideoMedia).not.toHaveBeenCalled();
  });

  it("a retried portrait step resumes the fal job it already submitted instead of buying another", async () => {
    const sb = makeSb();
    sb._jobs.push({ tenant_id: TENANT, run_id: RUN, meter_key: `ca-${ACTION_A}-${CLAIM}:gen-image:0`, model: LEG_IMG.model, job_id: JSON.stringify(LEG_IMG), status: "pending" });
    expect(await drive(sb, CLAIM)).toMatchObject({ ok: true });
    const portraitCall = routerMocks.generateMedia.mock.calls.find((c) => c[0] === "image.photo")!;
    expect(portraitCall[2]).toMatchObject({ resume: LEG_IMG });
    expect(sb._jobs.find((j) => j.meter_key === `ca-${ACTION_A}-${CLAIM}:gen-image:0`)!.status).toBe("completed");
  });

  it("a timeout whose cancel fal answers ALREADY_COMPLETED delivers the finished video instead of failing it", async () => {
    const sb = makeSb();
    let polls = 0;
    routerMocks.pollMediaOnce.mockImplementation(async () => (++polls <= 3 ? { state: "pending" } : { state: "done", url: "https://cdn.fal/out.mp4", duration_s: 12 }));
    routerMocks.cancelMedia.mockResolvedValue("too_late");
    expect(await drive(sb, CLAIM)).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect(cardMocks.setChannelActionVideoMedia.mock.calls[0][1]).toMatchObject({ ok: true });
  });

  it("a card taken over mid-render stops polling, settles nothing and charges nothing (the new attempt adopts the job)", async () => {
    const sb = makeSb();
    const row = sb._cards.find((c) => c.id === ACTION_A)!;
    routerMocks.pollMediaOnce.mockImplementation(async () => {
      row.exec_claim_id = CLAIM2;
      return { state: "pending" };
    });
    expect(await drive(sb, CLAIM, 30)).toMatchObject({ skipped: "lease_lost" });
    expect(routerMocks.pollMediaOnce.mock.calls.length).toBeLessThanOrEqual(LEASE_RENEW_EVERY_POLLS);
    expect(cardMocks.setChannelActionVideoMedia).not.toHaveBeenCalled();
    expect(routerMocks.cancelMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("a timeout replayed after Try again took the card never cancels the job the new attempt adopted", async () => {
    const sb = makeSb();
    const row = sb._cards.find((c) => c.id === ACTION_A)!;
    let polls = 0;
    routerMocks.pollMediaOnce.mockImplementation(async () => {
      if (++polls === 3) row.exec_claim_id = CLAIM2;
      return { state: "pending" };
    });
    expect(await drive(sb, CLAIM)).toMatchObject({ skipped: "lease_lost" });
    expect(routerMocks.cancelMedia).not.toHaveBeenCalled();
    expect(cardMocks.setChannelActionVideoMedia).not.toHaveBeenCalled();
  });

  it("a job from before intents were stored, whose timeout was written 'failed', is still adopted", async () => {
    const sb = makeSb();
    sb._jobs.push(priorRow({ job_id: JSON.stringify(JOB), status: "failed", error: `${JOB.model} poll timeout` }));
    reclaim(sb, CLAIM2);
    expect(await drive(sb, CLAIM2)).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("a prior job that genuinely failed (not a timeout) is never re-checked or adopted", async () => {
    const sb = makeSb();
    sb._jobs.push(priorRow({ job_id: JSON.stringify(JOB), status: "failed", error: "content_policy_violation" }));
    reclaim(sb, CLAIM2);
    expect(await drive(sb, CLAIM2)).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
  });

  it("an unrecorded JobRef is kept and polled: delivered once, never bought twice", async () => {
    const sb = makeSb();
    const real = sb.from.bind(sb);
    let fails = 2;
    (sb as any).from = (t: string) => {
      const tbl = real(t) as any;
      if (t !== "generative_video_jobs") return tbl;
      const up = tbl.upsert;
      tbl.upsert = async (row: JobRow) => (row.meter_key.endsWith(":gen-video:0") && fails > 0 ? (fails--, { error: { message: "db down" } }) : up(row));
      return tbl;
    };
    expect(await drive(sb as Sb, CLAIM)).toMatchObject({ ok: true });
    expect(routerMocks.submitMedia).toHaveBeenCalledTimes(1);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
  });

  it("an unreadable prior-attempt read stops the render (retried) instead of buying a second job", async () => {
    const sb = makeSb();
    reclaim(sb, CLAIM2);
    const real = sb.from.bind(sb);
    (sb as any).from = (t: string) => {
      const tbl = real(t) as any;
      if (t === "generative_video_jobs") tbl.like = () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "read failed" } }) }) });
      return tbl;
    };
    await expect(drive(sb as Sb, CLAIM2)).rejects.toThrow(/prior attempts read failed/);
    expect(routerMocks.submitMedia).not.toHaveBeenCalled();
    expect(routerMocks.generateMedia).not.toHaveBeenCalled();
  });
});

function intentOf(): string {
  return videoIntentKey(intake({ script: UGC_SCRIPT, aspect_ratio: "9:16" }));
}

describe("charges owed by a delivered card are durable and repaired", () => {
  const base = `ca-${ACTION_A}-${CLAIM}`;

  it("what the video owes is written before the card shows it, and the flush charges exactly that, once", async () => {
    const sb = makeSb();
    const order: string[] = [];
    let owed: string[] = [];
    cardMocks.setChannelActionVideoMedia.mockImplementation(async () => {
      const row = sb._jobs.find((j) => j.meter_key === `${base}:gen-video:0`);
      order.push(row?.pending_charges ? "recorded-then-card" : "card-before-record");
      owed = ((row?.pending_charges ?? []) as { key: string }[]).map((c) => c.key).sort();
      return { ok: true, replayed: false };
    });
    expect(await driveCard(sb, ACTION_A)).toMatchObject({ ok: true });
    expect(order).toEqual(["recorded-then-card"]);
    expect(owed).toEqual([`${base}:gen-image:0`, `${base}:gen-video:0`, `${base}:gen-vo:0`]);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    expect((chargeMocks.flushCharges.mock.calls[0][0] as { key: string }[]).map((c) => c.key).sort()).toEqual(owed);
    expect(sb._jobs.find((j) => j.meter_key === `${base}:gen-video:0`)!.pending_charges).toBeNull();
  });

  it("a run that died after delivery (charge retries exhausted) is charged by the failure handler, not settled failed", async () => {
    const sb = makeSb();
    chargeMocks.flushCharges.mockRejectedValueOnce(new Error("media charge failed for 3 of 3 item(s); retry"));
    await expect(driveCard(sb, ACTION_A)).rejects.toThrow(/media charge failed/);
    sb._cards.find((c) => c.id === ACTION_A)!.exec_status = "executed";
    chargeMocks.flushCharges.mockClear();
    chargeMocks.flushCharges.mockResolvedValue(undefined);
    expect(await repairDeliveredCharges(TENANT, RUN, card(ACTION_A), base, sb as any)).toBe(true);
    expect(chargeMocks.flushCharges).toHaveBeenCalledTimes(1);
    const keys = (chargeMocks.flushCharges.mock.calls[0][0] as { key: string; tenant_id: string; run_id: string }[]);
    expect(keys.map((k) => k.key).sort()).toEqual([`${base}:gen-image:0`, `${base}:gen-video:0`, `${base}:gen-vo:0`]);
    for (const k of keys) expect(k).toMatchObject({ tenant_id: TENANT, run_id: RUN });
  });

  it("an undelivered card (or one another claim delivered) is never charged by the repair", async () => {
    const sb = makeSb();
    sb._jobs.push({ tenant_id: TENANT, run_id: RUN, meter_key: `${base}:gen-video:0`, model: JOB.model, job_id: JSON.stringify(JOB), status: "completed", pending_charges: [{ tenant_id: TENANT, run_id: RUN, key: `${base}:gen-video:0`, cost_usd: 1, task: "video.talking_head", model: JOB.model }] });
    expect(await repairDeliveredCharges(TENANT, RUN, card(ACTION_A), base, sb as any)).toBe(false);
    const c = sb._cards.find((r) => r.id === ACTION_A)!;
    c.exec_status = "executed";
    c.exec_claim_id = "ffffffff-0000-0000-0000-000000000000";
    expect(await repairDeliveredCharges(TENANT, RUN, card(ACTION_A), base, sb as any)).toBe(false);
    expect(chargeMocks.flushCharges).not.toHaveBeenCalled();
  });

  it("the repair charges only this render's own keys, under the verified tenant", async () => {
    const sb = makeSb();
    sb._cards.find((r) => r.id === ACTION_A)!.exec_status = "executed";
    sb._jobs.push({
      tenant_id: TENANT, run_id: RUN, meter_key: `${base}:gen-video:0`, model: JOB.model, job_id: JSON.stringify(JOB), status: "completed",
      pending_charges: [
        { tenant_id: TENANT, run_id: RUN, key: `${base}:gen-video:0`, cost_usd: 1, task: "video.talking_head", model: JOB.model },
        { tenant_id: TENANT, run_id: RUN, key: `ca-other-card:gen-video:0`, cost_usd: 9, task: "video.talking_head", model: JOB.model },
        { tenant_id: "99999999-9999-9999-9999-999999999999", run_id: RUN, key: `${base}:gen-vo:0`, cost_usd: 9, task: "audio.voiceover", model: "x" },
      ],
    });
    await repairDeliveredCharges(TENANT, RUN, card(ACTION_A), base, sb as any);
    expect((chargeMocks.flushCharges.mock.calls[0][0] as { key: string }[]).map((c) => c.key)).toEqual([`${base}:gen-video:0`]);
  });
});
