import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  blockSendgridClient,
  isRefreshTokenGrant,
  LAB_CARD_RPCS,
  LAB_DB_BLOCK_PREFIX,
  LAB_READ_RPCS,
  labBlockedTarget,
  makeLabGuardedFetch,
  withLabDbWriteLog,
} from "../lab-db-guard";

const PROD = "https://wmycgyjsenvgtczlupoe.supabase.co";
const HOST = "wmycgyjsenvgtczlupoe.supabase.co";

describe("labBlockedTarget", () => {
  it("lets only the five lab card RPCs write, and still blocks the real card writer and table writes", () => {
    for (const name of LAB_CARD_RPCS) expect(labBlockedTarget(`${PROD}/rest/v1/rpc/${name}`, "POST", HOST)).toBeNull();
    expect(LAB_CARD_RPCS.size).toBe(5);
    expect(labBlockedTarget(`${PROD}/rest/v1/rpc/record_channel_run_actions`, "POST", HOST)).toBe("rpc:record_channel_run_actions");
    expect(labBlockedTarget(`${PROD}/rest/v1/rpc/displace_channel_actions`, "POST", HOST)).toBe("rpc:displace_channel_actions");
    expect(labBlockedTarget(`${PROD}/rest/v1/channel_actions`, "POST", HOST)).toBe("post:channel_actions");
  });

  it.each([
    ["PATCH", "/rest/v1/tenant_mcp_servers?tenant_id=eq.x", "patch:tenant_mcp_servers"],
    ["POST", "/rest/v1/praxis_logs", "post:praxis_logs"],
    ["POST", "/rest/v1/memory_entity?on_conflict=a", "post:memory_entity"],
    ["DELETE", "/rest/v1/tenant_agent_variant_assignments?x=1", "delete:tenant_agent_variant_assignments"],
    ["POST", "/rest/v1/rpc/consume_budget_or_reject", "rpc:consume_budget_or_reject"],
    ["POST", "/rest/v1/rpc/emit_decision", "rpc:emit_decision"],
    ["POST", "/rest/v1/rpc/not_a_known_fn", "rpc:not_a_known_fn"],
    ["POST", "/storage/v1/object/run-artifacts/a.pdf", "storage:object/run-artifacts"],
    ["PUT", "/auth/v1/admin/users/1", "auth:admin/users"],
  ])("%s %s -> blocked as %s", (m, p, want) => {
    expect(labBlockedTarget(PROD + p, m, HOST)).toBe(want);
  });

  it("selects, counts and listed read RPCs pass", () => {
    expect(labBlockedTarget(`${PROD}/rest/v1/tenants?select=id`, "GET", HOST)).toBeNull();
    expect(labBlockedTarget(`${PROD}/rest/v1/agent_runs?select=id`, "HEAD", HOST)).toBeNull();
    for (const rpc of ["get_secret", "memory_search_hybrid_v2", "list_agents_for_tenant", "effective_autonomy"]) {
      expect(LAB_READ_RPCS.has(rpc)).toBe(true);
      expect(labBlockedTarget(`${PROD}/rest/v1/rpc/${rpc}`, "POST", HOST)).toBeNull();
    }
  });

  it("other hosts are untouched, except Inngest and Slack write methods", () => {
    expect(labBlockedTarget("https://api.github.com/repos/a/b/contents/x", "GET", HOST)).toBeNull();
    expect(labBlockedTarget("https://api.anthropic.com/v1/messages", "POST", HOST)).toBeNull();
    expect(labBlockedTarget("https://inn.gs/e/key", "POST", HOST)).toBe("inngest");
    expect(labBlockedTarget("https://api.inngest.com/v1/events", "POST", HOST)).toBe("inngest");
    expect(labBlockedTarget("https://slack.com/api/chat.postMessage", "POST", HOST)).toBe("slack:chat.postMessage");
    expect(labBlockedTarget("https://slack.com/api/reactions.add", "POST", HOST)).toBe("slack:reactions.add");
    expect(labBlockedTarget("https://slack.com/api/conversations.history", "POST", HOST)).toBeNull();
    expect(labBlockedTarget("https://dgzgwclslzzzrjopbobp.supabase.co/rest/v1/x", "POST", HOST)).toBeNull();
  });

  it("list_agent_threads (soft-deletes beyond 50) and its feed wrapper are not allowed", () => {
    expect(LAB_READ_RPCS.has("list_agent_threads")).toBe(false);
    expect(LAB_READ_RPCS.has("list_agent_threads_feed")).toBe(false);
    expect(labBlockedTarget(`${PROD}/rest/v1/rpc/list_agent_threads`, "POST", HOST)).toBe("rpc:list_agent_threads");
  });

  it("OAuth refresh grants are refused on any host except Google's (Google never rotates)", () => {
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "r" });
    expect(labBlockedTarget("https://auth.atlassian.com/oauth/token", "POST", HOST, form)).toBe("oauth_refresh:auth.atlassian.com");
    expect(labBlockedTarget("https://api.x.com/2/oauth2/token", "POST", HOST, form.toString())).toBe("oauth_refresh:api.x.com");
    expect(
      labBlockedTarget("https://login.microsoftonline.com/common/oauth2/v2.0/token", "POST", HOST, JSON.stringify({ grant_type: "refresh_token" })),
    ).toBe("oauth_refresh:login.microsoftonline.com");
    expect(labBlockedTarget("https://example.com/token?grant_type=refresh_token", "POST", HOST)).toBe("oauth_refresh:example.com");
    expect(labBlockedTarget("https://oauth2.googleapis.com/token", "POST", HOST, form)).toBeNull();
    expect(isRefreshTokenGrant("https://auth.atlassian.com/oauth/token", new URLSearchParams({ grant_type: "authorization_code" }))).toBe(false);
  });

  it("Slack incoming webhooks and non-API Slack writes are refused", () => {
    expect(labBlockedTarget("https://hooks.slack.com/services/T/B/x", "POST", HOST)).toBe("slack:webhook");
    expect(labBlockedTarget("https://slack.com/oauth/v2/whatever", "POST", HOST)).toBe("slack:/oauth/v2/whatever");
    expect(labBlockedTarget("https://slack.com/oauth/v2/authorize", "GET", HOST)).toBeNull();
  });

  it("no write-named RPC is on the read list", () => {
    for (const r of LAB_READ_RPCS) expect(r).not.toMatch(/^(set_|insert|upsert|update|delete|consume|claim|mark_|record_|emit|enqueue|mint|revoke|apply|submit|create|grant)/);
  });
});

