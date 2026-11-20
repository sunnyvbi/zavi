import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const USER = "22222222-2222-4222-8222-222222222222";
const RUN = "44444444-4444-4444-8444-444444444444";
const VIDEO = "55555555-5555-4555-8555-555555555555";
const FOREIGN_VIDEO = "66666666-6666-4666-8666-666666666666";
const CARD_VIDEO = "77777777-7777-4777-8777-777777777777";
const HEX_VIDEO = "88888888-8888-4888-8888-888888888888";
const HOOK = "Stop scrolling: this is why our pastries sell out by 10am e\u2026";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: TENANT, user_id: USER, access_token: "tok" })),
}));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn(() => { throw new Error("no real database in tests"); }) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: vi.fn(() => { throw new Error("no real database in tests"); }),
  tenantRpc: vi.fn(() => { throw new Error("no real database in tests"); }),
  tenantStorage: vi.fn((t: string) => ({ storageFor: t })),
}));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: vi.fn(() => { throw new Error("not injected"); }) }));
vi.mock("@/routes/approvals/decision-channel", () => ({ refuseIfSocialPostPlanLocked: vi.fn(async () => null) }));
vi.mock("@/services/connectors/social-publish-account", () => ({
  resolveSocialPublishAccount: vi.fn(() => { throw new Error("vendor call in a test"); }),
}));
vi.mock("@/services/connectors/social-publish-gate", () => ({ localOverrideAllows: vi.fn(() => false) }));
vi.mock("@/agents/social/social-publish-flag", () => ({ isSocialPublishEnabled: vi.fn(async () => true) }));

import { videoStudioPostHandlers } from "../post";
import { defaultPostDeps, readPostStates, type PostDeps } from "@/services/video-studio/post";
import { requireAuth } from "@/services/auth/middleware";
import { tenantStorage } from "@/services/tenant-client";
import { localOverrideAllows } from "@/services/connectors/social-publish-gate";
import { isSocialPublishEnabled } from "@/agents/social/social-publish-flag";
import { xWeightedLength } from "@zavi/shared";

type Row = Record<string, unknown>;

function world() {
  const tables: Record<string, Row[]> = {
    run_artifacts: [
      { id: VIDEO, tenant_id: TENANT, run_id: RUN, storage_path: `${TENANT}/${RUN}/ugc-ad.mp4`, bucket: "launch-video-artifacts", filename: "UGC ad.mp4", mime: "video/mp4" },
      { id: CARD_VIDEO, tenant_id: TENANT, run_id: RUN, storage_path: `${TENANT}/${RUN}/edited-ai-ugc-video-1a2b3c4d-9f8e7d6c.mp4`, bucket: "launch-video-artifacts", filename: `${HOOK} 1a2b3c4d.mp4`, mime: "video/mp4" },
      { id: HEX_VIDEO, tenant_id: TENANT, run_id: RUN, storage_path: `${TENANT}/${RUN}/talking_head-44444444.mp4`, bucket: "launch-video-artifacts", filename: "Call us on 55512345.mp4", mime: "video/mp4" },
      { id: FOREIGN_VIDEO, tenant_id: OTHER, run_id: RUN, storage_path: `${OTHER}/${RUN}/theirs.mp4`, bucket: "launch-video-artifacts", filename: "Theirs.mp4", mime: "video/mp4" },
    ],
    decisions: [],
    social_posts: [],
  };
  let clock = 0;
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const field = (row: Row, col: string) => {
    const m = /^(\w+)->>(\w+)$/.exec(col);
    return m ? (row[m[1]] as Row | undefined)?.[m[2]] : row[col];
  };
  const db = (tenant: string) => ({
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [(r) => r.tenant_id === tenant];
      const q = {
        select: () => q,
        eq(col: string, v: unknown) {
          filters.push((r) => field(r, col) === v);
          return q;
        },
        in(col: string, vs: unknown[]) {
          filters.push((r) => vs.includes(field(r, col)));
          return q;
        },
        async maybeSingle() {
          await tick();
          return { data: tables[table].find((r) => filters.every((f) => f(r))) ?? null, error: null };
        },
        then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
          return tick()
            .then(() => ({ data: tables[table].filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })), error: null }))
            .then(ok, bad);
        },
      };
      return q;
    },
  });
  const uploads: string[] = [];
  const downloads: string[] = [];
  const storage = () => ({
    from: (bucket: string) => ({
      async download(path: string) {
        downloads.push(`${bucket}/${path}`);
        await tick();
        return { data: new Blob([new Uint8Array([1, 2, 3])]), error: null };
      },
      async upload(path: string) {
        uploads.push(`${bucket}/${path}`);
        await tick();
        return { error: null };
      },
    }),
  });
  const emits: Array<{ tenant: string; body: Row }> = [];
  const suppressed = new Map<string, string>();
  const emit = vi.fn(async (tenant: string, body: Row) => {
    await tick();
    const hit = suppressed.get(`${tenant}|${JSON.stringify(body)}`);
    if (hit) return hit;
    const id = `00000000-0000-4000-8000-${String(++clock).padStart(12, "0")}`;
    emits.push({ tenant, body });
    tables.decisions.push({ id, tenant_id: tenant, decision_class: "social.publish.v2", status: "proposed", emitted_at: `2026-10-27T00:00:${String(clock).padStart(2, "0")}Z`, body });
    return id;
  });
  const approvals: string[] = [];
  const decide = vi.fn(async (a: { decision_id: string; tenant_id: string; action: "approve" | "reject"; payload_edit?: { text?: string } }) => {
    await tick();
    const d = tables.decisions.find((r) => r.id === a.decision_id && r.tenant_id === a.tenant_id);
    if (!d) return { ok: false, code: "not_found", changed: false, status: null, decision_id: a.decision_id };
    const want = a.action === "approve" ? "approved" : "rejected";
    if (d.status !== "proposed") return { ok: d.status === want, code: "ok", changed: false, status: d.status, decision_id: a.decision_id };
    if (a.action === "approve" && a.payload_edit?.text !== undefined) {
      const body = d.body as Row;
      d.body = { ...body, payload: { ...(body.payload as Row), text: a.payload_edit.text } };
    }
    d.status = want;
    if (want === "rejected") suppressed.set(`${a.tenant_id}|${JSON.stringify(d.body)}`, a.decision_id);
    if (want === "approved") approvals.push(a.decision_id);
    return { ok: true, code: "ok", changed: true, status: want, decision_id: a.decision_id };
  });
  const connectedSet = new Set(["instagram_video", "linkedin_video", "x_video", "tiktok_video", "youtube_video"]);
  const gate = { open: true };
  const redispatched: string[] = [];
  const redispatch = vi.fn(async (_t: string, id: string) => {
    await tick();
    redispatched.push(id);
  });
  const deps: PostDeps = {
    redispatch,
    db: db as unknown as PostDeps["db"],
    storage: storage as unknown as PostDeps["storage"],
    emit,
    decide: decide as unknown as PostDeps["decide"],
    gateOpen: vi.fn(async () => gate.open),
    planLocked: vi.fn(async () => null),
    connected: vi.fn(async (_t: string, c: string) => connectedSet.has(c)),
  };
  const approvedChannels = () =>
    tables.decisions.filter((d) => d.status === "approved").map((d) => (d.body as Row).channel as string).sort();
  return { tables, deps, emits, approvals, uploads, downloads, connectedSet, gate, approvedChannels, decide, redispatch, redispatched };
}

