
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/services/supabase", () => ({ serviceClient: () => H.client }));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: vi.fn() }));
vi.mock("@/services/launch-video-public/store", () => ({
  getJobById: vi.fn(),
  updateJob: vi.fn(),
}));
vi.mock("@/services/company/facts", () => ({
  setCompanyFact: vi.fn(async () => ({ ok: true, error: null })),
  getCompanyFacts: vi.fn(async () => ({ facts: {} })),
}));
vi.mock("@/services/tenants/bootstrap", () => ({ seedTenantBootstrap: vi.fn(async () => undefined) }));
vi.mock("@/services/tenants/signup-attribution", async () => ({
  ...await vi.importActual<typeof import("@/services/tenants/signup-attribution")>("@/services/tenants/signup-attribution"),
  persistSignupAttribution: vi.fn(async () => undefined),
}));

import { launchVideoClaim } from "../launch-video-claim";
import { requireAuth } from "@/services/auth/middleware";
import { getJobById, updateJob } from "@/services/launch-video-public/store";
import { setCompanyFact, getCompanyFacts } from "@/services/company/facts";
import { seedTenantBootstrap } from "@/services/tenants/bootstrap";
import { persistSignupAttribution } from "@/services/tenants/signup-attribution";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const JOB_ID = "33333333-3333-3333-3333-333333333333";

const asMock = (f: unknown) => f as unknown as ReturnType<typeof vi.fn>;

function makeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

function makeSb(sessionEmail: string | null, opts: { userErr?: boolean } = {}) {
  const rpc = vi.fn(async () => ({ data: "claimed", error: null }));
  const getUserById = vi.fn(async () => ({
    data: { user: { email: sessionEmail } },
    error: opts.userErr ? { message: "boom" } : null,
  }));
  return {
    rpc,
    getUserById,
    client: {
      rpc,
      auth: { admin: { getUserById } },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { storage_path: "t/x.mp4", bucket: "b" } }),
          }),
        }),
      }),
      storage: {
        from: () => ({
          createSignedUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }),
        }),
      },
    },
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    tenant_id: TENANT_ID,
    status: "ready",
    email: "visitor@example.com",
    hd_artifact_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  asMock(requireAuth).mockResolvedValue({
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    access_token: "tok",
  });
});

