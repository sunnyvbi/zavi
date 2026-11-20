
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  queue: [] as Array<{ id: string; email: string; created_at?: string }>,
  sent: true as boolean | "throw",
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/web-base", () => ({ webBaseUrl: () => "https://www.example.test", workspaceUrl: () => "https://www.example.test/workspace" }));
vi.mock("@/email/sendAuthEmail", () => ({
  sendStartCardReadyEmail: vi.fn(async () => {
    if (H.sent === "throw") throw new Error("sendgrid 500");
    return { sent: H.sent };
  }),
}));
vi.mock("../budget", () => ({
  releaseCardBudget: vi.fn(async () => undefined),
  settleCardBudget: vi.fn(async () => undefined),
}));
vi.mock("../store", () => ({
  getCardById: vi.fn(async () => H.row),
  updateCard: vi.fn(async () => undefined),
  setCardPart: vi.fn(async () => undefined),
  listQueueRowsForCard: vi.fn(async () => H.queue),
  deleteQueueRow: vi.fn(async () => undefined),
  detachQueueRow: vi.fn(async () => undefined),
}));

import { cancelCard, executeStage, failCard, finishCard, runAndWriteStage, sendQueuedCardEmails } from "../pipeline";
import { StageUnavailableError, type StageContext } from "../stages";
import { releaseCardBudget, settleCardBudget } from "../budget";
import { deleteQueueRow, detachQueueRow, setCardPart, updateCard } from "../store";
import { sendStartCardReadyEmail } from "@/email/sendAuthEmail";

const ctx: StageContext = { card_id: "card-1", domain: "acme.com", url: "https://acme.com/", profile: null, parts: {} };

beforeEach(() => {
  vi.clearAllMocks();
  H.row = { id: "card-1", public_id: "PUBLICID00000001", domain: "acme.com", status: "done", revoked_at: null, budget_day: "2026-10-01", reserved_usd: "1.0000" };
  H.queue = [];
  H.sent = true;
});

describe("executeStage", () => {
  it("a done stage becomes a done part with its points and cost", async () => {
    const r = await executeStage("google", async () => ({ evidence: { a: 1 }, points: 15, max_points: 20, cost_usd: 0.05 }), ctx);
    expect(r.part).toMatchObject({ state: "done", evidence: { a: 1 }, points: 15, max_points: 20 });
    expect(r.cost_usd).toBe(0.05);
  });

  it("StageUnavailableError becomes unavailable with its reason and the cost spent so far", async () => {
    const r = await executeStage("ai", async () => {
      throw new StageUnavailableError("vendor_not_configured", 0.02);
    }, ctx);
    expect(r.part).toMatchObject({ state: "unavailable", evidence: null, unavailable_reason: "vendor_not_configured" });
    expect(r.part.points).toBeUndefined();
    expect(r.cost_usd).toBe(0.02);
  });

  it("any other throw is unavailable 'stage_error', never a failed card", async () => {
    const r = await executeStage("seo", async () => {
      throw new Error("boom");
    }, ctx);
    expect(r.part).toMatchObject({ state: "unavailable", unavailable_reason: "stage_error" });
  });

  it("runAndWriteStage persists the part through the atomic part write", async () => {
    await runAndWriteStage("design", async () => ({ evidence: {}, points: 4, cost_usd: 0 }), ctx);
    expect(setCardPart).toHaveBeenCalledWith("card-1", "design", expect.objectContaining({ state: "done", points: 4 }));
  });
});

