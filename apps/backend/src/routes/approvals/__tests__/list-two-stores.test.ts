
import { describe, it, expect, vi, beforeEach } from "vitest";

const requireAuth = vi.fn();

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: (...a: unknown[]) => requireAuth(...a),
}));

let tables: Record<string, { data: unknown; error: unknown }> = {};

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => makeSb(),
}));

function makeSb() {
  const node = (table: string): Record<string, unknown> => {
    const result = tables[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self,
      eq: self,
      in: self,
      is: self,
      not: self,
      or: self,
      gte: self,
      lte: self,
      order: self,
      limit: self,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    });
    return chain;
  };
  return { from: (table: string) => node(table) };
}

const TENANT = "11111111-1111-1111-1111-111111111111";

function res() {
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  return {
    out,
    json: (b: Record<string, unknown>) => {
      out.body = b;
    },
    status: (s: number) => {
      out.status = s;
      return { json: (b: Record<string, unknown>) => (out.body = b) };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ tenant_id: TENANT, access_token: "t", user_id: "u" });
  tables = {
    customer_visible_pending_decisions: {
      data: [
        {
          id: "d-1",
          agent_run_id: "run-legacy",
          decision_class: "meta_ads.budget",
          body: {},
          status: "proposed",
          autonomy_at_emit: "approval",
          handler: null,
          emitted_at: "2026-09-19T10:00:00Z",
        },
      ],
      error: null,
    },
    customer_visible_open_channel_actions: {
      data: [
        {
          id: "a-1",
          channel_slug: "reddit_organic",
          run_id: "run-switched",
          position: 2,
          run_of: 5,
          body: { step: { title: "Reply in r/startups" } },
          status: "pending",
          proposed_at: "2026-09-19T11:00:00Z",
          exec_class: null,
        },
      ],
      error: null,
    },
    decision_classes: { data: [], error: null },
    agent_runs: {
      data: [
        { id: "run-legacy", agent_slug: "performance-marketer", payload: {}, channel_slug: "meta_ads" },
        { id: "run-switched", agent_slug: "social", payload: { thread_id: "th-9" }, channel_slug: "reddit_organic" },
      ],
      error: null,
    },
  };
});

async function call(query: Record<string, unknown> = {}) {
  const { approvalsList } = await import("../list");
  const r = res();
  await approvalsList({ query } as never, r as never);
  return r.out.body as {
    decisions: Array<Record<string, unknown>>;
    channel_pending_counts?: Record<string, number>;
  };
}

describe("GET /api/approvals counts both action stores", () => {
  it("counts a switched channel's open actions in channel_pending_counts", async () => {
    const body = await call();
    expect(body.channel_pending_counts?.reddit_organic).toBe(1);
    expect(body.channel_pending_counts?.meta_ads).toBe(1);
  });

  it("still counts when the second store read fails", async () => {
    tables.customer_visible_open_channel_actions = { data: null, error: { message: "boom" } };
    const body = await call();
    expect(body.decisions.map((d) => d.id)).toEqual(["d-1"]);
    expect(body.channel_pending_counts?.reddit_organic).toBeUndefined();
  });
});

describe("the GLOBAL list returns decisions only", () => {
  it("keeps channel actions out of the unfiltered decisions array", async () => {
    const body = await call();
    expect(body.decisions.map((d) => d.id)).toEqual(["d-1"]);
  });

  it("keeps them out of the un-enriched shape too", async () => {
    const body = await call({ include: "none" });
    expect(body.decisions.map((d) => d.id)).toEqual(["d-1"]);
  });
});

describe("the channel-scoped list returns both stores", () => {
  beforeEach(() => {
    tables.agent_runs = {
      data: [{ id: "run-switched", agent_slug: "social", payload: { thread_id: "th-9" }, channel_slug: "reddit_organic" }],
      error: null,
    };
    tables.customer_visible_pending_decisions = { data: [], error: null };
  });

  it("returns the channel's open action, stamped with the store its id came from", async () => {
    const body = await call({ channel: "reddit_organic" });
    const a = body.decisions.find((d) => d.id === "a-1") as Record<string, unknown>;
    expect(a).toBeDefined();
    expect(a.action_source).toBe("channel_action");
  });

  it("gives it the run slot and run meta the panel folds on", async () => {
    const body = await call({ channel: "reddit_organic" });
    const a = body.decisions.find((d) => d.id === "a-1") as Record<string, unknown>;
    expect(a.run_group).toEqual({ run_id: "run-switched", position: 2, of: 5 });
    expect(a.channel_slug).toBe("reddit_organic");
    expect(a.agent_slug).toBe("social");
    expect(a.thread_id).toBe("th-9");
    expect(a.decision_class).toBe("channel.recipe_step");
  });

  it("refuses a terminal ?status= view of one channel, so no second-store row can reach it", async () => {
    const { approvalsList } = await import("../list");
    const r = res();
    await approvalsList({ query: { channel: "reddit_organic", status: "dispatch_failed" } } as never, r as never);
    expect(r.out.status).toBe(400);
    expect(JSON.stringify(r.out.body)).not.toContain("a-1");
  });
});

