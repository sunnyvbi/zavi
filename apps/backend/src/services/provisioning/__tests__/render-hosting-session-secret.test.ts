import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSecretMock, setResourceSecretMock } = vi.hoisted(() => ({
  getSecretMock: vi.fn(),
  setResourceSecretMock: vi.fn(),
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: getSecretMock }));
vi.mock("@/services/provisioning/secret", () => ({ setResourceSecret: setResourceSecretMock }));

import { createRenderHostingProvisioner } from "@/services/provisioning/render-hosting";

function res(status: number, body: unknown = {}) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
const repo = "https://github.com/praxis-built/acme";
const ctxDb = { context: { repo_url: repo, neon_project_id: "proj-1" } };
const ctxStatic = { context: { repo_url: repo } };

function envVarsFromPost(fetchFn: ReturnType<typeof vi.fn>): Array<{ key: string; value: string }> {
  const postCall = fetchFn.mock.calls.find(
    (c) => String(c[0]).endsWith("/v1/services") && String(c[1]?.method) === "POST",
  );
  return JSON.parse(String(postCall?.[1]?.body ?? "{}")).serviceDetails?.envVars ?? [];
}

function dbProvisioner(fetchFn: ReturnType<typeof vi.fn>) {
  return createRenderHostingProvisioner({
    token: () => "tok",
    ownerId: () => "own",
    fetchFn: fetchFn as never,
    dbUrl: async () => "postgres://u:p@ep-x.neon.tech/neondb?sslmode=require",
  });
}

beforeEach(() => {
  getSecretMock.mockReset();
  setResourceSecretMock.mockReset();
  setResourceSecretMock.mockResolvedValue("app.session_secret");
});

describe("render-hosting SESSION_SECRET provisioning", () => {
  it("first provision: GENERATES a strong (>=32-byte) server-only SESSION_SECRET, persists it, injects it + redeploys", async () => {
    getSecretMock.mockResolvedValue(null);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockResolvedValue(res(201, {}));
    await dbProvisioner(fetchFn).ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });

    expect(setResourceSecretMock).toHaveBeenCalledTimes(1);
    const [t, kind, key, persistedVal] = setResourceSecretMock.mock.calls[0] as [string, string, string, string];
    expect(t).toBe("t1");
    expect(kind).toBe("hosting");
    expect(key).toBe("app.session_secret");
    expect(Buffer.from(persistedVal, "base64url").length).toBeGreaterThanOrEqual(32);

    const envVars = envVarsFromPost(fetchFn);
    const ss = envVars.find((e) => e.key === "SESSION_SECRET");
    expect(ss).toBeTruthy();
    expect(ss!.value).toBe(persistedVal);
    expect(envVars.some((e) => e.key.startsWith("NEXT_PUBLIC_") && /SESSION/i.test(e.key))).toBe(false);

    const putUrls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(putUrls.some((u) => u.includes("/env-vars/SESSION_SECRET"))).toBe(true);

    const deploys = fetchFn.mock.calls.filter(
      (c) => String(c[0]).endsWith("/srv_new/deploys") && String(c[1]?.method) === "POST",
    );
    expect(deploys.length).toBe(1);
  });

  it("redeploy: REUSES the stored secret (stable) — never regenerates or re-persists", async () => {
    const STORED = "stored_session_secret_value_at_least_32_chars_long";
    getSecretMock.mockResolvedValue(STORED);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockResolvedValue(res(201, {}));
    await dbProvisioner(fetchFn).ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });

    expect(setResourceSecretMock).not.toHaveBeenCalled();
    const ss = envVarsFromPost(fetchFn).find((e) => e.key === "SESSION_SECRET");
    expect(ss!.value).toBe(STORED);
  });

  it("a too-short stored secret (<32 chars) is treated as absent → regenerated", async () => {
    getSecretMock.mockResolvedValue("short");
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockResolvedValue(res(201, {}));
    await dbProvisioner(fetchFn).ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });

    expect(setResourceSecretMock).toHaveBeenCalledTimes(1);
    const ss = envVarsFromPost(fetchFn).find((e) => e.key === "SESSION_SECRET");
    expect(ss!.value).not.toBe("short");
    expect(Buffer.from(ss!.value, "base64url").length).toBeGreaterThanOrEqual(32);
  });

  it("heal path (existing service): reuses the stored secret + upserts it via per-key PUT", async () => {
    const STORED = "stored_session_secret_value_at_least_32_chars_long";
    getSecretMock.mockResolvedValue(STORED);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, [{ service: { id: "srv_exist", serviceDetails: { url: "https://x.onrender.com" } } }]))
      .mockResolvedValue(res(200, {}));
    await dbProvisioner(fetchFn).ensure({ tenant_id: "t1", company_name: "Acme", ...ctxDb });

    expect(setResourceSecretMock).not.toHaveBeenCalled();
    const putUrls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(putUrls.some((u) => u.includes("/env-vars/SESSION_SECRET"))).toBe(true);
  });

  it("static no-DB app: gets NO SESSION_SECRET and never touches Vault", async () => {
    getSecretMock.mockResolvedValue(null);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(201, { id: "srv_new", serviceDetails: { url: "https://x.onrender.com" } }))
      .mockResolvedValue(res(200, {}));
    const p = createRenderHostingProvisioner({
      token: () => "tok",
      ownerId: () => "own",
      fetchFn: fetchFn as never,
      dbUrl: async () => null,
    });
    await p.ensure({ tenant_id: "t1", company_name: "Acme", ...ctxStatic });

    expect(getSecretMock).not.toHaveBeenCalled();
    expect(setResourceSecretMock).not.toHaveBeenCalled();
    expect(envVarsFromPost(fetchFn).some((e) => e.key === "SESSION_SECRET")).toBe(false);
  });
});