function res() {
  const r = { statusCode: 200, body: undefined as unknown } as { statusCode: number; body: unknown } & Partial<Response>;
  r.status = vi.fn((c: number) => {
    r.statusCode = c;
    return r as Response;
  }) as never;
  r.json = vi.fn((b: unknown) => {
    r.body = b;
    return r as Response;
  }) as never;
  return r as Response & { statusCode: number; body: { results?: Array<{ name: string; status: string; message?: string }>; error?: { code: string; message: string }; targets?: unknown } };
}

async function post(w: ReturnType<typeof world>, channels: string[], id = VIDEO, caption?: string, repost?: string[]) {
  const r = res();
  await videoStudioPostHandlers(w.deps).post({ params: { id }, body: { channels, ...(caption ? { caption } : {}), ...(repost ? { repost } : {}) } } as unknown as Request, r);
  return r;
}

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
});

describe("POST /api/channels/generated_video/studio/videos/:id/post", () => {
  it("never stages anything for a channel whose account is not connected", async () => {
    w.connectedSet.delete("linkedin_video");
    const r = await post(w, ["linkedin"]);
    expect(r.statusCode).toBe(200);
    expect(r.body.results).toEqual([{ name: "linkedin", status: "not_connected", message: "Connect LinkedIn in Settings, then post again." }]);
    expect(w.emits).toHaveLength(0);
    expect(w.decide).not.toHaveBeenCalled();
    expect(w.uploads).toHaveLength(0);
  });

  it("posts the connected channels and skips the disconnected one in the same request", async () => {
    w.connectedSet.delete("tiktok_video");
    const r = await post(w, ["instagram", "tiktok"]);
    expect(r.body.results).toEqual([
      { name: "instagram", status: "posted" },
      { name: "tiktok", status: "not_connected", message: "Connect TikTok in Settings, then post again." },
    ]);
    expect(w.approvedChannels()).toEqual(["instagram_video"]);
  });

  it("sends exactly one approved publish per picked channel, through the social.publish.v2 rail, from one tenant-owned copy", async () => {
    const r = await post(w, ["instagram", "linkedin", "youtube"], VIDEO, "Watch this");
    expect(r.body.results?.map((x) => x.status)).toEqual(["posted", "posted", "posted"]);
    expect(w.approvedChannels()).toEqual(["instagram_video", "linkedin_video", "youtube_video"]);
    expect(w.approvals).toHaveLength(3);
    expect(w.uploads).toHaveLength(1);
    expect(w.downloads).toEqual([`launch-video-artifacts/${TENANT}/${RUN}/ugc-ad.mp4`]);
    const path = w.uploads[0].replace(/^launch-video-media\//, "");
    expect(w.uploads[0].startsWith(`launch-video-media/${TENANT}/`)).toBe(true);
    for (const e of w.emits) {
      expect(e.tenant).toBe(TENANT);
      expect(e.body).toMatchObject({ origin: "library_post", source_video_id: VIDEO, scheduled_at: null });
      expect((e.body.payload as Row).video_path).toBe(path);
      expect((e.body.payload as Row).text).toBe("Watch this");
    }
    const yt = w.emits.find((e) => e.body.channel === "youtube_video")!;
    expect(yt.body.payload).toEqual({ title: "UGC ad", text: "Watch this", video_path: path, privacy: "public" });
  });

  it("a second Post or a retry after success posts nothing new", async () => {
    await post(w, ["x", "instagram"]);
    const again = await post(w, ["x", "instagram"]);
    expect(again.body.results).toEqual([
      { name: "instagram", status: "already_posted" },
      { name: "x", status: "already_posted" },
    ]);
    expect(w.emits).toHaveLength(2);
    expect(w.approvals).toHaveLength(2);
    expect(w.uploads).toHaveLength(1);
  });

  it("a double click racing two requests approves one publish per channel and rejects the loser's card", async () => {
    const [a, b] = await Promise.all([post(w, ["x"]), post(w, ["x"])]);
    expect(w.emits.length).toBe(2);
    expect(w.approvedChannels()).toEqual(["x_video"]);
    expect(w.tables.decisions.filter((d) => d.status === "rejected")).toHaveLength(1);
    expect(w.tables.decisions.filter((d) => d.status === "proposed")).toHaveLength(0);
    expect([a.body.results?.[0].status, b.body.results?.[0].status].sort()).toEqual(["already_posted", "posted"]);
  });

  it.each(["instagram", "linkedin", "x", "tiktok", "youtube"] as const)(
    "a %s post whose approve went through but whose send to the publisher failed goes out on the retry, sent once under the same id",
    async (name) => {
      const real = w.decide.getMockImplementation()!;
      w.decide.mockImplementationOnce(async (x: Parameters<typeof real>[0]) => {
        await real(x);
        throw new Error("inngest send failed: ECONNREFUSED");
      });
      const first = await post(w, [name]);
      expect(first.body.results).toEqual([{ name, status: "failed", message: "This post did not go out. Try again in a minute." }]);
      expect(w.tables.decisions.map((d) => d.status)).toEqual(["approved"]);
      expect(w.redispatched).toEqual([]);

      const retry = await post(w, [name]);
      expect(retry.body.results).toEqual([{ name, status: "already_posted" }]);
      expect(w.redispatched).toEqual([w.tables.decisions[0].id]);
      expect(w.redispatch).toHaveBeenCalledWith(TENANT, w.tables.decisions[0].id);
      expect(w.emits).toHaveLength(1);
      expect(w.approvals).toHaveLength(1);
    },
  );

  it("reports the retry as failed, not posted, when the re-send to the publisher fails too", async () => {
    const real = w.decide.getMockImplementation()!;
    w.decide.mockImplementationOnce(async (x: Parameters<typeof real>[0]) => {
      await real(x);
      throw new Error("inngest send failed");
    });
    await post(w, ["linkedin"]);
    w.redispatch.mockRejectedValueOnce(new Error("inngest send failed again"));
    const retry = await post(w, ["linkedin"]);
    expect(retry.body.results).toEqual([{ name: "linkedin", status: "failed", message: "This post did not go out. Try again in a minute." }]);
  });

  it("never re-sends a card the publisher already picked up or published", async () => {
    await post(w, ["x", "linkedin", "instagram"]);
    const card = (c: string) => w.tables.decisions.find((d) => (d.body as Row).channel === c)!;
    card("x_video").status = "dispatching";
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: card("linkedin_video").id, status: "published" });
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: card("instagram_video").id, status: "queued" });
    const again = await post(w, ["x", "linkedin", "instagram"]);
    expect(again.body.results?.map((r: { status: string }) => r.status)).toEqual(["already_posted", "already_posted", "already_posted"]);
    expect(w.redispatched).toEqual([]);
  });

  it("allows posting again after the earlier publish failed", async () => {
    await post(w, ["x"]);
    const first = w.tables.decisions[0];
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: first.id, status: "failed" });
    const r = await post(w, ["x"]);
    expect(r.body.results).toEqual([{ name: "x", status: "posted" }]);
    expect(w.approvals).toHaveLength(2);
    expect(w.uploads).toHaveLength(1);
  });

  it("refuses with nothing staged while social publishing is paused", async () => {
    w.gate.open = false;
    const r = await post(w, ["instagram", "x"]);
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toEqual({ code: "social_publish_paused", message: "Posting is paused for your account right now, so nothing was posted." });
    expect(w.emits).toHaveLength(0);
    expect(w.uploads).toHaveLength(0);
    expect(w.decide).not.toHaveBeenCalled();
  });

  it("refuses another tenant's video without reading or posting it", async () => {
    const r = await post(w, ["instagram"], FOREIGN_VIDEO);
    expect(r.statusCode).toBe(404);
    expect(r.body.error?.code).toBe("video_not_found");
    expect(w.downloads).toHaveLength(0);
    expect(w.emits).toHaveLength(0);
  });

  it("refuses a row in this tenant whose file lives under another tenant's folder", async () => {
    w.tables.run_artifacts[0].storage_path = `${OTHER}/${RUN}/ugc-ad.mp4`;
    const r = await post(w, ["instagram"]);
    expect(r.statusCode).toBe(404);
    expect(w.downloads).toHaveLength(0);
    expect(w.emits).toHaveLength(0);
  });

  it("refuses another tenant's row even if a database client failed to scope the read", async () => {
    const scoped = w.deps.db;
    w.deps.db = () => scoped(OTHER);
    w.tables.run_artifacts[1].storage_path = `${TENANT}/${RUN}/theirs.mp4`;
    const r = await post(w, ["instagram"], FOREIGN_VIDEO);
    expect(r.statusCode).toBe(404);
    expect(w.downloads).toHaveLength(0);
    expect(w.emits).toHaveLength(0);
  });

  it("marks Facebook as coming soon and stages nothing for it", async () => {
    const r = await post(w, ["facebook"]);
    expect(r.body.results).toEqual([{ name: "facebook", status: "coming_soon", message: "Posting to Facebook is not available yet." }]);
    expect(w.emits).toHaveLength(0);
  });

  it("refuses a channel name the server does not know", async () => {
    const r = await post(w, ["instagram_video"]);
    expect(r.statusCode).toBe(400);
    expect(w.emits).toHaveLength(0);
  });

  it("refuses a request whose tenant came from an override header, staging and approving nothing", async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ tenant_id: TENANT, user_id: USER, access_token: "tok", tenant_overridden: true } as never);
    const r = await post(w, ["instagram", "x"], VIDEO, "Caption");
    expect(r.statusCode).toBe(403);
    expect(r.body).toEqual({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." } });
    expect(w.emits).toHaveLength(0);
    expect(w.uploads).toHaveLength(0);
    expect(w.downloads).toHaveLength(0);
    expect(w.decide).not.toHaveBeenCalled();
  });

  it("a later Post with a new caption publishes the new caption, not the one staged by an earlier refused approve", async () => {
    const real = w.decide.getMockImplementation()!;
    let refusing = true;
    w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) =>
      refusing && x.action === "approve" ? { ok: false, code: "not_authorized", changed: false, status: "proposed", decision_id: x.decision_id } : real(x),
    );
    const first = await post(w, ["instagram", "youtube"], VIDEO, "Caption A");
    expect(first.body.results?.map((x) => x.status)).toEqual(["failed", "failed"]);
    expect(w.tables.decisions.map((d) => [d.status, ((d.body as Row).payload as Row).text])).toEqual([
      ["rejected", "Caption A"],
      ["rejected", "Caption A"],
    ]);
    refusing = false;
    w.decide.mockClear();
    const second = await post(w, ["instagram", "youtube"], VIDEO, "Caption B");
    expect(second.body.results).toEqual([
      { name: "instagram", status: "posted" },
      { name: "youtube", status: "posted" },
    ]);
    expect(w.emits).toHaveLength(4);
    expect(w.uploads).toHaveLength(1);
    const approved = w.tables.decisions.filter((d) => d.status === "approved");
    expect(approved).toHaveLength(2);
    for (const d of approved) expect(((d.body as Row).payload as Row).text).toBe("Caption B");
    const yt = approved.find((d) => (d.body as Row).channel === "youtube_video")!;
    expect(((yt.body as Row).payload as Row).title).toBe("UGC ad");
    for (const call of w.decide.mock.calls) expect(call[0]).toMatchObject({ action: "approve" });
  });

  it("publishes a Suggested-ad video under its hook, never the internal card tag or the file extension", async () => {
    const r = await post(w, ["instagram", "linkedin", "youtube"], CARD_VIDEO);
    expect(r.body.results?.map((x) => x.status)).toEqual(["posted", "posted", "posted"]);
    expect(w.emits).toHaveLength(3);
    const published = w.tables.decisions.filter((d) => d.status === "approved").map((d) => (d.body as Row).payload as Row);
    expect(published).toHaveLength(3);
    for (const p of published) {
      for (const field of [p.text, p.title].filter((v) => v !== undefined)) {
        expect(field).toBe(HOOK);
        expect(String(field)).not.toMatch(/[0-9a-f]{8}/i);
        expect(String(field)).not.toMatch(/\.mp4/i);
      }
    }
    const yt = w.emits.find((e) => e.body.channel === "youtube_video")!;
    expect(yt.body.payload).toMatchObject({ title: HOOK, text: HOOK });
  });

  it("keeps a trailing number that is part of the real title on a video not made from a card", async () => {
    await post(w, ["youtube"], HEX_VIDEO);
    expect(w.emits[0].body.payload).toMatchObject({ title: "Call us on 55512345", text: "Call us on 55512345" });
  });

  it("rejects its own staged card when the approve is refused for a non-member, leaving nothing in the queue", async () => {
    const real = w.decide.getMockImplementation()!;
    w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) =>
      x.action === "approve" ? { ok: false, code: "not_member", changed: false, status: "proposed", decision_id: x.decision_id } : real(x),
    );
    const r = await post(w, ["instagram", "x"]);
    expect(r.body.results).toEqual([
      { name: "instagram", status: "failed", message: "Only a workspace owner or admin can post this." },
      { name: "x", status: "failed", message: "Only a workspace owner or admin can post this." },
    ]);
    expect(w.approvals).toHaveLength(0);
    expect(w.tables.decisions).toHaveLength(2);
    expect(w.tables.decisions.map((d) => d.status)).toEqual(["rejected", "rejected"]);
    expect(w.decide.mock.calls.filter((c) => c[0].action === "reject").map((c) => c[0].decision_id).sort()).toEqual(
      w.tables.decisions.map((d) => d.id).sort(),
    );
  });

  it("leaves a card someone else staged alone when this caller's approve is refused", async () => {
    w.tables.decisions.push({ id: "staged-by-owner", tenant_id: TENANT, decision_class: "social.publish.v2", status: "proposed", emitted_at: "2026-10-26T00:00:00Z", body: { channel: "x_video", origin: "library_post", source_video_id: VIDEO, payload: { text: "UGC ad", video_path: `${TENANT}/abc.mp4` } } });
    const real = w.decide.getMockImplementation()!;
    w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) =>
      x.action === "approve" ? { ok: false, code: "not_authorized", changed: false, status: "proposed", decision_id: x.decision_id } : real(x),
    );
    await post(w, ["x"]);
    expect(w.emits).toHaveLength(0);
    expect(w.decide.mock.calls.map((c) => c[0].action)).toEqual(["approve"]);
    expect(w.tables.decisions[0].status).toBe("proposed");
  });

  it("rejects its own staged card when the approve is refused as an invalid edit, and shows the reason", async () => {
    const real = w.decide.getMockImplementation()!;
    w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) =>
      x.action === "approve" ? { ok: false, code: "invalid_edit", changed: false, status: "proposed", decision_id: x.decision_id, detail: "Fill before publishing: [Name]" } : real(x),
    );
    const r = await post(w, ["instagram"], VIDEO, "Hi [Name], watch this");
    expect(r.body.results).toEqual([{ name: "instagram", status: "failed", message: "Fill before publishing: [Name]" }]);
    const mine = w.tables.decisions.map((d) => d.id);
    expect(mine).toHaveLength(1);
    expect(w.decide.mock.calls.filter((c) => c[0].action === "reject").map((c) => c[0].decision_id)).toEqual(mine);
    expect(w.tables.decisions.map((d) => d.status)).toEqual(["rejected"]);
    expect(w.approvals).toHaveLength(0);
  });

  it.each(["rpc_error", "decision_closed", "stale_card", "cross_tenant"])(
    "rejects its own staged card on %s and shows only the generic line, never the internal detail",
    async (code) => {
      const real = w.decide.getMockImplementation()!;
      w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) =>
        x.action === "approve" ? { ok: false, code, changed: false, status: "proposed", decision_id: x.decision_id, detail: "pg: relation decisions locked" } : real(x),
      );
      const r = await post(w, ["x"]);
      expect(r.body.results).toEqual([{ name: "x", status: "failed", message: "This post did not go out. Try again in a minute." }]);
      expect(w.tables.decisions.map((d) => d.status)).toEqual(["rejected"]);
      expect(w.decide.mock.calls.filter((c) => c[0].action === "reject").map((c) => c[0].decision_id)).toEqual([w.tables.decisions[0].id]);
    },
  );

  it.each(["approved", "dispatching", "acted"])(
    "an approve the RPC answers with changed:false because a concurrent request already moved the card to %s reports the post as made and never rejects it",
    async (closedAs) => {
      const real = w.decide.getMockImplementation()!;
      w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) => {
        if (x.action !== "approve") return real(x);
        w.tables.decisions.find((d) => d.id === x.decision_id)!.status = closedAs;
        return { ok: true, code: "ok", changed: false, status: closedAs, decision_id: x.decision_id };
      });
      const r = await post(w, ["x"]);
      expect(r.body.results).toEqual([{ name: "x", status: "already_posted" }]);
      expect(JSON.stringify(r.body)).not.toContain("did not go out");
      expect(w.decide.mock.calls.filter((c) => c[0].action === "reject")).toHaveLength(0);
      expect(w.tables.decisions.map((d) => d.status)).toEqual([closedAs]);
    },
  );

  it("an approve answered changed:false with a status that is not a yes still fails honestly", async () => {
    const real = w.decide.getMockImplementation()!;
    w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) => {
      if (x.action !== "approve") return real(x);
      w.tables.decisions.find((d) => d.id === x.decision_id)!.status = "rejected";
      return { ok: true, code: "ok", changed: false, status: "rejected", decision_id: x.decision_id };
    });
    const r = await post(w, ["x"]);
    expect(r.body.results).toEqual([{ name: "x", status: "failed", message: "This post did not go out. Try again in a minute." }]);
    expect(w.tables.decisions.map((d) => d.status)).toEqual(["rejected"]);
  });

  it("when a concurrent card wins and its approve is refused, rejects only its own loser card and leaves the winner proposed", async () => {
    const emit = w.deps.emit;
    w.deps.emit = vi.fn(async (tenant: string, body: Record<string, unknown>) => {
      const id = await emit(tenant, body);
      w.tables.decisions.push({ id: "rival", tenant_id: TENANT, decision_class: "social.publish.v2", status: "proposed", emitted_at: "2026-10-26T00:00:00Z", body: { ...body } });
      return id;
    });
    const real = w.decide.getMockImplementation()!;
    w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) =>
      x.action === "approve" ? { ok: false, code: "invalid_edit", changed: false, status: "proposed", decision_id: x.decision_id, detail: "Fill before publishing: [Name]" } : real(x),
    );
    const r = await post(w, ["x"]);
    const mine = w.tables.decisions.find((d) => d.id !== "rival")!;
    expect(w.decide.mock.calls.filter((c) => c[0].action === "approve").map((c) => c[0].decision_id)).toEqual(["rival"]);
    expect(w.decide.mock.calls.filter((c) => c[0].action === "reject").map((c) => c[0].decision_id)).toEqual([mine.id]);
    expect(mine.status).toBe("rejected");
    expect(w.tables.decisions.find((d) => d.id === "rival")!.status).toBe("proposed");
    expect(r.body.results).toEqual([{ name: "x", status: "failed", message: "Fill before publishing: [Name]" }]);
  });

  it("says posting is turned off for the channel when its autonomy is forbidden, and never approves anything", async () => {
    const emit = w.deps.emit;
    w.deps.emit = vi.fn(async (tenant: string, body: Record<string, unknown>) => {
      const id = await emit(tenant, body);
      Object.assign(w.tables.decisions.find((d) => d.id === id)!, { status: "rejected", autonomy_at_emit: "forbidden" });
      return id;
    });
    const r = await post(w, ["tiktok"]);
    expect(r.body.results).toEqual([{ name: "tiktok", status: "failed", message: "Posting is turned off for TikTok in your approval settings, so nothing was posted." }]);
    expect(JSON.stringify(r.body)).not.toContain("Try again");
    expect(w.decide.mock.calls.filter((c) => c[0].action === "approve")).toHaveLength(0);
    expect(w.approvals).toHaveLength(0);
  });

  it("stages a TikTok post as SELF_ONLY, the only level an unaudited TikTok app may use, which the Library labels private", async () => {
    await post(w, ["tiktok"]);
    expect((w.emits[0].body.payload as Row).privacy).toBe("SELF_ONLY");
  });

  it("approves a staged card with the same caption without rewriting it", async () => {
    await post(w, ["x"], VIDEO, "Same words");
    expect(w.decide.mock.calls[0][0]).not.toHaveProperty("payload_edit");
  });

  it("reports a post as made when the approve lands and the decision is acted on in the same call, never rejecting the card", async () => {
    const real = w.decide.getMockImplementation()!;
    w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) => {
      if (x.action !== "approve") return real(x);
      w.tables.decisions.find((d) => d.id === x.decision_id)!.status = "acted";
      return { ok: true, code: "ok", changed: true, status: "acted", decision_id: x.decision_id };
    });
    const r = await post(w, ["instagram"]);
    expect(r.body.results).toEqual([{ name: "instagram", status: "posted" }]);
    expect(w.decide.mock.calls.filter((c) => c[0].action === "reject")).toHaveLength(0);
    expect(w.tables.decisions.map((d) => d.status)).toEqual(["acted"]);
  });

  it("a second Post with the same caption after a transient approve failure stages a fresh card instead of getting the rejected one back", async () => {
    const real = w.decide.getMockImplementation()!;
    let failing = true;
    w.decide.mockImplementation(async (x: Parameters<typeof real>[0]) =>
      failing && x.action === "approve" ? { ok: false, code: "rpc_error", changed: false, status: "proposed", decision_id: x.decision_id } : real(x),
    );
    const first = await post(w, ["instagram", "x"], VIDEO, "Same caption");
    expect(first.body.results?.map((x) => x.status)).toEqual(["failed", "failed"]);
    expect(w.tables.decisions.map((d) => d.status)).toEqual(["rejected", "rejected"]);
    failing = false;
    const second = await post(w, ["instagram", "x"], VIDEO, "Same caption");
    expect(second.body.results).toEqual([
      { name: "instagram", status: "posted" },
      { name: "x", status: "posted" },
    ]);
    expect(w.tables.decisions).toHaveLength(4);
    expect(w.approvedChannels()).toEqual(["instagram_video", "x_video"]);
    expect(new Set(w.emits.map((e) => e.body.post_attempt)).size).toBe(4);
  });

  it("never sends again a post the platform did not confirm, and says to check the platform first", async () => {
    await post(w, ["tiktok"]);
    const first = w.tables.decisions[0];
    first.status = "acted";
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: first.id, status: "failed", last_error: "transient_exhausted" });
    const r = await post(w, ["tiktok"]);
    expect(r.body.results).toEqual([
      { name: "tiktok", status: "failed", message: "TikTok did not confirm the last post of this video, so Zavi did not send it again. Check TikTok, then post again if it is not there." },
    ]);
    expect(w.emits).toHaveLength(1);
    expect(w.approvals).toHaveLength(1);
    expect(w.redispatched).toEqual([]);
  });

  it("posts an unconfirmed channel again only when the founder asks for that channel by name", async () => {
    await post(w, ["tiktok", "x"]);
    for (const d of w.tables.decisions) {
      d.status = "acted";
      w.tables.social_posts.push({ tenant_id: TENANT, decision_id: d.id, status: "failed", last_error: "transient_exhausted" });
    }
    const r = await post(w, ["tiktok", "x"], VIDEO, undefined, ["tiktok"]);
    expect(r.body.results?.map((x) => [x.name, x.status])).toEqual([
      ["x", "failed"],
      ["tiktok", "posted"],
    ]);
    expect(w.emits.filter((e) => e.body.channel === "tiktok_video")).toHaveLength(2);
    expect(w.emits.filter((e) => e.body.channel === "x_video")).toHaveLength(1);
  });

  it("refuses a repost list naming a channel the server does not know", async () => {
    const r = await post(w, ["tiktok"], VIDEO, undefined, ["tiktok_video"]);
    expect(r.statusCode).toBe(400);
    expect(w.emits).toHaveLength(0);
  });

  it("reports a refused approve as a failure, not a post", async () => {
    w.decide.mockImplementationOnce(async (a: { decision_id: string }) => ({ ok: false, code: "not_authorized", changed: false, status: "proposed", decision_id: a.decision_id }));
    const r = await post(w, ["x"]);
    expect(r.body.results).toEqual([{ name: "x", status: "failed", message: "Only a workspace owner or admin can post this." }]);
    expect(w.approvals).toHaveLength(0);
  });
});

