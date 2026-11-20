
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { provisionDomainTool, deriveDomain } from "../domain";
import { provisionEmailTool, deriveEmailDomain } from "../email";
import { provisionFlagOn, cred, shouldProvisionReal } from "../_provider";
import { ExpectedToolError } from "@/services/tools/types";

const FAKE_CTX = {
  tenant_id: "test-tenant",
  log: () => {},
};

const ENV_KEYS = [
  "PROVISION_DOMAIN",
  "PROVISION_DOMAIN_REGISTRAR_API_KEY",
  "PROVISION_DOMAIN_REGISTRAR_SECRET_KEY",
  "PROVISION_DOMAIN_REGISTRAR_BASE_URL",
  "PROVISION_EMAIL",
  "PROVISION_EMAIL_SENDGRID_API_KEY",
  "PROVISION_EMAIL_SENDGRID_BASE_URL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function mockFetchOnce(impl: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("_provider — flag + credential gate", () => {
  it("provisionFlagOn defaults ON when unset / empty", () => {
    expect(provisionFlagOn("FOO", {})).toBe(true);
    expect(provisionFlagOn("FOO", { FOO: "" })).toBe(true);
    expect(provisionFlagOn("FOO", { FOO: "1" })).toBe(true);
    expect(provisionFlagOn("FOO", { FOO: "true" })).toBe(true);
  });

  it("provisionFlagOn is OFF only for the literal 0 / false", () => {
    expect(provisionFlagOn("FOO", { FOO: "0" })).toBe(false);
    expect(provisionFlagOn("FOO", { FOO: "false" })).toBe(false);
    expect(provisionFlagOn("FOO", { FOO: "FALSE" })).toBe(false);
    expect(provisionFlagOn("FOO", { FOO: " 0 " })).toBe(false);
  });

  it("cred returns undefined for missing / blank values", () => {
    expect(cred("K", {})).toBeUndefined();
    expect(cred("K", { K: "" })).toBeUndefined();
    expect(cred("K", { K: "   " })).toBeUndefined();
    expect(cred("K", { K: "sk-real" })).toBe("sk-real");
  });

  it("shouldProvisionReal: dry_run requested always wins", () => {
    const r = shouldProvisionReal({
      flagEnv: "F",
      requiredCreds: ["K"],
      dryRunRequested: true,
      env: { F: "1", K: "sk" },
    });
    expect(r.real).toBe(false);
    expect(r.reason).toBe("dry_run_requested");
  });

  it("shouldProvisionReal: flag off blocks real", () => {
    const r = shouldProvisionReal({
      flagEnv: "F",
      requiredCreds: ["K"],
      dryRunRequested: false,
      env: { F: "0", K: "sk" },
    });
    expect(r.real).toBe(false);
    expect(r.reason).toBe("flag_off");
  });

  it("shouldProvisionReal: missing creds blocks real + lists them", () => {
    const r = shouldProvisionReal({
      flagEnv: "F",
      requiredCreds: ["K1", "K2"],
      dryRunRequested: false,
      env: { F: "1", K1: "present" },
    });
    expect(r.real).toBe(false);
    expect(r.reason).toBe("creds_missing");
    expect(r.missingCreds).toEqual(["K2"]);
  });

  it("shouldProvisionReal: flag on + creds + dry_run:false => real", () => {
    const r = shouldProvisionReal({
      flagEnv: "F",
      requiredCreds: ["K"],
      dryRunRequested: false,
      env: { F: "1", K: "sk" },
    });
    expect(r.real).toBe(true);
    expect(r.reason).toBe("ok");
  });
});

describe("provision/domain", () => {
  it("deriveDomain slugifies to <slug>.com", () => {
    expect(deriveDomain("Acme Corp")).toBe("acme-corp.com");
    expect(deriveDomain("Foo & Bar, Inc.")).toBe("foo-bar-inc.com");
  });

  it("dry_run:true requested => simulate, no fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await provisionDomainTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      dry_run: true,
    });
    expect(r.dry_run).toBe(true);
    expect(r.created).toBe(false);
    expect(r.domain).toBe("acme-corp.com");
    expect(r.reason).toBe("dry_run_requested");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag default ON but creds missing => simulate (inert), no fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await provisionDomainTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      dry_run: false,
    });
    expect(r.dry_run).toBe(true);
    expect(r.created).toBe(false);
    expect(r.reason).toBe("creds_missing");
    expect(r.note).toMatch(/PROVISION_DOMAIN_REGISTRAR_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag OFF + creds present + dry_run:false => simulate", async () => {
    process.env.PROVISION_DOMAIN = "0";
    process.env.PROVISION_DOMAIN_REGISTRAR_API_KEY = "pk_test";
    process.env.PROVISION_DOMAIN_REGISTRAR_SECRET_KEY = "sk_test";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await provisionDomainTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      dry_run: false,
    });
    expect(r.dry_run).toBe(true);
    expect(r.reason).toBe("flag_off");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag ON + creds + dry_run:false => REAL registrar call (mocked)", async () => {
    process.env.PROVISION_DOMAIN_REGISTRAR_API_KEY = "pk_test";
    process.env.PROVISION_DOMAIN_REGISTRAR_SECRET_KEY = "sk_test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({ status: "SUCCESS" });
      }),
    );
    const r = await provisionDomainTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      dry_run: false,
    });
    expect(r.dry_run).toBe(false);
    expect(r.created).toBe(true);
    expect(r.domain).toBe("acme-corp.com");
    expect(r.reason).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/domain\/create\/acme-corp\.com$/);
    const sentBody = JSON.parse(calls[0].init.body as string);
    expect(sentBody.apikey).toBe("pk_test");
    expect(sentBody.secretapikey).toBe("sk_test");
  });

  it("real path: registrar non-SUCCESS => ExpectedToolError, no false created", async () => {
    process.env.PROVISION_DOMAIN_REGISTRAR_API_KEY = "pk_test";
    process.env.PROVISION_DOMAIN_REGISTRAR_SECRET_KEY = "sk_test";
    mockFetchOnce(async () =>
      jsonResponse({ status: "ERROR", message: "domain unavailable" }, 400),
    );
    await expect(
      provisionDomainTool.execute(FAKE_CTX, { company_name: "Acme Corp", dry_run: false }),
    ).rejects.toThrowError(ExpectedToolError);
  });

  it("real path: network throw => ExpectedToolError unreachable", async () => {
    process.env.PROVISION_DOMAIN_REGISTRAR_API_KEY = "pk_test";
    process.env.PROVISION_DOMAIN_REGISTRAR_SECRET_KEY = "sk_test";
    mockFetchOnce(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      provisionDomainTool.execute(FAKE_CTX, { company_name: "Acme Corp", dry_run: false }),
    ).rejects.toMatchObject({ code: "domain_registrar_unreachable" });
  });
});

