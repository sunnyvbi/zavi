import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  auth: { user_id: "u1", tenant_id: "t1", access_token: "tok" } as unknown,
  role: true,
  enabled: true,
  buildOpen: true,
  tucked: false,
  oneState: false,
  skipNoConfirm: false,
  intent: "existing" as string | Error,
  settingReads: [] as Array<[string, unknown]>,
  rpcCalls: [] as Array<[string, unknown]>,
  rpcError: null as { message: string } | null,
  state: { enabled: true, done: false } as unknown,
  enqueue: vi.fn(async (..._a: unknown[]) => ({ run_id: "run-1" as string | null })),
  progress: { setup_connectors_at: "x" } as unknown,
  runs: [] as unknown[],
  plan: false,
  research: "ready",
  researchEnabled: true,
  delivery: null as unknown,
  applySaved: vi.fn(async () => ({phase:"applied",plan_id:"p1"})),
  reconciled: 0,
  reconcileFails: false,
  importDocs: [] as Array<{ extraction: unknown; created_at: string }>,
  note: { id: null, metadata: {} } as { id: string | null; metadata: Record<string, unknown> } | Error,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_q: Request, res: Response) => {
    if (h.auth) return h.auth;
    res.status(401).json({});
    return null;
  }),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_a: unknown, _r: string[], res: Response) => {
    if (!h.role) res.status(403).json({ error: { code: "forbidden" } });
    return h.role;
  }),
}));
vi.mock("@/services/settings", () => ({
  getBoolSetting: vi.fn(async (key: string, tenant: unknown) => {
    h.settingReads.push([key, tenant]);
    if (key === "setup_coding_prompt_tucked") return h.tucked;
    if (key === "setup_strategy_one_state") return h.oneState;
    if (key === "setup_skip_no_confirm") return h.skipNoConfirm;
    return key === "build_signup_lands_on_build" ? h.buildOpen : h.enabled;
  }),
  getStringSetting: vi.fn(async (key: string, tenant: unknown) => {
    h.settingReads.push([key, tenant]);
    if (h.intent instanceof Error) throw h.intent;
    return key === "build_app_intent" ? h.intent : "";
  }),
}));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    rpc: async (fn: string, args: unknown) => {
      h.rpcCalls.push([fn, args]);
      return { data: null, error: h.rpcError };
    },
    from: () => { const q = { select: () => q, eq: () => q, limit: async () => ({ data: h.plan ? [{ id: "p" }] : [], error: null }) }; return q; },
  }),
}));
vi.mock("@/services/setup/state", () => ({
  readSetupState: vi.fn(async () => h.state),
  readProgressRow: vi.fn(async () => h.progress),
  readSetupDraftRuns: vi.fn(async () => h.runs),
}));
vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: (...a: unknown[]) => h.enqueue(...(a as [])),
  FleetHaltedError: class FleetHaltedError extends Error {},
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));
vi.mock("@/services/growth/strategy-delivery", () => ({ readStrategyDelivery: async () => h.delivery, applySavedStrategy: (...a: unknown[]) => h.applySaved(...(a as [])) }));
vi.mock("../growth-intake-research", () => ({ isIntakeResearchEnabled: async () => h.researchEnabled, readTodaysResearch: vi.fn(async () => ({ status: h.research, payload: null })) }));
vi.mock("../growth-strategy-draft", () => ({ researchForDraft: () => null, researchIsSettled: (s: string | null) => !!s && s !== "pending" }));
vi.mock("../growth-interview", () => ({ readNote: async () => { if (h.note instanceof Error) throw h.note; return h.note; } }));
vi.mock("@/services/growth/setup-draft", async (orig) => ({
  ...(await orig<typeof import("@/services/growth/setup-draft")>()),
  pastWorkForDraft: vi.fn(async () => [{ fact: "trial->paid 22%" }]),
}));
vi.mock("@/services/growth/setup-draft-refund", () => ({
  reconcileSetupDraftRefunds: vi.fn(async () => {
    h.reconciled += 1;
    if (h.reconcileFails) throw new Error("ledger down");
  }),
}));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (s: string) => s }));
vi.mock("@/services/knowledge-import/run-read", () => ({
  anyImportReadOpen: vi.fn(async () =>
    h.importDocs.some((d) => {
      const recent = (iso: string) => Date.now() - Date.parse(iso) <= 10 * 60 * 1000;
      const ex = d.extraction as { state?: string; claimed_at?: string } | null;
      if (!ex) return recent(d.created_at);
      return (ex.state === "reading" || ex.state === "compensating") && recent(ex.claimed_at ?? d.created_at);
    }),
  ),
}));