describe("an executable action says so", () => {
  beforeEach(() => {
    tables.agent_runs = {
      data: [{ id: "run-ads", agent_slug: "performance-marketer", payload: {}, channel_slug: "google_ads" }],
      error: null,
    };
    tables.customer_visible_pending_decisions = { data: [], error: null };
    tables.customer_visible_open_channel_actions = {
      data: [
        {
          id: "a-exec",
          channel_slug: "google_ads",
          run_id: "run-ads",
          position: 900,
          run_of: 900,
          body: { step: { title: "Pause the three keywords that spent with no conversions" } },
          status: "pending",
          proposed_at: "2026-09-19T11:00:00Z",
          exec_class: "google_ads.set_status",
        },
      ],
      error: null,
    };
  });

  it("carries exec_class, so approving it can be routed to the call that executes", async () => {
    const body = await call({ channel: "google_ads" });
    const a = body.decisions.find((d) => d.id === "a-exec") as Record<string, unknown>;
    expect(a.exec_class).toBe("google_ads.set_status");
  });

  it("leaves exec_class null on an action the founder does themselves", async () => {
    tables.customer_visible_open_channel_actions = {
      data: [
        {
          id: "a-note",
          channel_slug: "google_ads",
          run_id: "run-ads",
          position: 1,
          run_of: 3,
          body: {},
          status: "pending",
          proposed_at: "2026-09-19T11:00:00Z",
          exec_class: null,
        },
      ],
      error: null,
    };
    const body = await call({ channel: "google_ads" });
    const a = body.decisions.find((d) => d.id === "a-note") as Record<string, unknown>;
    expect(a.exec_class).toBeNull();
  });
});

describe("GET /api/approvals marks cards whose run was stopped", () => {
  it("a stopped run's card says so; a running run's card does not", async () => {
    tables.agent_runs = {
      data: [
        { id: "run-legacy", agent_slug: "performance-marketer", payload: {}, channel_slug: "meta_ads", stop_requested: true },
        { id: "run-switched", agent_slug: "social", payload: { thread_id: "th-9" }, channel_slug: "reddit_organic", stop_requested: false },
      ],
      error: null,
    };
    const body = await call({ channel: "reddit_organic" });
    const action = body.decisions.find((d) => d.id === "a-1") as Record<string, unknown>;
    expect(action.run_stopped).toBe(false);
    const all = await call();
    const stopped = all.decisions.find((d) => d.agent_run_id === "run-legacy") as Record<string, unknown>;
    expect(stopped?.run_stopped).toBe(true);
  });
});

describe("social draft revision on the approvals list", () => {
  it.each([undefined, "none"])("returns a revision of the displayed saved body with include=%s", async (include) => {
    const { socialDraftVersion } = await import("@/services/approvals/social-draft-version");
    const body = { channel: "linkedin_image", payload: { text: "Saved caption", image_path: "saved.png" }, post_draft: { text: "Saved caption", thread: null } };
    const decision = { id: "social-draft", agent_run_id: null, decision_class: "social.publish.v2", body, status: "proposed", handler: "social_post_create" };
    tables.customer_visible_pending_decisions = { data: [decision], error: null };
    const first = await call(include ? { include } : {});
    expect(first.decisions[0]).toMatchObject({ id: "social-draft", body, post_revision: socialDraftVersion(body) });
    const next = { ...body, payload: { ...body.payload, image_path: "new-photo.png" } };
    tables.customer_visible_pending_decisions = { data: [{ ...decision, body: next }], error: null };
    const refreshed = await call(include ? { include } : {});
    expect(refreshed.decisions[0].post_revision).toBe(socialDraftVersion(next));
    expect(refreshed.decisions[0].post_revision).not.toBe(first.decisions[0].post_revision);
  });
});

it("counts a LinkedIn approval/card pair once while retaining both actionable source rows", async () => {
  tables.customer_visible_pending_decisions = {data:[{id:"staged",agent_run_id:"run-li",decision_class:"social.publish.v2",body:{channel:"linkedin",payload:{text:"Finished post."}},social_channel:"linkedin",social_text:"Finished post.",status:"proposed",emitted_at:"2026-11-01T00:00:00Z"}],error:null};
  tables.customer_visible_open_channel_actions = {data:[{id:"card",channel_slug:"linkedin_organic",run_id:"run-li",action_type:"text_post",content:"Finished post.",body:{step:{title:"Post the story",deliverable:{kind:"post",content:"Finished post."}}},status:"pending",proposed_at:"2026-11-01T00:00:00Z",exec_class:null}],error:null};
  tables.agent_runs = {data:[{id:"run-li",agent_slug:"linkedin_organic",payload:{},channel_slug:"linkedin_organic"}],error:null};
  const global = await call(); expect(global.channel_pending_counts?.linkedin_organic).toBe(1);expect(global.decisions.map(d=>d.id)).toEqual(["staged"]);
  const scoped = await call({channel:"linkedin_organic"});expect(scoped.channel_pending_counts?.linkedin_organic).toBe(1);expect(scoped.decisions.map(d=>d.id)).toEqual(["staged", "card"]);
});
