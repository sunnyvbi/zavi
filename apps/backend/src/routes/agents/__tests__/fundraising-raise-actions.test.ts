
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getBool: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/settings", () => ({ getBoolSetting: mocks.getBool }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: mocks.rpc }),
}));

import { fundraisingSetRaisePhase } from "../fundraising-raise-phase";
import {
  fundraisingCreateRaiseIntro,
  fundraisingMarkIntroSent,
  fundraisingCreateRaiseMeeting,
  fundraisingSetMeetingPrep,
  fundraisingDebriefRaiseMeeting,
} from "../fundraising-raise-actions";

const TENANT = "11111111-1111-1111-1111-111111111111";
const UUID = "99999999-9999-4999-8999-999999999999";

function makeReqRes(body: unknown) {
  const req = { headers: { authorization: "Bearer tok" }, body } as never;
  let jsonPayload: unknown;
  let statusCode = 200;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      jsonPayload = payload;
    },
    get jsonPayload() {
      return jsonPayload;
    },
    get statusCode() {
      return statusCode;
    },
  } as never & { jsonPayload: unknown; statusCode: number };
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({
    tenant_id: TENANT,
    user_id: "u1",
    access_token: "tok",
  });
  mocks.getBool.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ data: null, error: null });
});

describe("raise-phase", () => {
  it("invalid phase => 400, never touches auth/DB", async () => {
    const { req, res } = makeReqRes({ phase: "bogus" });
    await fundraisingSetRaisePhase(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("flag OFF => 404, no RPC", async () => {
    mocks.getBool.mockResolvedValueOnce(false);
    const { req, res } = makeReqRes({ phase: "warmup" });
    await fundraisingSetRaisePhase(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("happy path => RPC gets JWT tenant + phase (body tenant ignored)", async () => {
    const { req, res } = makeReqRes({ phase: "outreach", tenant_id: "attacker" });
    await fundraisingSetRaisePhase(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(200);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("fundraising_set_raise_phase");
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_tenant_id).not.toBe("attacker");
    expect(args.p_phase).toBe("outreach");
  });
});

describe("raise-intro create + mark-sent", () => {
  it("missing target_firm => 400", async () => {
    const { req, res } = makeReqRes({ target_person: "Ada" });
    await fundraisingCreateRaiseIntro(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("create => RPC with JWT tenant + fields, returns new id; draft_text stored only", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "intro-1", error: null });
    const { req, res } = makeReqRes({
      target_firm: "Boldstart",
      target_person: "Ed Sim",
      path: "via Ada",
      draft_text: "Hi Ed, ...",
    });
    await fundraisingCreateRaiseIntro(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(200);
    expect((res as { jsonPayload: { id: string } }).jsonPayload.id).toBe("intro-1");
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("fundraising_create_raise_intro");
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_target_firm).toBe("Boldstart");
    expect(args.p_draft_text).toBe("Hi Ed, ...");
  });

  it("mark-sent => RPC fundraising_mark_intro_sent with JWT tenant + id", async () => {
    const { req, res } = makeReqRes({ id: UUID });
    await fundraisingMarkIntroSent(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(200);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("fundraising_mark_intro_sent");
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_id).toBe(UUID);
  });

  it("mark-sent with a non-uuid id => 400", async () => {
    const { req, res } = makeReqRes({ id: "not-a-uuid" });
    await fundraisingMarkIntroSent(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("raise-meeting create + prep + debrief", () => {
  it("create => RPC with tenant + investor_ref + optional link", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: "meet-1", error: null });
    const { req, res } = makeReqRes({
      investor_ref: "Uncork — Jeff Clavier",
      investor_id: UUID,
      scheduled_for: "2026-07-20T17:00:00Z",
    });
    await fundraisingCreateRaiseMeeting(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(200);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("fundraising_create_raise_meeting");
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_investor_ref).toBe("Uncork — Jeff Clavier");
    expect(args.p_investor_id).toBe(UUID);
  });

  it("create without investor_ref => 400", async () => {
    const { req, res } = makeReqRes({ investor_id: UUID });
    await fundraisingCreateRaiseMeeting(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("prep => RPC fundraising_set_meeting_prep with the prep object", async () => {
    const { req, res } = makeReqRes({
      id: UUID,
      prep: { partner: "Jeff", questions: ["why now"] },
    });
    await fundraisingSetMeetingPrep(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(200);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("fundraising_set_meeting_prep");
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_prep).toEqual({ partner: "Jeff", questions: ["why now"] });
  });

  it("debrief soft_yes => RPC fundraising_debrief_raise_meeting (which bumps the pipeline server-side)", async () => {
    const { req, res } = makeReqRes({
      id: UUID,
      outcome: "soft_yes",
      debrief: { notes: "great fit" },
    });
    await fundraisingDebriefRaiseMeeting(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(200);
    const [fn, args] = mocks.rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("fundraising_debrief_raise_meeting");
    expect(args.p_tenant_id).toBe(TENANT);
    expect(args.p_outcome).toBe("soft_yes");
  });

  it("debrief with an invalid outcome => 400", async () => {
    const { req, res } = makeReqRes({ id: UUID, outcome: "yes" });
    await fundraisingDebriefRaiseMeeting(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("action route with flag OFF => 404, no RPC", async () => {
    mocks.getBool.mockResolvedValueOnce(false);
    const { req, res } = makeReqRes({ id: UUID, outcome: "pass" });
    await fundraisingDebriefRaiseMeeting(req, res as never);
    expect((res as { statusCode: number }).statusCode).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
