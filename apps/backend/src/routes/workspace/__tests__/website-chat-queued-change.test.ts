import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const SITE = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  refineProduct: vi.fn(),
  loadSiteForRun: vi.fn(async (..._a: unknown[]) => null as unknown),
  saveOwnerChatFacts: vi.fn(async () => []),
}));

vi.mock("@/services/company/owner-chat-facts", () => ({ saveOwnerChatFacts: mocks.saveOwnerChatFacts }));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "b92dcbf1-bac9-457a-af81-0bbe5984339b", user_id: "u-1" })),
}));
vi.mock("@/services/auth/tenant-role", async (orig) => ({ ...(await orig<object>()), requireTenantRole: vi.fn(async () => true) }));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: vi.fn(async () => true) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const filters: Record<string, string> = {};
      const q = {
        eq(col: string, v: string) {
          filters[col] = v;
          return q;
        },
        async maybeSingle() {
          const hit = table === "conductor_runs" && filters.tenant_id === TENANT && filters.id === BUILD;
          return { data: hit ? { id: BUILD } : null, error: null };
        },
      };
      return { select: () => q };
    },
  }),
}));
vi.mock("@/services/agents/refine-product", async (orig) => {
  const real = await orig<typeof import("@/services/agents/refine-product")>();
  return {
    ...real,
    refineProduct: mocks.refineProduct,
    realRefineProductDeps: { ...real.realRefineProductDeps, loadSiteForRun: mocks.loadSiteForRun },
  };
});

import { postWebsiteChat, realDrainDeps, websiteChatQueueDeps } from "../website-chat";
import { DoubleBuildInFlight, NoProvisionedRepo, SitePreviewRestarting, UndoInProgress } from "@/services/agents/refine-product";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import { QUEUED_CHANGE_CHAT, REPLACED_CHANGE_CHAT, drainQueuedSiteChange, type QueueOutcome } from "@/services/sites/queued-change";

const queued: Array<{ tenant_id: string; site_id: string; conductor_run_id: string; message: string; user_id: string | null }> = [];
let nextOutcome: QueueOutcome | Error = "queued";
const drained: string[] = [];

async function route(message: string, extra: Record<string, unknown> = {}) {
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  await postWebsiteChat({ body: { message, confirm: true, conductor_run_id: BUILD, ...extra }, headers: {} } as unknown as Request, res);
  return { status, body };
}

beforeEach(() => {
  mocks.refineProduct.mockReset();
  mocks.saveOwnerChatFacts.mockClear();
  mocks.loadSiteForRun.mockReset();
  mocks.loadSiteForRun.mockResolvedValue({ id: SITE, tenant_id: TENANT });
  queued.length = 0;
  drained.length = 0;
  nextOutcome = "queued";
  websiteChatQueueDeps.store = {
    queue: async (input) => {
      if (nextOutcome instanceof Error) throw nextOutcome;
      queued.push(input);
      return nextOutcome;
    },
    claim: async () => null,
    settle: async () => undefined,
    dropStopped: async () => [],
  };
  websiteChatQueueDeps.drain = async (tenant_id) => void drained.push(tenant_id);
});

