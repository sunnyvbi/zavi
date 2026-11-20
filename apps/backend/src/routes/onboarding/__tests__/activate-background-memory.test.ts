
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

let ownsSlug = false;
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const tenantUpdates: Array<{ patch: Record<string, unknown>; id?: unknown }> = [];
let tenantUpdateError: { message: string } | null = null;
function chain(table: string): unknown {
  const resolve = (single: boolean) => {
    if (ownsSlug && table === "tenants") {
      return single ? { data: { id: "tenant-1" }, error: null } : { data: [{ id: "tenant-1", slug: "acme" }], error: null };
    }
    if (ownsSlug && table === "tenant_users") {
      return single ? { data: { tenant_id: "tenant-1" }, error: null } : { data: [{ tenant_id: "tenant-1" }], error: null };
    }
    return { data: single ? null : [], error: null, count: 0 };
  };
  const target: Record<string, unknown> = {};
  let update: { patch: Record<string, unknown>; id?: unknown } | null = null;
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        const r = update && tenantUpdateError ? { data: null, error: tenantUpdateError } : resolve(false);
        return (ok: (v: unknown) => unknown) => Promise.resolve(r).then(ok);
      }
      if (prop === "maybeSingle" || prop === "single") return async () => resolve(true);
      if (prop === "update" && table === "tenants") {
        return (patch: Record<string, unknown>) => {
          update = { patch };
          tenantUpdates.push(update);
          return proxy;
        };
      }
      if (prop === "eq" && update) {
        return (col: string, v: unknown) => {
          if (col === "id" && update) update.id = v;
          return proxy;
        };
      }
      return () => proxy;
    },
  });
  return proxy;
}
const fakeClient = {
  from: (table: string) => chain(table),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    if (fn === "activate_tenant_v2") return { data: "tenant-1", error: null };
    return { data: null, error: null };
  },
};
vi.mock("@/services/supabase", () => ({
  serviceClient: () => fakeClient,
  serverClientFromBearer: () => fakeClient,
}));