describe("launchVideoClaim — ownership gate", () => {
  it("REJECTS a session whose email does not match job.email (the hole)", async () => {
    const sb = makeSb("attacker@evil.com");
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job());

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_your_video");
    expect(sb.rpc).not.toHaveBeenCalled();
    expect(updateJob).not.toHaveBeenCalled();
    expect((res.body as { hd_url?: string }).hd_url).toBeUndefined();
  });

  it("ALLOWS the real owner (same email) to claim", async () => {
    const sb = makeSb("visitor@example.com");
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job());

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(sb.rpc).toHaveBeenCalledTimes(1);
    expect((res.body as { status: string }).status).toBe("claimed");
    expect((res.body as { hd_url: string }).hd_url).toBe("https://signed");
  });

  it("records where a fresh claim came from, like the other two signup paths", async () => {
    const sb = makeSb("visitor@example.com");
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job());
    const attribution = { from: "filter-coffee" };
    await launchVideoClaim({ body: { job_id: JOB_ID, attribution }, query: { utm_source: "x" } } as never, makeRes() as never);
    expect(persistSignupAttribution).toHaveBeenCalledWith(TENANT_ID, USER_ID, attribution, { utm_source: "x" });
  });

  it("keeps the generation source when the emailed claim has no campaign tags", async () => {
    H.client = makeSb("visitor@example.com").client;
    const attribution = { from: "filter-coffee", utm_source: "newsletter", utm_campaign: "launch" };
    asMock(getJobById).mockResolvedValue(job({ form_input: { signup_attribution: attribution } }));
    await launchVideoClaim({ body: { job_id: JOB_ID }, query: {} } as never, makeRes() as never);
    expect(persistSignupAttribution).toHaveBeenCalledWith(TENANT_ID, USER_ID, attribution, {});
  });

  it("does not replace the original campaign with a later claim-page campaign", async () => {
    H.client = makeSb("visitor@example.com").client;
    const attribution = { from: "filter-coffee", utm_source: "newsletter", utm_campaign: "launch" };
    asMock(getJobById).mockResolvedValue(job({ form_input: { signup_attribution: attribution } }));
    await launchVideoClaim({ body: { job_id: JOB_ID, attribution: { utm_source: "later" } }, query: {} } as never, makeRes() as never);
    expect(persistSignupAttribution).toHaveBeenCalledWith(TENANT_ID, USER_ID, attribution, {});
  });

  it("matches case-insensitively + trims (visitor typed it into a public form)", async () => {
    const sb = makeSb("Visitor@Example.com  ");
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job({ email: "  visitor@example.COM" }));

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(sb.rpc).toHaveBeenCalledTimes(1);
  });

  it("FAILS CLOSED when the job has no email (unprovable owner)", async () => {
    const sb = makeSb("anyone@example.com");
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job({ email: null }));

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the session has no email", async () => {
    const sb = makeSb(null);
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job());

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the user lookup errors (never falls through to the claim)", async () => {
    const sb = makeSb("visitor@example.com", { userErr: true });
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job());

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("rejection copy is actionable but never names the owner (no enumeration)", async () => {
    const sb = makeSb("attacker@evil.com");
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job());

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    const msg = (res.body as { error: { message: string } }).error.message;
    expect(msg).toBe(
      "This video was requested with a different email address. Sign in with the address you entered on the form to claim it.",
    );
    expect(JSON.stringify(res.body)).not.toContain("visitor@example.com");
  });

  it("all four rejection branches return a BYTE-IDENTICAL body (branch is unleakable)", async () => {
    const scenarios: Array<{
      name: string;
      sessionEmail: string | null;
      jobOverride: Record<string, unknown>;
      opts: { userErr?: boolean };
    }> = [
      { name: "email mismatch", sessionEmail: "attacker@evil.com", jobOverride: {}, opts: {} },
      { name: "job.email null", sessionEmail: "anyone@example.com", jobOverride: { email: null }, opts: {} },
      { name: "session email null", sessionEmail: null, jobOverride: {}, opts: {} },
      { name: "lookup error", sessionEmail: "visitor@example.com", jobOverride: {}, opts: { userErr: true } },
    ];

    const seen: string[] = [];
    for (const sc of scenarios) {
      const sb = makeSb(sc.sessionEmail, sc.opts);
      H.client = sb.client;
      asMock(getJobById).mockResolvedValue(job(sc.jobOverride));

      const res = makeRes();
      await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

      expect(res.statusCode, sc.name).toBe(403);
      expect(sb.rpc, sc.name).not.toHaveBeenCalled();
      seen.push(JSON.stringify(res.body));
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(1);
  });
});