describe("a site change sent while that site is still building", () => {
  it("is held for this site and the reply says it will run when the build finishes", async () => {
    mocks.refineProduct.mockRejectedValue(new DoubleBuildInFlight(TENANT));
    const { status, body } = await route("Our prices start at $80 for a standard clean <b>now</b>");
    expect(status).toBe(200);
    expect(body).toMatchObject({ route: "app_edit", stage: "queued", chat: QUEUED_CHANGE_CHAT });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ tenant_id: TENANT, site_id: SITE, conductor_run_id: BUILD, user_id: "u-1" });
    expect(queued[0]!.message).toContain("$80");
    expect(queued[0]!.message).not.toContain("<b>");
    expect(drained).toEqual([TENANT]);
  });

  it("the owner's prices are saved as facts when the change is held, with the words they typed", async () => {
    mocks.refineProduct.mockRejectedValue(new DoubleBuildInFlight(BUILD));
    const { status } = await route("Basic clean is $140 & deep clean is $280");
    expect(status).toBe(200);
    expect(mocks.saveOwnerChatFacts).toHaveBeenCalledTimes(1);
    expect((mocks.saveOwnerChatFacts.mock.calls[0] as unknown[])[1]).toBe("Basic clean is $140 & deep clean is $280");
  });

  it("a plain statement of prices that is no site edit is still saved", async () => {
    await route("Basic clean is $140", { confirm: false });
    expect(mocks.saveOwnerChatFacts).toHaveBeenCalledTimes(1);
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("a message with a pasted key is refused and saves nothing", async () => {
    const { status } = await route("Basic clean is $140 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(status).toBe(422);
    expect(mocks.saveOwnerChatFacts).not.toHaveBeenCalled();
  });

  it("a second change replaces the held one and says so", async () => {
    mocks.refineProduct.mockRejectedValue(new DoubleBuildInFlight(TENANT));
    nextOutcome = "replaced";
    const { body } = await route("Add our hours: open 9am to 6pm Monday to Saturday");
    expect(body.chat).toBe(REPLACED_CHANGE_CHAT);
  });

  it("a held change already starting is not overwritten: the old busy answer comes back", async () => {
    mocks.refineProduct.mockRejectedValue(new DoubleBuildInFlight(TENANT));
    nextOutcome = "busy";
    const { status, body } = await route("Add our hours: open 9am to 6pm Monday to Saturday");
    expect(status).toBe(409);
    expect((body.error as { code: string }).code).toBe("build_already_in_progress");
    expect(drained).toEqual([]);
  });

  it("a queue outage never claims the change was saved", async () => {
    mocks.refineProduct.mockRejectedValue(new DoubleBuildInFlight(TENANT));
    nextOutcome = new Error("db down");
    const { status, body } = await route("Add our hours: open 9am to 6pm Monday to Saturday");
    expect(status).toBe(409);
    expect(body.stage).toBeUndefined();
    expect((body.error as { chat: string }).chat).not.toBe(QUEUED_CHANGE_CHAT);
  });

  it("other refusals are never queued: out of credits stays a refusal", async () => {
    mocks.refineProduct.mockRejectedValue(new InsufficientCreditsForBuild(400, 10, false, "change"));
    const { status } = await route("Add our hours: open 9am to 6pm Monday to Saturday");
    expect(status).toBe(402);
    expect(queued).toHaveLength(0);
  });

  it("a first build whose repo is not provisioned yet holds the change instead of saying there is no app", async () => {
    mocks.refineProduct.mockRejectedValue(new NoProvisionedRepo(TENANT));
    const { status, body } = await route("Add our hours: open 9am to 6pm Monday to Saturday");
    expect(status).toBe(200);
    expect(body).toMatchObject({ stage: "queued", chat: QUEUED_CHANGE_CHAT });
    expect(queued).toHaveLength(1);
  });

  it("the old workspace app (no site) is never queued", async () => {
    mocks.loadSiteForRun.mockResolvedValue(null);
    mocks.refineProduct.mockRejectedValue(new DoubleBuildInFlight(TENANT));
    await route("Change the hero background to dark blue and add a pricing section");
    expect(queued).toHaveLength(0);
  });

  it("an unconfirmed turn with the owner's prices is offered as a site change, not sent to the chat", async () => {
    const { status, body } = await route("We charge $80 for a standard clean and $140 for a deep clean", { confirm: false });
    expect(status).toBe(200);
    expect(body.route).toBe("app_edit");
    expect(body.stage).toBe("confirm");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });
});

describe("draining a held change while the site still cannot take it", () => {
  const CLAIMED = { site_id: SITE, conductor_run_id: BUILD, message: "add prices" };
  it.each([
    ["the repo is not provisioned yet", new NoProvisionedRepo(TENANT)],
    ["another build holds the slot", new DoubleBuildInFlight(TENANT)],
    ["the preview is restarting", new SitePreviewRestarting(SITE)],
    ["an undo is running", new UndoInProgress(TENANT)],
  ])("%s: the change goes back in the queue and the owner hears nothing", async (_name, error) => {
    const settle = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const out = await drainQueuedSiteChange(TENANT, {
      ...(await realDrainDeps()),
      store: { queue: vi.fn(), claim: async () => CLAIMED, settle, dropStopped: async () => [] },
      refine: async () => { throw error; },
      notify,
    });
    expect(out).toEqual({ kind: "still_busy", site_id: SITE });
    expect(settle).toHaveBeenCalledWith(TENANT, SITE, true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("a refusal that will not clear itself still drops the change and tells the owner", async () => {
    const settle = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const out = await drainQueuedSiteChange(TENANT, {
      ...(await realDrainDeps()),
      store: { queue: vi.fn(), claim: async () => CLAIMED, settle, dropStopped: async () => [] },
      refine: async () => { throw new Error("boom"); },
      notify,
    });
    expect(out.kind).toBe("failed");
    expect(settle).toHaveBeenCalledWith(TENANT, SITE, false);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
