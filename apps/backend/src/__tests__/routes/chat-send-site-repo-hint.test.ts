import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const t1 = "00000000-0000-0000-0000-000000000001";
const u1 = "10000000-0000-0000-0000-000000000001";

type TenantCommandRow = { slug: string; instructions_md: string };
type SendTurnResult = { thread_id: string; user_message_id: string; run_id: string };

const {
  authState,
  bearerState,
  serviceState,
  defState,
  inngestState,
  siteState,
} = vi.hoisted(() => {
  const T1 = "00000000-0000-0000-0000-000000000001";
  const U1 = "10000000-0000-0000-0000-000000000001";
  return {
    authState: {
      value: { user_id: U1, tenant_id: T1, access_token: "fake-jwt" } as
        | { user_id: string; tenant_id: string; access_token: string }
        | null,
    },
    bearerState: {
      commandRow: null as TenantCommandRow | null,
      commandError: null as { code?: string; message: string } | null,
      rpcReturn: {
        data: [
          {
            thread_id: "11111111-1111-4111-8111-111111111111",
            user_message_id: "22222222-2222-2222-2222-222222222222",
            run_id: "33333333-3333-3333-3333-333333333333",
          },
        ] as SendTurnResult[],
        error: null as { message: string } | null,
      },
      rpcCalls: [] as Array<{ name: string; args: unknown }>,
    },
    serviceState: {
      lastUpdatePayload: null as Record<string, unknown> | null,
      statusUpdates: [] as Array<{ table: string; status: unknown }>,
      runPayload: null as Record<string, unknown> | null,
      priorAssistant: null as
        | { meta: Record<string, unknown>; agent_run_id: string | null; id: string }
        | null,
      thread: { user_id: U1, agent_slug: "engineer" } as
        | { user_id: string; agent_slug: string; repo_full_name?: string }
        | null,
      connectorMeta: null as Record<string, unknown> | null,
    },
    defState: {
      def: {
        slug: "engineer",
        content_hash: "abc123",
        metadata_praxis: { requires_sandbox: true },
      } as {
        slug: string;
        content_hash: string;
        metadata_praxis: { requires_sandbox: boolean };
      } | null,
    },
    inngestState: { sentEvents: [] as unknown[] },
    siteState: {
      sites: [] as Array<{ id: string; tenant_id: string; github_full_name: string; status: string }>,
      keepsOwnRepo: true,
    },
  };
});

vi.mock("@/services/connectors/github/scoped-repos", () => ({
  getScopedRepoFullNames: vi.fn(async () => (serviceState.connectorMeta?.repo_full_names as string[]) ?? []),
  resolveScopedRepos: vi.fn(async () => ({ mode: "all", repos: (serviceState.connectorMeta?.repo_full_names as string[]) ?? [] })),
}));

vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    getByRepo: async (tenant_id: string, name: string) =>
      siteState.sites.find((s) => s.tenant_id === tenant_id && s.github_full_name === name) ?? null,
  }),
}));

vi.mock("@/services/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/settings")>();
  return {
    ...actual,
    getBoolSetting: vi.fn(async (key: string, ...rest: unknown[]) =>
      key === "build_site_keeps_own_repo" ? siteState.keepsOwnRepo : (actual.getBoolSetting as (...a: unknown[]) => Promise<boolean>)(key, ...rest),
    ),
  };
});

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async (_req: Request, res: Response) => {
    if (!authState.value) {
      res.status(401).json({ error: { code: "unauthenticated" } });
    }
    return authState.value;
  }),
}));