import { getSetup, postSetupDraft, postSetupProgress } from "../setup";
import { InsufficientCreditsError } from "@/services/agents/runner";

function res() {
  const out = { statusCode: 200, body: undefined as unknown };
  const r = {
    status(c: number) { out.statusCode = c; return r; },
    json(b: unknown) { out.body = b; return r; },
  };
  return { out, r: r as unknown as Response };
}
const req = (body?: unknown) => ({ body }) as Request;

beforeEach(() => {
  h.auth = { user_id: "u1", tenant_id: "t1", access_token: "tok" };
  h.delivery = null; h.researchEnabled = true;
  h.role = true; h.enabled = true; h.buildOpen = true; h.tucked = false; h.oneState = false; h.skipNoConfirm = false; h.intent = "existing"; h.settingReads = []; h.rpcCalls = []; h.rpcError = null;
  h.state = { enabled: true, done: false };
});

describe("GET /api/workspace/setup", () => {
  it("kill switch OFF answers enabled:false and reads nothing else", async () => {
    h.enabled = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: false });
  });
  it("ON returns the derived state", async () => {
    h.buildOpen = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual(h.state);
    expect(out.body).not.toHaveProperty("build_open");
  });
  it("B10: with build_signup_lands_on_build on, the state tells the web to keep Build open, read for the caller's tenant", async () => {
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: true, done: false, build_open: true });
    expect(h.settingReads).toContainEqual(["build_signup_lands_on_build", "t1"]);
  });
  it("a founder who chose to build from an idea gets from_scratch, read for the caller's tenant", async () => {
    h.intent = "fresh";
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: true, done: false, build_open: true, from_scratch: true });
    expect(h.settingReads).toContainEqual(["build_app_intent", "t1"]);
  });
  it("an existing-product tenant, or an unreadable intent, gets no from_scratch and the read still answers", async () => {
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).not.toHaveProperty("from_scratch");
    h.intent = new Error("db blip");
    const second = res();
    await getSetup(req(), second.r);
    expect(second.out.body).toEqual({ enabled: true, done: false, build_open: true });
  });
  it("B10: the setup kill switch OFF never carries build_open", async () => {
    h.enabled = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: false });
  });
});

describe("B11: the coding-tool prompt is tucked away for founders", () => {
  it("with setup_coding_prompt_tucked on, the state tells the web to fold the prompt, read for the caller's tenant", async () => {
    h.tucked = true;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: true, done: false, build_open: true, coding_prompt_tucked: true });
    expect(h.settingReads).toContainEqual(["setup_coding_prompt_tucked", "t1"]);
  });
  it("a step answer keeps the fold, so saving step 1 never pops the prompt back open", async () => {
    h.tucked = true;
    h.buildOpen = false;
    const { out, r } = res();
    await postSetupProgress(req({ step: "docs", outcome: "done" }), r);
    expect(out.body).toEqual({ enabled: true, done: false, coding_prompt_tucked: true });
  });
  it("with the key off the answer is exactly the old one", async () => {
    h.buildOpen = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: true, done: false });
  });
  it("the setup kill switch OFF never carries the fold and never reads the key", async () => {
    h.tucked = true;
    h.enabled = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: false });
    expect(h.settingReads.map(([k]) => k)).not.toContain("setup_coding_prompt_tucked");
  });
});

describe("B12: the page and the chat tell one strategy story", () => {
  it("with setup_strategy_one_state on, the state carries one_state, read for the caller's tenant", async () => {
    h.oneState = true;
    h.buildOpen = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: true, done: false, one_state: true });
    expect(h.settingReads).toContainEqual(["setup_strategy_one_state", "t1"]);
  });
  it("finishing setup keeps the flag, so the page never falls back to its own check mid-draft", async () => {
    h.oneState = true;
    h.buildOpen = false;
    const { out, r } = res();
    await postSetupProgress(req({ step: "done" }), r);
    expect(out.body).toEqual({ enabled: true, done: false, one_state: true });
  });
  it("with the key off the answer carries no one_state", async () => {
    h.buildOpen = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: true, done: false });
  });
  it("the setup kill switch OFF never reads the key", async () => {
    h.oneState = true;
    h.enabled = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: false });
    expect(h.settingReads.map(([k]) => k)).not.toContain("setup_strategy_one_state");
  });
});