describe("launchVideoClaim — seeding the claimed workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asMock(requireAuth).mockResolvedValue({ user_id: USER_ID });
    asMock(updateJob).mockResolvedValue(undefined);
    asMock(setCompanyFact).mockResolvedValue({ ok: true, error: null });
    asMock(getCompanyFacts).mockResolvedValue({ facts: {} });
    asMock(seedTenantBootstrap).mockResolvedValue(undefined);
  });

  const form = {
    company: "Northwind Tools",
    product_name: "Northwind",
    one_liner: "Scheduling for mobile repair crews.",
    audience: "Independent repair shops",
    features: "Route planning\nParts inventory",
  };

  it("seeds the founder's OWN words on a fresh claim, and never the authored intake", async () => {
    const sb = makeSb("visitor@example.com");
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(
      job({ form_input: form, intake: { one_liner: "MODEL-EXPANDED — must never be written" } }),
    );

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { profile_seeded: boolean }).profile_seeded).toBe(true);

    const written = asMock(setCompanyFact).mock.calls.map((c) => [c[1], c[2]] as [string, string]);
    const byKey = Object.fromEntries(written);
    expect(byKey.company_name).toBe("Northwind Tools");
    expect(byKey.what_we_sell).toBe("Scheduling for mobile repair crews.");
    expect(byKey.who_we_serve).toBe("Independent repair shops");
    expect(byKey.company_story).toContain("Route planning");

    for (const [, value] of written) expect(value).not.toContain("MODEL-EXPANDED");

    expect(String(asMock(setCompanyFact).mock.calls[0][3])).toMatch(/launch-video form/i);

    expect(seedTenantBootstrap).toHaveBeenCalledWith(TENANT_ID);
  });

  it("writes NOTHING when the claimer already has a workspace", async () => {
    const sb = makeSb("visitor@example.com");
    sb.rpc.mockResolvedValue({ data: "user_has_tenant", error: null });
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job({ form_input: form }));

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { status: string }).status).toBe("user_has_tenant");
    expect(setCompanyFact).not.toHaveBeenCalled();
    expect(seedTenantBootstrap).not.toHaveBeenCalled();
    expect(persistSignupAttribution).not.toHaveBeenCalled();
    expect((res.body as { hd_url: string }).hd_url).toBe("https://signed");
  });

  it("still returns 200 and the HD url when seeding blows up", async () => {
    const sb = makeSb("visitor@example.com");
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job({ form_input: form }));
    asMock(setCompanyFact).mockRejectedValue(new Error("brain is down"));

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { hd_url: string }).hd_url).toBe("https://signed");
    expect((res.body as { profile_seeded: boolean }).profile_seeded).toBe(false);
  });
});

describe("launchVideoClaim — re-claim is inert over existing answers", () => {
  const form = {
    company: "Northwind Tools",
    one_liner: "Scheduling for mobile repair crews.",
    audience: "Independent repair shops",
    features: "Route planning",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    asMock(requireAuth).mockResolvedValue({ user_id: USER_ID });
    asMock(updateJob).mockResolvedValue(undefined);
    asMock(setCompanyFact).mockResolvedValue({ ok: true, error: null });
    asMock(seedTenantBootstrap).mockResolvedValue(undefined);
  });

  it("does NOT overwrite a fact the founder has since corrected", async () => {
    const sb = makeSb("visitor@example.com");
    sb.rpc.mockResolvedValue({ data: "not_shell", error: null });
    sb.client.from = () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { user_id: USER_ID }, error: null }) }),
          maybeSingle: async () => ({ data: { storage_path: "t/x.mp4", bucket: "b" } }),
        }),
      }),
    });
    asMock(getCompanyFacts).mockResolvedValue({
      facts: {
        company_name: { value_text: "Northwind Tools" },
        what_we_sell: { value_text: "Dispatch + invoicing for mobile repair crews." },
      },
    });
    asMock(getJobById).mockResolvedValue(job({ form_input: form }));

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(200);
    const keysWritten = asMock(setCompanyFact).mock.calls.map((c) => c[1] as string);
    expect(keysWritten).not.toContain("what_we_sell");
    expect(keysWritten).not.toContain("company_name");
    expect(keysWritten).toContain("who_we_serve");
  });

  it("fails closed and writes nothing when the current facts cannot be read", async () => {
    const sb = makeSb("visitor@example.com");
    H.client = sb.client;
    asMock(getJobById).mockResolvedValue(job({ form_input: form }));
    asMock(getCompanyFacts).mockRejectedValue(new Error("read down"));

    const res = makeRes();
    await launchVideoClaim({ body: { job_id: JOB_ID } } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(setCompanyFact).not.toHaveBeenCalled();
    expect((res.body as { profile_seeded: boolean }).profile_seeded).toBe(false);
  });
});