function bearerClientStub(): unknown {
  return {
    from(_table: string) {
      let _filter = "";
      const builder = {
        select(_cols: string) {
          return builder;
        },
        eq(_col: string, _val: unknown) {
          return builder;
        },
        async maybeSingle() {
          return { data: bearerState.commandRow, error: bearerState.commandError };
        },
      };
      return builder;
    },
    rpc(name: string, args: unknown) {
      bearerState.rpcCalls.push({ name, args });
      if (name === "send_agent_chat_turn") {
        return Promise.resolve(bearerState.rpcReturn);
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function serviceClientStub(): unknown {
  return {
    from(table: string) {
      const builder = {
        select(_cols: string) {
          const inner = {
            eq(_col: string, _val: unknown) {
              return inner;
            },
            order(_col: string, _opts: unknown) {
              return inner;
            },
            limit(_n: number) {
              return inner;
            },
            filter(_col: string, _op: string, _val: unknown) {
              return inner;
            },
            in(_col: string, _vals: unknown[]) {
              return inner;
            },
            neq(_col: string, _val: unknown) {
              return inner;
            },
            is(_col: string, _val: unknown) {
              return inner;
            },
            then(
              resolve: (v: { data: unknown[]; error: null; count: number }) => void,
            ) {
              resolve({ data: [], error: null, count: 0 });
            },
            async maybeSingle() {
              if (table === "agent_thread_messages") {
                return { data: serviceState.priorAssistant, error: null };
              }
              if (table === "agent_threads") {
                return { data: serviceState.thread, error: null };
              }
              if (table === "agent_runs") {
                return { data: serviceState.runPayload ? { payload: serviceState.runPayload } : null, error: null };
              }
              if (table === "connector_metadata") {
                return { data: serviceState.connectorMeta, error: null };
              }
              if (table === "conductor_runs") {
                return { data: { id: "owned-build" }, error: null };
              }
              return { data: null, error: null };
            },
          };
          return inner;
        },
        update(patch: Record<string, unknown>) {
          const inner = {
            eq(_col: string, _val: unknown) {
              return inner;
            },
            then(resolve: (v: { error: null }) => void) {
              if (patch && typeof patch === "object" && "status" in patch) {
                serviceState.statusUpdates.push({ table, status: patch.status });
              }
              if (patch && typeof patch === "object" && "payload" in patch) {
                serviceState.lastUpdatePayload =
                  patch.payload as Record<string, unknown>;
              }
              resolve({ error: null });
            },
          };
          return inner;
        },
        insert(_row: unknown) {
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  };
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => bearerClientStub(),
  serviceClient: () => serviceClientStub(),
}));

vi.mock("@/services/agents/registry", () => ({
  loadAgentDefinition: vi.fn(async () => defState.def),
}));

vi.mock("@/services/agents/ensure-runnable", () => ({
  ensureAgentRunnable: vi.fn(async () => ({
    runnable: true,
    agent: { slug: "engineer", content_hash: "deadbeef" },
  })),
}));

vi.mock("@/services/sandbox/repo-picker", () => ({
  parseRepoPickReply: vi.fn(() => null),
}));

vi.mock("@/services/auth/members", () => ({
  canUserAccessAgent: vi.fn(async () => true),
}));

vi.mock("@/../workers/client", () => ({
  inngest: {
    send: vi.fn((evt: unknown) => {
      inngestState.sentEvents.push(evt);
      return Promise.resolve();
    }),
  },
}));

import { agentChatSend } from "@/routes/agents/chat-send";

function mockRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res as Response;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res as Response;
  };
  return res as Response & { statusCode?: number; body?: unknown };
}

const OLDER = "Praxis-build/paws-and-suds-1a2b3c4d-aaaaaa";
const NEWER = "Praxis-build/still-water-yoga-1a2b3c4d-bbbbbb";
const FOREIGN = "Praxis-build/other-2b3c4d5e-cccccc";
const T2 = "00000000-0000-0000-0000-000000000002";

beforeEach(() => {
  authState.value = { user_id: u1, tenant_id: t1, access_token: "fake-jwt" };
  bearerState.commandRow = null;
  bearerState.commandError = null;
  bearerState.rpcCalls = [];
  serviceState.lastUpdatePayload = null;
  serviceState.statusUpdates = [];
  serviceState.runPayload = null;
  serviceState.priorAssistant = null;
  serviceState.thread = { user_id: u1, agent_slug: "engineer" };
  serviceState.connectorMeta = {
    account_login: "Praxis-build",
    installation_id: null,
    repo_full_names: [NEWER],
    default_repo_full_name: NEWER,
  };
  defState.def = { slug: "engineer", content_hash: "abc123", metadata_praxis: { requires_sandbox: true } };
  inngestState.sentEvents = [];
  siteState.keepsOwnRepo = true;
  siteState.sites = [
    { id: "site-old", tenant_id: t1, github_full_name: OLDER, status: "live" },
    { id: "site-new", tenant_id: t1, github_full_name: NEWER, status: "live" },
    { id: "site-foreign", tenant_id: T2, github_full_name: FOREIGN, status: "live" },
  ];
});

async function send(body: Record<string, unknown>) {
  const req = { params: { slug: "engineer" }, body: { message: "make the header blue", ...body } } as unknown as Request;
  const res = mockRes();
  await agentChatSend(req, res);
  return res;
}

describe("DEL-1323 B6: chat-send honours a repo_hint for one of the workspace's own sites", () => {
  it("an older site's repo (not the workspace default) is accepted and the run carries that site's id", async () => {
    const res = await send({ repo_hint: OLDER });
    expect(res.statusCode ?? 200).toBeLessThan(300);
    expect(serviceState.lastUpdatePayload).toMatchObject({ repo_hint: OLDER, site_id: "site-old" });
  });

  it("the workspace default site repo also carries its site id", async () => {
    await send({ repo_hint: NEWER });
    expect(serviceState.lastUpdatePayload).toMatchObject({ repo_hint: NEWER, site_id: "site-new" });
  });

  it("another workspace's site repo is rejected and the run is cancelled", async () => {
    const res = await send({ repo_hint: FOREIGN });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("repo_hint_not_connected");
    expect(serviceState.lastUpdatePayload).toBeNull();
  });

  it("a deleted site's repo is rejected", async () => {
    siteState.sites[0] = { ...siteState.sites[0], status: "deleted" };
    const res = await send({ repo_hint: OLDER });
    expect(res.statusCode).toBe(400);
  });

  it("no hint: nothing is stamped (Home with several sites attaches no repo)", async () => {
    await send({});
    expect(serviceState.lastUpdatePayload).not.toHaveProperty("repo_hint");
    expect(serviceState.lastUpdatePayload).not.toHaveProperty("site_id");
  });

  it("with build_site_keeps_own_repo off, an older site's repo is rejected as before", async () => {
    siteState.keepsOwnRepo = false;
    const res = await send({ repo_hint: OLDER });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("repo_hint_not_connected");
  });
});

describe("DEL-1323 B6/B26: the build_session_id a Build chat sends wins over a repo_hint naming another site", () => {
  const OLD_FLOW_BUILD = "44444444-4444-4444-8444-444444444444";
  const TENANT_REPO = "Praxis-build/tenant-app";
  const THREAD = "11111111-1111-4111-8111-111111111111";

  it("an explicit hint at another site's repo is refused, the run is cancelled and nothing is dispatched", async () => {
    const res = await send({ repo_hint: OLDER, build_session_id: OLD_FLOW_BUILD });
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("repo_hint_other_site");
    expect(serviceState.statusUpdates).toEqual([{ table: "agent_runs", status: "cancelled" }]);
    expect(serviceState.lastUpdatePayload).toBeNull();
    expect(inngestState.sentEvents).toHaveLength(0);
  });

  it("an explicit hint at a connected site repo is refused too, never stamped with that site", async () => {
    const res = await send({ repo_hint: NEWER, build_session_id: OLD_FLOW_BUILD });
    expect(res.statusCode).toBe(409);
    expect(serviceState.lastUpdatePayload).toBeNull();
    expect(inngestState.sentEvents).toHaveLength(0);
  });

  it("a site repo the thread inherited is dropped, so the run carries no site and no repo from it", async () => {
    serviceState.connectorMeta = {
      account_login: "Praxis-build",
      installation_id: null,
      repo_full_names: [NEWER, TENANT_REPO],
      default_repo_full_name: TENANT_REPO,
    };
    serviceState.thread = { user_id: u1, agent_slug: "engineer", repo_full_name: NEWER };
    const res = await send({ thread_id: THREAD, build_session_id: OLD_FLOW_BUILD });
    expect(res.statusCode ?? 200).toBeLessThan(300);
    expect(serviceState.lastUpdatePayload).not.toBeNull();
    expect(serviceState.lastUpdatePayload).not.toHaveProperty("site_id");
    expect(serviceState.lastUpdatePayload).not.toHaveProperty("repo_hint");
  });

  it("without a build_session_id the same inherited site repo still carries its site", async () => {
    serviceState.connectorMeta = {
      account_login: "Praxis-build",
      installation_id: null,
      repo_full_names: [NEWER, TENANT_REPO],
      default_repo_full_name: TENANT_REPO,
    };
    serviceState.thread = { user_id: u1, agent_slug: "engineer", repo_full_name: NEWER };
    await send({ thread_id: THREAD });
    expect(serviceState.lastUpdatePayload).toMatchObject({ repo_hint: NEWER, site_id: "site-new" });
  });

  it("a hint at the workspace's own non-site repo is kept alongside the build_session_id", async () => {
    serviceState.connectorMeta = {
      account_login: "Praxis-build",
      installation_id: null,
      repo_full_names: [NEWER, TENANT_REPO],
      default_repo_full_name: TENANT_REPO,
    };
    const res = await send({ repo_hint: TENANT_REPO, build_session_id: OLD_FLOW_BUILD });
    expect(res.statusCode ?? 200).toBeLessThan(300);
    expect(serviceState.lastUpdatePayload).toMatchObject({ repo_hint: TENANT_REPO });
    expect(serviceState.lastUpdatePayload).not.toHaveProperty("site_id");
  });
});