describe("B16: Skip setup goes straight in", () => {
  it("with setup_skip_no_confirm on, the state carries skip_no_confirm, read for the caller's tenant", async () => {
    h.skipNoConfirm = true;
    h.buildOpen = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: true, done: false, skip_no_confirm: true });
    expect(h.settingReads).toContainEqual(["setup_skip_no_confirm", "t1"]);
  });
  it("a step answer keeps the flag, so a later skip still goes straight in", async () => {
    h.skipNoConfirm = true;
    h.buildOpen = false;
    const { out, r } = res();
    await postSetupProgress(req({ step: "docs", outcome: "done" }), r);
    expect(out.body).toEqual({ enabled: true, done: false, skip_no_confirm: true });
  });
  it("with the key off the answer carries no skip_no_confirm", async () => {
    h.buildOpen = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: true, done: false });
  });
  it("the setup kill switch OFF never reads the key", async () => {
    h.skipNoConfirm = true;
    h.enabled = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(out.body).toEqual({ enabled: false });
    expect(h.settingReads.map(([k]) => k)).not.toContain("setup_skip_no_confirm");
  });
  it("is a per-tenant key that ships on", async () => {
    const { APP_SETTINGS } = await import("@/services/settings/registry");
    expect(APP_SETTINGS.setup_skip_no_confirm).toMatchObject({ type: "boolean", scope: "per-tenant", defaultValue: true });
  });
});

describe("POST /api/workspace/setup/progress", () => {
  it("403 for a member (owner/admin only)", async () => {
    h.role = false;
    const { out, r } = res();
    await postSetupProgress(req({ step: "docs", outcome: "done" }), r);
    expect(out.statusCode).toBe(403);
    expect(h.rpcCalls).toEqual([]);
  });
  it("400 on an unknown step and on a step without an outcome", async () => {
    for (const body of [{ step: "nope" }, { step: "docs" }]) {
      const { out, r } = res();
      await postSetupProgress(req(body), r);
      expect(out.statusCode).toBe(400);
    }
  });
  it("maps steps to RPC kinds with the requireAuth tenant, never the body's", async () => {
    const cases: Array<[unknown, string, string]> = [
      [{ step: "docs", outcome: "skipped", tenant_id: "evil" }, "setup_docs", "skipped"],
      [{ step: "connectors", outcome: "done" }, "setup_connectors", "done"],
      [{ step: "done" }, "setup_done", "done"],
      [{ step: "home" }, "setup_home", "done"],
    ];
    for (const [body, kind, key] of cases) {
      h.rpcCalls = [];
      const { out, r } = res();
      await postSetupProgress(req(body), r);
      expect(out.statusCode).toBe(200);
      expect(h.rpcCalls).toEqual([["mark_first_run_progress", { p_tenant_id: "t1", p_kind: kind, p_key: key }]]);
    }
  });
  it("B10: a step answer keeps build_open, so marking a step never re-locks the build the founder is on", async () => {
    const { out, r } = res();
    await postSetupProgress(req({ step: "docs", outcome: "skipped" }), r);
    expect(out.statusCode).toBe(200);
    expect(out.body).toEqual({ enabled: true, done: false, build_open: true });
    h.buildOpen = false;
    const second = res();
    await postSetupProgress(req({ step: "docs", outcome: "skipped" }), second.r);
    expect(second.out.body).toEqual({ enabled: true, done: false });
  });
  it("500 when the RPC fails (the lock depends on it, so it is not swallowed)", async () => {
    h.rpcError = { message: "boom" };
    const { out, r } = res();
    await postSetupProgress(req({ step: "done" }), r);
    expect(out.statusCode).toBe(500);
  });
  it("409 when the kill switch is OFF", async () => {
    h.enabled = false;
    const { out, r } = res();
    await postSetupProgress(req({ step: "done" }), r);
    expect(out.statusCode).toBe(409);
  });
});

