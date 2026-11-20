import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuth = vi.fn();
const decideOnDecision = vi.fn();
vi.mock("@/services/auth/middleware", () => ({ requireAuth: (...a: unknown[]) => requireAuth(...a) }));
vi.mock("@/services/approvals/decide-service", () => ({ decideOnDecision: (...a: unknown[]) => decideOnDecision(...a) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/staff/capture-admin-correction", () => ({ captureAdminCorrection: vi.fn() }));
vi.mock("@/services/humans/applications", () => ({ settleHumanApplicationDecision: vi.fn(), HUMAN_APPLICATION_REVIEW_CLASS: "human.application_review" }));

const ID = "33333333-3333-4333-8333-333333333333";
const EDIT_REFUSED = { error: { code: "invalid_edit", message: "The edited post could not be applied. Review the post before approving." } };
function res() {
  const out: { status: number; body: unknown } = { status: 200, body: null };
  return { out, json: (b: unknown) => void (out.body = b), status: (s: number) => ((out.status = s), { json: (b: unknown) => void (out.body = b) }) };
}
async function approve(body: Record<string, unknown>) {
  const { approvalsApprove } = await import("../decide");
  const r = res();
  await approvalsApprove({ params: { decision_id: ID }, query: {}, body } as never, r as never);
  return r.out;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ tenant_id: "t-1", user_id: "u-1", access_token: "x" });
  decideOnDecision.mockResolvedValue({ ok: true, code: "ok", changed: true, status: "approved", decision_id: ID, decision_class: "social.publish.v2", allowlisted: false });
});

describe("approve with an invalid edit", () => {
  it("an empty thread part answers 400 invalid_edit and approves nothing", async () => {
    const out = await approve({ payload_text: "Caption", thread: [""] });
    expect(out).toEqual({ status: 400, body: EDIT_REFUSED });
    expect(decideOnDecision).not.toHaveBeenCalled();
  });

  it("an empty caption answers 400 invalid_edit and approves nothing", async () => {
    const out = await approve({ payload_text: "" });
    expect(out).toEqual({ status: 400, body: EDIT_REFUSED });
    expect(decideOnDecision).not.toHaveBeenCalled();
  });

  it("a bad image keeps the image message", async () => {
    const out = await approve({ payload_text: "Caption", image_path: "x".repeat(251) });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ error: { code: "invalid_edit", message: "The selected image could not be applied. Review the post before approving." } });
    expect(decideOnDecision).not.toHaveBeenCalled();
  });

  it("a pin's edited title, board and link reach the service, and only the fields sent", async () => {
    await approve({ title: "New title", board_id: "333", link: "https://acme.com/p" });
    expect(decideOnDecision).toHaveBeenLastCalledWith(expect.objectContaining({ payload_edit: { text: undefined, thread: undefined, image_path: undefined, title: "New title", board_id: "333", link: "https://acme.com/p" }, confirm_unverified: false }));
    await approve({ board_id: "333" });
    expect(decideOnDecision.mock.lastCall?.[0].payload_edit).toEqual({ text: undefined, thread: undefined, image_path: undefined, board_id: "333" });
  });

  it("an edit field of the wrong type is refused, not dropped into a plain approve", async () => {
    const out = await approve({ title: 42 });
    expect(out).toEqual({ status: 400, body: EDIT_REFUSED });
    expect(decideOnDecision).not.toHaveBeenCalled();
  });

  it("an unconfirmed approve of a pin with unverified checks answers 409 with the reasons", async () => {
    decideOnDecision.mockResolvedValue({ ok: false, code: "requires_unverified_confirm", changed: false, status: "proposed", decision_id: ID, decision_class: "social.publish.v2", allowlisted: false, unverified: ["Link: Could not open it."], detail: "Zavi could not check everything on this pin. Link: Could not open it." });
    const out = await approve({});
    expect(out).toEqual({ status: 409, body: { error: { code: "requires_unverified_confirm", message: "Zavi could not check everything on this pin. Link: Could not open it.", unverified: ["Link: Could not open it."] } } });
  });

  it("confirm_unverified is passed through only when true", async () => {
    await approve({ confirm_unverified: true });
    expect(decideOnDecision).toHaveBeenLastCalledWith(expect.objectContaining({ confirm_unverified: true }));
    await approve({ confirm_unverified: "yes" });
    expect(decideOnDecision).toHaveBeenLastCalledWith(expect.objectContaining({ confirm_unverified: false }));
  });

  it("a valid edit reaches the service", async () => {
    const out = await approve({ payload_text: "New caption", thread: ["Part two"] });
    expect(out).toEqual({ status: 200, body: { ok: true, decision_id: ID, allowlisted: false } });
    expect(decideOnDecision).toHaveBeenCalledWith(expect.objectContaining({ payload_edit: { text: "New caption", thread: ["Part two"], image_path: undefined } }));
  });
});