describe("makeLabGuardedFetch", () => {
  it("refuses without sending, records against the column, passes reads", async () => {
    const base = vi.fn(async () => new Response("[]", { status: 200 }));
    const seen: string[] = [];
    const f = makeLabGuardedFetch({ supabaseUrl: PROD, baseFetch: base as unknown as typeof fetch, onBlocked: (t) => seen.push(t) });
    const log = await withLabDbWriteLog(async (l) => {
      await expect(f(`${PROD}/rest/v1/x`, { method: "POST", body: "{}" })).rejects.toThrow(`${LAB_DB_BLOCK_PREFIX} (post:x)`);
      await f(`${PROD}/rest/v1/x?select=id`);
      return l;
    });
    expect(base).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["post:x"]);
    expect(seen).toEqual(["post:x"]);
  });

  it("reads the method from a Request object too", async () => {
    const base = vi.fn(async () => new Response("{}"));
    const f = makeLabGuardedFetch({ supabaseUrl: PROD, baseFetch: base as unknown as typeof fetch, onBlocked: () => {} });
    await expect(f(new Request(`${PROD}/rest/v1/y`, { method: "DELETE" }))).rejects.toThrow(/delete:y/);
    expect(base).not.toHaveBeenCalled();
  });
});

describe("markGithubInstallDead under the lab guard", () => {
  const saved = { fetch: globalThis.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const sent = vi.fn(async () => new Response("[]", { status: 200 }));
  const blocked: string[] = [];
  beforeAll(async () => {
    process.env.SUPABASE_URL = PROD;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    globalThis.fetch = makeLabGuardedFetch({ supabaseUrl: PROD, baseFetch: sent as unknown as typeof fetch, onBlocked: (t) => blocked.push(t) });
    const { _resetServiceClientForTests } = await import("@/services/supabase");
    _resetServiceClientForTests();
  });
  afterAll(async () => {
    globalThis.fetch = saved.fetch;
    process.env.SUPABASE_URL = saved.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    const { _resetServiceClientForTests } = await import("@/services/supabase");
    _resetServiceClientForTests();
  });

  it("does not write: the update is refused before it is sent", async () => {
    const { markGithubInstallDead } = await import("@/services/connectors/github/oauth");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await markGithubInstallDead("73db45ff-457e-4541-bc8f-bdb625390204");
    warn.mockRestore();
    expect(sent).not.toHaveBeenCalled();
    expect(blocked).toEqual(["patch:tenant_mcp_servers"]);
  });
});

describe("blockSendgridClient", () => {
  it("every SendGrid request is refused (promise and callback styles) and recorded", async () => {
    class FakeClient {
      request(_d: unknown, _cb?: unknown): Promise<unknown> {
        return Promise.resolve("sent");
      }
    }
    blockSendgridClient(FakeClient as unknown as { prototype: { request: unknown } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = await withLabDbWriteLog(async (l) => {
      await expect(new FakeClient().request({ url: "/v3/mail/send" })).rejects.toThrow(`${LAB_DB_BLOCK_PREFIX} (sendgrid)`);
      const cb = vi.fn();
      await new FakeClient().request({}, cb).catch(() => {});
      expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
      return l;
    });
    warn.mockRestore();
    expect(log).toEqual(["sendgrid", "sendgrid"]);
  });

  it("in plain Node, @sendgrid/mail's client is an instance of the Client the lab patches", () => {
    const out = execFileSync(
      process.execPath,
      ["-e", 'const c=require("@sendgrid/client");const m=require("@sendgrid/mail");process.stdout.write(String(m.client instanceof c.Client))'],
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    expect(out).toBe("true");
  });
});