describe("GET /api/channels/generated_video/studio/post-targets", () => {
  it("lists all six channels with connection state and Facebook coming soon", async () => {
    w.connectedSet.delete("tiktok_video");
    const r = res();
    await videoStudioPostHandlers(w.deps).targets({} as Request, r);
    expect(r.body.targets).toEqual([
      { name: "instagram", label: "Instagram", status: "connected" },
      { name: "facebook", label: "Facebook", status: "coming_soon" },
      { name: "linkedin", label: "LinkedIn", status: "connected" },
      { name: "x", label: "X", status: "connected" },
      { name: "tiktok", label: "TikTok", status: "not_connected" },
      { name: "youtube", label: "YouTube", status: "connected" },
    ]);
  });
});

describe("default deps", () => {
  it("re-sends a stuck approval under a fresh event id, so the earlier approve's event id never swallows it", async () => {
    const { inngest } = await import("@/../workers/client");
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    await defaultPostDeps.redispatch(TENANT, "d-1");
    await defaultPostDeps.redispatch(TENANT, "d-1");
    const ids = send.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).not.toBe("approve:d-1");
      expect(id.startsWith("approve:d-1:")).toBe(true);
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect(send.mock.calls[0][0]).toMatchObject({ name: "decision.approved", data: { decision_id: "d-1", tenant_id: TENANT } });
    send.mockRestore();
  });

  it("reads storage through the tenant-scoped helper for the caller's tenant", () => {
    expect(defaultPostDeps.storage(TENANT)).toEqual({ storageFor: TENANT });
    expect(tenantStorage).toHaveBeenCalledWith(TENANT);
  });

  it("keeps posting shut while the publish switch is paused unless this tenant has the local override", async () => {
    vi.mocked(isSocialPublishEnabled).mockResolvedValueOnce(false);
    expect(await defaultPostDeps.gateOpen(TENANT)).toBe(false);
    vi.mocked(isSocialPublishEnabled).mockResolvedValueOnce(false);
    vi.mocked(localOverrideAllows).mockReturnValueOnce(true);
    expect(await defaultPostDeps.gateOpen(TENANT)).toBe(true);
    expect(localOverrideAllows).toHaveBeenLastCalledWith(TENANT);
    vi.mocked(isSocialPublishEnabled).mockResolvedValueOnce(true);
    expect(await defaultPostDeps.gateOpen(TENANT)).toBe(true);
  });
});