vi.mock("@/services/auth/jwt", () => ({
  verifyBearer: vi.fn(async () => ({ user_id: "user-1", access_token: "tok", email: "f@example.com" })),
}));
vi.mock("@/services/auth/closedBetaGate", () => ({ requireClosedBetaGrant: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/services/tenants/tenant-create-guard", () => ({ checkSelfServeTenantCap: vi.fn(async () => null) }));
vi.mock("@/services/onboarding/workspace-create-limit", () => ({
  reserveWorkspaceSlot: vi.fn(() => ({ commit: vi.fn(), release: vi.fn() })),
  WORKSPACE_LIMIT_MESSAGE: "limit",
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/analytics/mixpanel", () => ({ track: vi.fn(), setProfile: vi.fn() }));
vi.mock("@/services/tenants/bootstrap", () => ({ seedTenantBootstrap: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/classify-test-tenant", () => ({ auditTenantKind: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/new-tenant-alert", () => ({ notifyNewTenant: vi.fn(async () => undefined) }));
vi.mock("@/services/affiliates/attribution", () => ({ attributeTenant: vi.fn(async () => undefined) }));
vi.mock("@/services/staff/admin-tasks/ensure-enrichment-task", () => ({ ensureEnrichmentTask: vi.fn(async () => null) }));
vi.mock("@/services/auth/tenant-cache", () => ({ invalidateCachedTenant: vi.fn() }));
vi.mock("@/services/tenants/session-tenant", () => ({ setSessionTenant: vi.fn(async () => undefined) }));
vi.mock("@/services/settings", () => ({
  setTenantSetting: vi.fn(async () => undefined),
  getBoolSetting: vi.fn(async () => true),
  getSetting: vi.fn(async () => undefined),
}));
const setCompanyFact = vi.fn(async (..._a: unknown[]) => ({ ok: true, error: null }));
vi.mock("@/services/company/facts", () => ({
  getCompanyFacts: vi.fn(async () => ({ competitors: [] })),
  joinCompetitors: (a: string[]) => a.join(", "),
  projectCompanyFactValue: vi.fn(async () => ({ written: true, error: null })),
  COMPANY_STORY_MAX: 8000,
  setCompanyDomain: vi.fn(async () => ({ ok: true, error: null })),
  setCompanyFact: (...a: unknown[]) => setCompanyFact(...a),
}));
vi.mock("@/services/company/country-inference", () => ({ autoSetCompanyCountryInBackground: vi.fn() }));
vi.mock("@/services/growth/goal-attention", () => ({ sendGoalAttention: vi.fn(async () => undefined) }));
vi.mock("@/services/autopilot/goal-measurement", () => ({ setGoalMeasurementMode: vi.fn(async () => undefined) }));
vi.mock("@/services/growth/goal-write", () => ({ writeAutopilotGoal: vi.fn(async () => undefined) }));
vi.mock("@/email/sendAuthEmail", () => ({ sendWelcomeEmail: vi.fn(async () => ({ sent: false })) }));
vi.mock("@/services/onboarding-emails/sequence", () => ({ enrolAndSendFirst: vi.fn(async () => false) }));
vi.mock("@/services/memory/upsert-anchor", () => ({
  upsertAnchor: vi.fn(async () => ({ note_id: "n", chunks: 0 })),
  upsertAnchorGuarded: vi.fn(async () => ({ note_id: "n", chunks: 0 })),
}));
vi.mock("../step-events", () => ({ logOnboardingStep: vi.fn(async () => undefined) }));
const modelCall = vi.fn();
vi.mock("@/services/anthropic", () => ({
  createMessageWithFailover: (...a: unknown[]) => modelCall(...a),
  hasAnthropicAuth: () => true,
  DEFAULT_MODEL: "m",
  cachedSystemBlock: (t: string) => ({ type: "text", text: t }),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: vi.fn(async () => undefined) } }));
const startBackgroundMemory = vi.fn(async (..._a: unknown[]) => ({ status: "pending" }));
vi.mock("@/services/onboarding/background-memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/onboarding/background-memory")>()),
  startBackgroundMemory: (...a: unknown[]) => startBackgroundMemory(...a),
}));

const claims = new Map<string, { tenant_id: string | null; token: string }>();
const waitForClaimedTenant = vi.fn(async (..._a: unknown[]): Promise<string | null> => null);
const claimStart = vi.fn(async (_sb: unknown, user: string, key: string) => {
  const row = claims.get(`${user}:${key}`);
  if (!row) {
    const token = `token-${claims.size}`;
    claims.set(`${user}:${key}`, { tenant_id: null, token });
    return { kind: "owned", token };
  }
  return row.tenant_id
    ? { kind: "replay", tenant_id: row.tenant_id, conductor_run_id: null }
    : { kind: "busy", stale: false, tenant_id: null };
});
vi.mock("@/services/onboarding/start-claims", () => ({
  claimStart: (...a: Parameters<typeof claimStart>) => claimStart(...a),
  waitForClaimedTenant: (...a: unknown[]) => waitForClaimedTenant(...a),
  recordStartClaim: async (_sb: unknown, user: string, key: string, token: string, patch: { tenant_id: string }) => {
    const row = claims.get(`${user}:${key}`);
    if (row?.token !== token) return false;
    row.tenant_id = patch.tenant_id;
    return true;
  },
  releaseStartClaim: async (_sb: unknown, user: string, key: string, token: string) => {
    const row = claims.get(`${user}:${key}`);
    if (row?.token === token && !row.tenant_id) claims.delete(`${user}:${key}`);
  },
}));

import { setTenantSetting } from "@/services/settings";
import { onboardingActivate } from "../activate";
import { logEvent } from "@/services/logging/logEvent";
import { checkSelfServeTenantCap } from "@/services/tenants/tenant-create-guard";
import { verifyBearer } from "@/services/auth/jwt";
import { setSessionTenant } from "@/services/tenants/session-tenant";

function call(body: Record<string, unknown>, headers: Record<string, string> = {}, query: Record<string, unknown> = {}) {
  const json = vi.fn();
  const status = vi.fn();
  const res = { json, status } as unknown as Response;
  status.mockReturnValue(res);
  const req = { body, query, ip: "1.2.3.4", headers } as unknown as Request;
  return onboardingActivate(req, res).then(() => ({ json, status }));
}

const websiteBody = (extra: Record<string, unknown> = {}) => ({
  slug: "acme",
  display_name: "Acme",
  memory: {},
  onboarding_meta: { wizard: { orgName: "Acme", website: "https://www.Acme.com/pricing" } },
  background_memory: true,
  scan_id: "AbCdEfGhIjKlMnOp12",
  ...extra,
});

beforeEach(() => {
  ownsSlug = false;
  vi.mocked(setTenantSetting).mockClear();
  rpcCalls.length = 0;
  tenantUpdates.length = 0;
  tenantUpdateError = null;
  vi.mocked(logEvent).mockClear();
  startBackgroundMemory.mockClear();
  setCompanyFact.mockClear();
  modelCall.mockClear();
  claims.clear();
  claimStart.mockClear();
  waitForClaimedTenant.mockReset();
  waitForClaimedTenant.mockResolvedValue(null);
});

describe("activate — background memory path", () => {
  it("creates the workspace and starts the job without any model call", async () => {
    const { json, status } = await call(websiteBody());
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, tenant_id: "tenant-1", memory: "background" }));
    expect(startBackgroundMemory).toHaveBeenCalledTimes(1);
    expect(startBackgroundMemory).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      userId: "user-1",
      scanId: "AbCdEfGhIjKlMnOp12",
      host: "acme.com",
      initialName: "Acme",
    });
    expect(modelCall).not.toHaveBeenCalled();
    expect(rpcCalls.find((c) => c.fn === "activate_tenant_v2")?.args.p_memory).toEqual({});
  });

  it("does not store the address-guessed name as the founder's company_name", async () => {
    await call(websiteBody());
    expect(setCompanyFact.mock.calls.some((c) => c[1] === "company_name")).toBe(false);
  });

  it("a re-activate of the founder's own workspace never restarts the job", async () => {
    ownsSlug = true;
    const { json } = await call(websiteBody());
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(startBackgroundMemory).not.toHaveBeenCalled();
  });

  it("without background_memory nothing starts and the typed name is kept", async () => {
    const body = websiteBody({ background_memory: undefined, scan_id: undefined });
    const { json } = await call(body);
    expect(json).toHaveBeenCalledWith(expect.not.objectContaining({ memory: "background" }));
    expect(startBackgroundMemory).not.toHaveBeenCalled();
    expect(setCompanyFact.mock.calls.some((c) => c[1] === "company_name")).toBe(true);
  });

  it("rejects a malformed scan id", async () => {
    const { status } = await call(websiteBody({ scan_id: "../../etc" }));
    expect(status).toHaveBeenCalledWith(400);
    expect(startBackgroundMemory).not.toHaveBeenCalled();
  });
});

