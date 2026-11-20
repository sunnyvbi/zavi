import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantClient: () => ({}) }));
vi.mock("@/services/agents/run-owner", () => ({ resolveChatTurnChain: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
vi.mock("@/services/agents/thread-event", () => ({ emitThreadEvent: vi.fn() }));

import { attachCardToChat, attachedCardBody, type AttachDeps, type Card, type ChatCardTarget } from "../chat-card-attach";

const NOW_CHAT: ChatCardTarget = { thread_id: "th-new", run_id: "run-new", agent_slug: "cgo" };
const OCT20_CHAT: ChatCardTarget = { thread_id: "th-oct20", run_id: "run-oct20", agent_slug: "cgo" };
const pause: Card = {
  table: "decisions",
  id: "2bdc4968-0000-4000-8000-000000000001",
  decision_class: "meta_ads.set_status_review",
  waiting: true,
  approved_by_source: null,
  title: "Pause “Regular Leads”",
  where: "under What needs you on the Your CGO page",
  channel_slug: null,
  growth_page_only: false,
  filed_at: "2026-10-20T18:00:00Z",
  run_id: "run-oct20",
  move_key: "run-oct20",
};

const targetOf = (byRun: Record<string, ChatCardTarget | null>) => vi.fn(async (_t: string, run: string) => byRun[run] ?? null);
function deps(over: Record<string, unknown> = {}) {
  const d = {
    target: targetOf({ "resume-new": NOW_CHAT, "run-oct20": OCT20_CHAT }),
    read: vi.fn(async () => pause),
    shown: vi.fn(async () => null as { id: string; full: boolean; body?: Record<string, unknown> } | null),
    emit: vi.fn(async (_event: { body: Record<string, unknown> }) => undefined),
    rewrite: vi.fn(async () => undefined),
    ...over,
  };
  return d as unknown as typeof d & AttachDeps;
}

describe("attachedCardBody origin", () => {
  it("carries filed_at and from_other_chat with an origin, and neither without", () => {
    const withIt = attachedCardBody(pause, { filed_at: "2026-10-20T18:00:00.000Z", from_other_chat: true });
    expect(withIt).toMatchObject({ filed_at: "2026-10-20T18:00:00.000Z", from_other_chat: true });
    const without = attachedCardBody(pause);
    expect(without).not.toHaveProperty("filed_at");
    expect(without).not.toHaveProperty("from_other_chat");
  });
});

describe("attachCardToChat records where a card came from", () => {
  it("must-catch (Oct 20 pauses in a new chat): a card filed in another chat is shown with its origin and its move_key", async () => {
    const d = deps();
    const r = await attachCardToChat({ tenant_id: "t1", run_id: "resume-new", card_id: pause.id }, d);
    expect(r).toMatchObject({ shown: true, move_key: "run-oct20" });
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ from_other_chat: true, filed_at: "2026-10-20T18:00:00.000Z" }) }));
  });

  it("a card filed in this same chat, or by a run that is not a chat, carries no origin", async () => {
    const same = deps({ target: targetOf({ "resume-new": NOW_CHAT, "run-oct20": { ...NOW_CHAT, run_id: "run-earlier-turn" } }) });
    await attachCardToChat({ tenant_id: "t1", run_id: "resume-new", card_id: pause.id }, same);
    expect(same.emit.mock.calls[0]![0]).toMatchObject({ body: expect.not.objectContaining({ from_other_chat: true }) });
    const review = deps({ target: targetOf({ "resume-new": NOW_CHAT }) });
    await attachCardToChat({ tenant_id: "t1", run_id: "resume-new", card_id: pause.id }, review);
    expect(review.emit.mock.calls[0]![0]).toMatchObject({ body: expect.not.objectContaining({ from_other_chat: true }) });
  });

  it("a failed origin read never fails the show: the card is shown without a label", async () => {
    const target = vi.fn(async (_t: string, run: string) => {
      if (run === "resume-new") return NOW_CHAT;
      throw new Error("read failed");
    });
    const d = deps({ target });
    expect(await attachCardToChat({ tenant_id: "t1", run_id: "resume-new", card_id: pause.id }, d)).toMatchObject({ shown: true });
    expect(d.emit.mock.calls[0]![0]).toMatchObject({ body: expect.not.objectContaining({ from_other_chat: true }) });
  });

  it("a card moved down to this reply keeps its own body and gains where it came from", async () => {
    const shownBody = { decision_id: pause.id, decision_class: pause.decision_class, title: pause.title, full_card: true, summary: "Kept" };
    const d = deps({ shown: vi.fn(async () => ({ id: "te-1", full: true, body: shownBody })) });
    await attachCardToChat({ tenant_id: "t1", run_id: "resume-new", card_id: pause.id, bringToLatest: true }, d);
    expect(d.rewrite).toHaveBeenCalledWith("t1", "te-1", { body: { ...shownBody, filed_at: "2026-10-20T18:00:00.000Z", from_other_chat: true }, toTarget: NOW_CHAT });
  });
});