describe("caption cut per channel", () => {
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("posts a 300-character emoji-heavy caption to X cut to X's weighted 280", async () => {
    const caption = "\u2705".repeat(300);
    const r = await post(w, ["x"], VIDEO, caption);
    expect(r.body.results).toEqual([{ name: "x", status: "posted" }]);
    const text = String((w.emits[0].body.payload as Row).text);
    expect(xWeightedLength(text).length).toBeLessThanOrEqual(280);
    expect(text).toBe("\u2705".repeat(140));
  });

  it("never splits an astral emoji in half when the cap lands inside it", async () => {
    const title = `a${"\u{1F600}".repeat(60)}`;
    w.tables.run_artifacts[0].filename = `${title}.mp4`;
    const r = await post(w, ["youtube", "x"]);
    expect(r.body.results?.map((x) => x.status)).toEqual(["posted", "posted"]);
    const yt = w.emits.find((e) => e.body.channel === "youtube_video")!.body.payload as Row;
    expect(loneSurrogate.test(String(yt.title))).toBe(false);
    expect(yt.title).toBe(`a${"\u{1F600}".repeat(49)}`);
    for (const e of w.emits) {
      const text = String((e.body.payload as Row).text);
      expect(loneSurrogate.test(text)).toBe(false);
    }
  });
});