describe("activate — workspace time zone", () => {
  const timezoneWrites = () => tenantUpdates.filter((u) => "timezone" in u.patch);

  it("saves a real browser zone on the new workspace", async () => {
    const { json } = await call(websiteBody({ timezone: "Europe/Paris" }));
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(timezoneWrites()).toEqual([{ patch: { timezone: "Europe/Paris" }, id: "tenant-1" }]);
  });

  it("ignores a zone that is not real and still activates", async () => {
    const { json, status } = await call(websiteBody({ timezone: "Mars/Base" }));
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, tenant_id: "tenant-1" }));
    expect(timezoneWrites()).toEqual([]);
  });

  it("without a zone the workspace keeps the column default", async () => {
    const { json } = await call(websiteBody());
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(timezoneWrites()).toEqual([]);
  });

  it("a failed save never fails the activation", async () => {
    tenantUpdateError = { message: "db down" };
    const { json, status } = await call(websiteBody({ timezone: "Europe/Paris" }));
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, tenant_id: "tenant-1" }));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "tenant_timezone.save_failed" }));
  });

  it("re-activating your own workspace never overwrites its zone", async () => {
    ownsSlug = true;
    await call(websiteBody({ timezone: "Europe/Paris" }));
    expect(timezoneWrites()).toEqual([]);
  });
});