describe("provision/email", () => {
  it("deriveEmailDomain slugifies to <slug>.com", () => {
    expect(deriveEmailDomain("Acme Corp")).toBe("acme-corp.com");
  });

  it("dry_run:true requested => simulate, no fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await provisionEmailTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      dry_run: true,
    });
    expect(r.dry_run).toBe(true);
    expect(r.created).toBe(false);
    expect(r.domain).toBe("acme-corp.com");
    expect(r.from_address).toBe("hello@acme-corp.com");
    expect(r.provider).toBe("sendgrid");
    expect(r.domain_id).toBeNull();
    expect(r.dns_records).toEqual([]);
    expect(r.reason).toBe("dry_run_requested");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag default ON but creds missing => simulate (inert), no fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await provisionEmailTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      dry_run: false,
    });
    expect(r.dry_run).toBe(true);
    expect(r.reason).toBe("creds_missing");
    expect(r.note).toMatch(/PROVISION_EMAIL_SENDGRID_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flag ON + key + dry_run:false => REAL SendGrid call (mocked) returns dns records", async () => {
    process.env.PROVISION_EMAIL_SENDGRID_API_KEY = "SG.test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({
          id: 12345,
          dns: {
            mail_cname: { host: "mail.acme-corp.com", type: "cname", data: "u123.wl.sendgrid.net" },
            dkim1: { host: "s1._domainkey.acme-corp.com", type: "cname", data: "s1.domainkey.u123.wl.sendgrid.net" },
          },
        });
      }),
    );
    const r = await provisionEmailTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      dry_run: false,
    });
    expect(r.dry_run).toBe(false);
    expect(r.created).toBe(true);
    expect(r.domain_id).toBe(12345);
    expect(r.dns_records).toHaveLength(2);
    expect(r.dns_records[0]).toMatchObject({ type: "cname" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/whitelabel\/domains$/);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer SG.test");
    const sentBody = JSON.parse(calls[0].init.body as string);
    expect(sentBody.domain).toBe("acme-corp.com");
  });

  it("real path honors an explicit domain override", async () => {
    process.env.PROVISION_EMAIL_SENDGRID_API_KEY = "SG.test";
    let sentDomain = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentDomain = JSON.parse(init.body as string).domain;
        return jsonResponse({ id: 1, dns: {} });
      }),
    );
    const r = await provisionEmailTool.execute(FAKE_CTX, {
      company_name: "Acme Corp",
      domain: "custom.io",
      dry_run: false,
    });
    expect(r.domain).toBe("custom.io");
    expect(r.from_address).toBe("hello@custom.io");
    expect(sentDomain).toBe("custom.io");
  });

  it("real path: SendGrid error => ExpectedToolError, no false created", async () => {
    process.env.PROVISION_EMAIL_SENDGRID_API_KEY = "SG.test";
    mockFetchOnce(async () =>
      jsonResponse({ errors: [{ message: "invalid domain" }] }, 400),
    );
    await expect(
      provisionEmailTool.execute(FAKE_CTX, { company_name: "Acme Corp", dry_run: false }),
    ).rejects.toMatchObject({ code: "email_authentication_failed" });
  });

  it("real path: network throw => ExpectedToolError unreachable", async () => {
    process.env.PROVISION_EMAIL_SENDGRID_API_KEY = "SG.test";
    mockFetchOnce(async () => {
      throw new Error("ETIMEDOUT");
    });
    await expect(
      provisionEmailTool.execute(FAKE_CTX, { company_name: "Acme Corp", dry_run: false }),
    ).rejects.toMatchObject({ code: "email_provider_unreachable" });
  });
});