describe("readPostStates", () => {
  it("splits a video's channels into published and still going out, leaving out pending, rejected, failed and other tenants' posts", async () => {
    await post(w, ["instagram", "x", "linkedin", "tiktok"]);
    const card = (c: string) => w.tables.decisions.find((d) => (d.body as Row).channel === c)!;
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: card("x_video").id, status: "failed" });
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: card("linkedin_video").id, status: "published" });
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: card("tiktok_video").id, status: "queued" });
    w.tables.decisions.push({ id: "p1", tenant_id: TENANT, decision_class: "social.publish.v2", status: "proposed", emitted_at: "z", body: { channel: "youtube_video", origin: "library_post", source_video_id: VIDEO } });
    w.tables.decisions.push({ id: "o1", tenant_id: OTHER, decision_class: "social.publish.v2", status: "approved", emitted_at: "z", body: { channel: "youtube_video", origin: "library_post", source_video_id: VIDEO } });
    expect(await readPostStates(TENANT, [VIDEO], w.deps)).toEqual({ [VIDEO]: { posted_on: ["linkedin"], posting_on: ["instagram", "tiktok"], check_on: [], failed_on: ["x"] } });
  });

  it("names a channel posted, not still going out, once any of its cards is published", async () => {
    await post(w, ["x"]);
    const first = w.tables.decisions[0];
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: first.id, status: "published" });
    w.tables.decisions.push({ id: "x2", tenant_id: TENANT, decision_class: "social.publish.v2", status: "approved", emitted_at: "z", body: { channel: "x_video", origin: "library_post", source_video_id: VIDEO } });
    expect(await readPostStates(TENANT, [VIDEO], w.deps)).toEqual({ [VIDEO]: { posted_on: ["x"], posting_on: [], check_on: [], failed_on: [] } });
  });

  it("names an unconfirmed channel to check, a rejected one as failed, and forgets an old failure once a newer post went out", async () => {
    await post(w, ["instagram", "x", "tiktok"]);
    const card = (c: string) => w.tables.decisions.find((d) => (d.body as Row).channel === c)!;
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: card("tiktok_video").id, status: "failed", last_error: "transient_exhausted" });
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: card("x_video").id, status: "failed", last_error: "vendor_rejected" });
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: card("instagram_video").id, status: "failed", last_error: "vendor_rejected" });
    w.tables.decisions.push({ id: "ig2", tenant_id: TENANT, decision_class: "social.publish.v2", status: "acted", emitted_at: "2026-10-28T00:00:00Z", body: { channel: "instagram_video", origin: "library_post", source_video_id: VIDEO } });
    w.tables.social_posts.push({ tenant_id: TENANT, decision_id: "ig2", status: "queued" });
    expect(await readPostStates(TENANT, [VIDEO], w.deps)).toEqual({ [VIDEO]: { posted_on: [], posting_on: ["instagram"], check_on: ["tiktok"], failed_on: ["x"] } });
  });

  it("names a channel failed when its dispatch was refused before any post row was written", async () => {
    await post(w, ["tiktok"]);
    w.tables.decisions[0].status = "dispatch_failed";
    expect(await readPostStates(TENANT, [VIDEO], w.deps)).toEqual({ [VIDEO]: { posted_on: [], posting_on: [], check_on: [], failed_on: ["tiktok"] } });
  });
});