describe("POST /api/workspace/setup/draft", () => {
  beforeEach(() => { h.enqueue.mockReset(); h.enqueue.mockResolvedValue({ run_id: "run-1" }); h.progress = { setup_connectors_at: "x" }; h.runs = []; h.plan = false; h.research = "ready"; h.importDocs = []; h.note = { id: null, metadata: {} }; });

  it("attempt 1 goes through the admission bridge: service role, a2a, setup_draft_attempt, no key", async () => {
    const { out, r } = res();
    await postSetupDraft(req({}), r);
    expect(out.body).toEqual({ status: "queued", run_id: "run-1" });
    const arg = h.enqueue.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ agent_slug: "cgo", tenant_id: "t1", trigger: "a2a", setup_draft_attempt: 1 });
    expect(arg).not.toHaveProperty("user_access_token");
    expect(arg).not.toHaveProperty("cron_dedupe_key");
    expect((arg.payload as Record<string, unknown>).origin).toBe("setup_draft");
  });
  it("carries the founder's setup answers, the number question included (Ravi, 2026-10-24)", async () => {
    h.note = { id: "n1", metadata: { interview: { answers: { constraint: "They look, but don't buy", customers: "6-20" } } } };
    const { r } = res();
    await postSetupDraft(req({}), r);
    const payload = (h.enqueue.mock.calls[0][0] as { payload: { interview?: Array<{ question: string; answer: string }> } }).payload;
    expect(payload.interview).toEqual([
      { question: expect.stringMatching(/lose people/i), answer: "They look, but don't buy" },
      { question: expect.stringMatching(/new customers did you get last month/i), answer: "6-20" },
    ]);
  });
  it("drafts without answers when none were given, and retries when the note read fails", async () => {
    const a = res(); await postSetupDraft(req({}), a.r);
    expect((h.enqueue.mock.calls[0][0] as { payload: object }).payload).not.toHaveProperty("interview");
    h.note = new Error("db down");
    const b = res(); await postSetupDraft(req({}), b.r);
    expect(b.out.body).toEqual({ retry: true });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
  it("redrafts an existing tenant that already has a plan (Ravi, Q1)", async () => {
    h.plan = true;
    const { out, r } = res();
    await postSetupDraft(req({}), r);
    expect(out.body).toEqual({ status: "queued", run_id: "run-1" });
  });
  it("refuses before step 2 is done or skipped", async () => {
    h.progress = { setup_connectors_at: null };
    const { out, r } = res();
    await postSetupDraft(req({}), r);
    expect(out.statusCode).toBe(409);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("waits for research, like the auto path", async () => {
    h.research = "pending";
    const { out, r } = res();
    await postSetupDraft(req({}), r);
    expect(out.body).toEqual({ retry: true });
  });
  it("waits while a dropped file is still being read (no result yet, or reading)", async () => {
    const now = new Date().toISOString();
    for (const extraction of [null, { state: "reading", claim_id: "c" }, { state: "compensating", claim_id: "c" }]) {
      h.importDocs = [{ extraction: { state: "read", facts: 3 }, created_at: now }, { extraction, created_at: now }];
      const { out, r } = res();
      await postSetupDraft(req({}), r);
      expect(out.body).toEqual({ retry: true });
    }
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it("starts once every read settled (read, stored image, or unreadable)", async () => {
    const now = new Date().toISOString();
    h.importDocs = [
      { extraction: { state: "read", facts: 3 }, created_at: now },
      { extraction: { state: "stored", reason: "image" }, created_at: now },
      { extraction: { state: "unreadable", reason: "no text in it" }, created_at: now },
    ];
    const { out, r } = res();
    await postSetupDraft(req({}), r);
    expect(out.body).toEqual({ status: "queued", run_id: "run-1" });
  });
  it("stops waiting on a read stuck for more than 10 minutes", async () => {
    h.importDocs = [{ extraction: { state: "reading", claim_id: "c" }, created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }];
    const { out, r } = res();
    await postSetupDraft(req({}), r);
    expect(out.body).toEqual({ status: "queued", run_id: "run-1" });
  });
  it("a failed check of the reads fails closed: the page retries", async () => {
    const { anyImportReadOpen } = await import("@/services/knowledge-import/run-read");
    vi.mocked(anyImportReadOpen).mockRejectedValueOnce(new Error("db down"));
    const { out, r } = res();
    await postSetupDraft(req({}), r);
    expect(out.body).toEqual({ retry: true });
  });
  it("a second ask hands back the same run", async () => {
    h.runs = [{ id: "r1", status: "running", cron_dedupe_key: "cgo:draft:t1:setup" }];
    const { out, r } = res();
    await postSetupDraft(req({}), r);
    expect(out.body).toEqual({ status: "already", run_id: "r1" });
  });
  it("retry after a failure is bridged attempt 2", async () => {
    h.runs = [{ id: "r1", status: "error", cron_dedupe_key: "cgo:draft:t1:setup" }];
    const { r } = res();
    await postSetupDraft(req({ retry: true }), r);
    expect(h.enqueue.mock.calls[0][0]).toMatchObject({ setup_draft_attempt: 2 });
  });
  it("after 3: refused without paid:true; with it, a CHARGED try on a tracked paid key, no bridge", async () => {
    h.runs = [3, 2, 1].map((n) => ({ id: `r${n}`, status: "error", cron_dedupe_key: n === 1 ? "cgo:draft:t1:setup" : `cgo:draft:t1:setup:${n}` }));
    const a = res(); await postSetupDraft(req({ retry: true }), a.r);
    expect(a.out.statusCode).toBe(409);
    expect((a.out.body as { error: { code: string } }).error.code).toBe("free_attempts_used");
    const b = res(); await postSetupDraft(req({ retry: true, paid: true }), b.r);
    const arg = h.enqueue.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ trigger: "a2a", cron_dedupe_key: "cgo:draft:t1:setup:paid:4" });
    expect(arg).not.toHaveProperty("setup_draft_attempt");
  });
  it("a paid try the founder can't afford: 402 with today's refusal code", async () => {
    h.runs = [3, 2, 1].map((n) => ({ id: `r${n}`, status: "error", cron_dedupe_key: n === 1 ? "cgo:draft:t1:setup" : `cgo:draft:t1:setup:${n}` }));
    h.enqueue.mockRejectedValueOnce(new InsufficientCreditsError("cgo"));
    const { out, r } = res();
    await postSetupDraft(req({ retry: true, paid: true }), r);
    expect(out.statusCode).toBe(402);
    expect((out.body as { error: { code: string } }).error.code).toBe("insufficient_credits");
  });
  it("owner/admin only; kill switch off refuses", async () => {
    h.role = false;
    const a = res(); await postSetupDraft(req({}), a.r); expect(a.out.statusCode).toBe(403);
    h.delivery = null; h.researchEnabled = true;
  h.role = true; h.enabled = false;
    const b = res(); await postSetupDraft(req({}), b.r); expect(b.out.statusCode).toBe(409);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("GET /api/workspace/setup reconciles refunds FIRST", () => {
  beforeEach(() => { h.reconciled = 0; h.reconcileFails = false; });
  it("reconciles even with the kill switch OFF (money owed is never stranded)", async () => {
    h.enabled = false;
    const { out, r } = res();
    await getSetup(req(), r);
    expect(h.reconciled).toBe(1);
    expect(out.body).toEqual({ enabled: false });
  });
  it("a reconcile failure is logged, not swallowed, and never blocks the read", async () => {
    h.reconcileFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { out, r } = res();
    await getSetup(req(), r);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/setup draft reconcile failed/));
    expect(out.body).toEqual({ ...(h.state as object), build_open: true });
  });
});

it("retries a reviewed draft without enqueueing or consuming a paid attempt",async()=>{
 h.runs=[{id:"r3",status:"parse_failed",cron_dedupe_key:"cgo:draft:t1:setup:3"}];h.plan=false;h.progress={setup_connectors_at:"x"};
 h.delivery={phase:"failed",artifact:{strategy:{}},run_id:"r3"};h.enqueue.mockClear();
 const {out,r}=res();await postSetupDraft(req({retry:true}),r);
 expect(out.statusCode).toBe(200);expect(out.body).toEqual({status:"saved",run_id:"r3"});expect(h.enqueue).not.toHaveBeenCalled();
});
it("explicitly disabled research does not strand a fresh draft",async()=>{
 h.runs=[];h.plan=false;h.progress={setup_connectors_at:"x"};h.research="";h.researchEnabled=false;
 h.enqueue.mockResolvedValueOnce({run_id:"r1"});const {out,r}=res();await postSetupDraft(req(),r);
 expect(out.body).toEqual({status:"queued",run_id:"r1"});
});