describe("activate — one workspace per Idempotency-Key", () => {
  const KEY = { "idempotency-key": "0b5c7f2e-aaaa-4222-8333-444455556666" };
  const creates = () => rpcCalls.filter((c) => c.fn === "activate_tenant_v2").length;

  it("an Add company retry with the same key gets the first workspace, not a second", async () => {
    await call(websiteBody({ additional: true }), KEY);
    const { json, status } = await call(websiteBody({ additional: true }), KEY);
    expect(creates()).toBe(1);
    expect(status).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ ok: true, tenant_id: "tenant-1", replayed: true });
    expect(startBackgroundMemory).toHaveBeenCalledTimes(1);
    expect(claimStart).toHaveBeenLastCalledWith(expect.anything(), "user-1", `activate:${KEY["idempotency-key"]}`, { runRequired: false });
  });

  it("a repeat while the first is still creating waits for its answer", async () => {
    claims.set(`user-1:activate:${KEY["idempotency-key"]}`, { tenant_id: null, token: "first" });
    waitForClaimedTenant.mockResolvedValueOnce("tenant-1");
    const { json } = await call(websiteBody({ additional: true }), KEY);
    expect(json).toHaveBeenCalledWith({ ok: true, tenant_id: "tenant-1", replayed: true });
    expect(creates()).toBe(0);
  });

  it("a repeat that gets the first answer pins its session to that workspace", async () => {
    ownsSlug = true;
    vi.mocked(verifyBearer).mockResolvedValueOnce({ user_id: "user-1", access_token: "tok", email: "f@example.com", session_id: "sess-2" } as never);
    claims.set(`user-1:activate:${KEY["idempotency-key"]}`, { tenant_id: null, token: "first" });
    waitForClaimedTenant.mockResolvedValueOnce("tenant-1");
    const { json } = await call(websiteBody({ additional: true }), KEY);
    expect(json).toHaveBeenCalledWith({ ok: true, tenant_id: "tenant-1", replayed: true });
    expect(setSessionTenant).toHaveBeenCalledWith("sess-2", "user-1", "tenant-1");
  });

  it("still not created after the wait: 409, nothing created", async () => {
    claims.set(`user-1:activate:${KEY["idempotency-key"]}`, { tenant_id: null, token: "first" });
    const { status } = await call(websiteBody({ additional: true }), KEY);
    expect(status).toHaveBeenCalledWith(409);
    expect(creates()).toBe(0);
  });

  it("a refusal before the workspace exists frees the key for a retry", async () => {
    vi.mocked(checkSelfServeTenantCap).mockResolvedValueOnce({ code: "tenant_limit", message: "cap" } as never);
    const refused = await call(websiteBody({ additional: true }), KEY);
    expect(refused.status).toHaveBeenCalledWith(403);
    expect(claims.size).toBe(0);
    const { json } = await call(websiteBody({ additional: true }), KEY);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, tenant_id: "tenant-1" }));
    expect(creates()).toBe(1);
  });

  it("a claim store that cannot be read fails closed: 503, nothing created", async () => {
    claimStart.mockResolvedValueOnce({ kind: "unavailable" } as never);
    const { status } = await call(websiteBody(), KEY);
    expect(status).toHaveBeenCalledWith(503);
    expect(creates()).toBe(0);
  });

  it("no key (an older app build): no claim, activates as before", async () => {
    const { json } = await call(websiteBody());
    expect(claimStart).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, tenant_id: "tenant-1" }));
  });
});

it.each([['x', 'social'], ['x', 'creator'], ['email', 'email'], ['linkedin', 'social'], ['producthunt', 'referral']])(
  'persists request-query %s/%s attribution when the body omits it', async (source, medium) => {
    const tags = { utm_source: source, utm_medium: medium, utm_campaign: 'launch2' };
    const { json } = await call(websiteBody(), {}, tags);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(setTenantSetting).toHaveBeenCalledWith('tenant-1', 'signup_attribution', tags, 'user-1');
  },
);

it.each(["filter-coffee", "newsletter-morning-blue"])("persists generic channel %s in website activation", async from => {
  const { json } = await call(websiteBody(), {}, { from });
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  expect(setTenantSetting).toHaveBeenCalledWith("tenant-1", "signup_attribution", { from }, "user-1");
});

it("accepts diagnostic-only attribution without blocking activation", async () => {
  const attribution = { capture_status: "analytics_disabled" };
  const { json } = await call({ ...websiteBody(), attribution });
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  expect(setTenantSetting).toHaveBeenCalledWith("tenant-1", "signup_attribution", attribution, "user-1");
});