describe("finish / fail", () => {
  it("finishCard marks a running card done and settles the reservation to actual spend", async () => {
    H.row = { ...H.row!, status: "running" };
    await finishCard("card-1", 0.6712345);
    expect(updateCard).toHaveBeenCalledWith("card-1", { status: "done", spent_usd: 0.6712 });
    expect(settleCardBudget).toHaveBeenCalledWith("2026-10-01", 1, 0.6712);
  });

  it("a retried finish on a card already done never settles twice", async () => {
    await finishCard("card-1", 0.5);
    expect(updateCard).not.toHaveBeenCalled();
    expect(settleCardBudget).not.toHaveBeenCalled();
  });

  it("failCard (worker died) fails a running card and KEEPS the reservation as spent", async () => {
    H.row = { ...H.row!, status: "running" };
    await failCard("card-1", "worker_failed");
    expect(updateCard).toHaveBeenCalledWith("card-1", { status: "failed", error: "worker_failed", spent_usd: 1 });
    expect(releaseCardBudget).not.toHaveBeenCalled();
  });

  it("cancelCard (nothing spent) fails a running card and releases the whole reservation", async () => {
    H.row = { ...H.row!, status: "running" };
    await cancelCard("card-1", "disabled");
    expect(updateCard).toHaveBeenCalledWith("card-1", { status: "failed", error: "disabled" });
    expect(releaseCardBudget).toHaveBeenCalledWith("2026-10-01", 1);
  });

  it("cancelCard after a stage already wrote a part keeps the reservation as spent", async () => {
    H.row = { ...H.row!, status: "running", parts: { profile: { state: "done", evidence: {}, fetched_at: "t" } } };
    await cancelCard("card-1", "disabled");
    expect(updateCard).toHaveBeenCalledWith("card-1", { status: "failed", error: "disabled", spent_usd: 1 });
    expect(releaseCardBudget).not.toHaveBeenCalled();
  });

  it("cancelCard does nothing to a card that already finished (no double release)", async () => {
    await cancelCard("card-1", "disabled");
    expect(releaseCardBudget).not.toHaveBeenCalled();
  });
});

describe("sendQueuedCardEmails", () => {
  it("links the growth strategy, names the company, and deletes the row (email + domain)", async () => {
    H.row = { ...H.row!, parts: { profile: { state: "done", evidence: { company_name: "Acme Co" }, fetched_at: "t" } } };
    H.queue = [{ id: "q1", email: "a@x.test" }];
    expect(await sendQueuedCardEmails("card-1")).toEqual({ sent: 1, failed: 0 });
    const args = vi.mocked(sendStartCardReadyEmail).mock.calls[0][0];
    expect(args.strategyUrl).toBe("https://www.example.test/workspace?tab=growth-strategy");
    expect(args.card?.companyName).toBe("Acme Co");
    expect(deleteQueueRow).toHaveBeenCalledWith("q1");
  });

  it("never emails for a card that is not done", async () => {
    H.row = { ...H.row!, status: "running" };
    H.queue = [{ id: "q1", email: "a@x.test" }];
    expect(await sendQueuedCardEmails("card-1")).toEqual({ sent: 0, failed: 0 });
    expect(sendStartCardReadyEmail).not.toHaveBeenCalled();
  });

  it("no SendGrid key: logged no-op, row kept for the purge, nothing thrown", async () => {
    H.sent = false;
    H.queue = [{ id: "q1", email: "a@x.test" }];
    expect(await sendQueuedCardEmails("card-1")).toEqual({ sent: 0, failed: 1 });
    expect(deleteQueueRow).not.toHaveBeenCalled();
  });

  it("a failed card hands a founder's row back to the drain once, and drops a row the drain already retried", async () => {
    H.row = { ...H.row!, status: "failed", created_at: "2026-10-01T10:00:00Z" };
    H.queue = [
      { id: "signed-up-later", email: "a@x.test", created_at: "2026-10-01T10:01:00Z" },
      { id: "drain-made-it", email: "b@x.test", created_at: "2026-10-01T09:59:00Z" },
    ];
    expect(await sendQueuedCardEmails("card-1")).toEqual({ sent: 0, failed: 0 });
    expect(detachQueueRow).toHaveBeenCalledWith("signed-up-later");
    expect(deleteQueueRow).toHaveBeenCalledWith("drain-made-it");
    expect(sendStartCardReadyEmail).not.toHaveBeenCalled();
  });

  it("a removed card drops its rows and sends nothing", async () => {
    H.row = { ...H.row!, revoked_at: "2026-10-01T11:00:00Z", created_at: "2026-10-01T10:00:00Z" };
    H.queue = [{ id: "q1", email: "a@x.test", created_at: "2026-10-01T10:01:00Z" }];
    expect(await sendQueuedCardEmails("card-1")).toEqual({ sent: 0, failed: 0 });
    expect(deleteQueueRow).toHaveBeenCalledWith("q1");
    expect(detachQueueRow).not.toHaveBeenCalled();
    expect(sendStartCardReadyEmail).not.toHaveBeenCalled();
  });

  it("a SendGrid error on one row does not stop the others", async () => {
    H.queue = [{ id: "q1", email: "a@x.test" }, { id: "q2", email: "b@x.test" }];
    vi.mocked(sendStartCardReadyEmail).mockRejectedValueOnce(new Error("500"));
    expect(await sendQueuedCardEmails("card-1")).toEqual({ sent: 1, failed: 1 });
    expect(deleteQueueRow).toHaveBeenCalledWith("q2");
  });
});
