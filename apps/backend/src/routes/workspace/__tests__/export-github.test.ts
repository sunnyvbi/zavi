import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  repo: null as Record<string, unknown> | null,
  github: null as Record<string, unknown> | null,
  role: "owner" as string | null,
  runs: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  sites: [] as Array<Record<string, unknown>>,
  rpcs: [] as Array<{ tenant: string; name: string; args: Record<string, unknown> }>,
  runReadFails: false,
}));
const exportMock = vi.hoisted(() => ({ impl: null as null | ((input: unknown) => Promise<unknown>) }));

vi.mock("@/services/supabase", () => {
  const client = () => ({
    from: (table: string) => {
      let pending: { table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> } | null = null;
      const reads: Array<[string, unknown]> = [];
      const q = {
        select: () => q,
        update: (patch: Record<string, unknown>) => {
          pending = { table, patch, filters: [] };
          db.updates.push(pending);
          return q;
        },
        eq: (col: string, val: unknown) => {
          pending?.filters.push([col, val]);
          reads.push([col, val]);
          return q;
        },
        maybeSingle: async () =>
          table === "conductor_runs" && db.runReadFails
            ? { data: null, error: { message: "db down" } }
            : {
                data:
                  table === "conductor_runs"
                    ? db.runs.find((r) => reads.every(([c, v]) => r[c] === v)) ?? null
                    : table === "tenant_resources"
                      ? db.repo
                      : db.github,
                error: null,
              },
        then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
      };
      return q;
    },
  });
  return { serviceClient: client, serverClientFromBearer: client };
});
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    getByRun: async (t: string, run: string) => db.sites.find((s) => s.tenant_id === t && s.root_conductor_run_id === run) ?? null,
    get: async (t: string, id: string) => db.sites.find((s) => s.tenant_id === t && s.id === id) ?? null,
  }),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async (tenant: string, name: string, args: Record<string, unknown>) => {
    db.rpcs.push({ tenant, name, args });
    return { data: null, error: null };
  },
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "tenant-a", user_id: "u1" })),
  authMiddleware: vi.fn(),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, allowed: readonly string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (db.role && allowed.includes(db.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  }),
}));
const mint = vi.hoisted(() => ({ calls: [] as unknown[], fail: false }));
vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: vi.fn(async (input: unknown) => {
    mint.calls.push(input);
    if (mint.fail) throw new Error("install token refused");
    return "ghs_install_token";
  }),
}));
vi.mock("@/services/provisioning/export-to-own-github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/provisioning/export-to-own-github")>();
  return { ...actual, exportRepoToOwnGitHub: (input: unknown) => exportMock.impl!(input) };
});

import { __resetExportsInFlight, getWorkspaceExportGithubDest, getWorkspaceExportGithubStatus, postWorkspaceExportGithub } from "../export-github";
import { DestRepoMissing } from "@/services/provisioning/export-to-own-github";

type Res = { statusCode: number; body: any; status: (n: number) => Res; json: (b: unknown) => Res };
function mockRes(): Res {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  __resetExportsInFlight();
  mint.calls = [];
  mint.fail = false;
  db.updates = [];
  db.sites = [];
  db.rpcs = [];
  db.runReadFails = false;
  db.role = "owner";
  db.runs = [];
  db.repo = {
    mode: "provisioned",
    status: "ready",
    external_ref: { github_full_name: "Praxis-build/mohit-93bd8436" },
  };
  db.github = { installation_id: 164038209, account_login: "mohit-upcar", account_type: "User" };
  exportMock.impl = async () => {
    throw new DestRepoMissing("mohit-upcar", "my-site");
  };
});

describe("POST /api/workspace/export-github when the destination repo does not exist", () => {
  it("returns the owner, repo name and the personal install's access page so the UI can prefill GitHub", async () => {
    const res = mockRes();
    await postWorkspaceExportGithub({ body: { dest_repo_name: "my-site" } } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatchObject({
      code: "dest_repo_must_exist",
      owner: "mohit-upcar",
      repo_name: "my-site",
      access_url: "https://github.com/settings/installations/164038209",
    });
    expect(res.body.error.message).not.toMatch(/^dest_user_repo_must_exist/);
  });

  it("points an organization install at the org's installation settings, not the user's", async () => {
    db.github = { installation_id: 42, account_login: "acme-co", account_type: "Organization" };
    exportMock.impl = async () => {
      throw new DestRepoMissing("acme-co", "mohit-93bd8436");
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatchObject({
      code: "dest_repo_must_exist",
      owner: "acme-co",
      repo_name: "mohit-93bd8436",
      access_url: "https://github.com/organizations/acme-co/settings/installations/42",
    });
  });

  it("keeps any other GitHub failure as a 502 export_failed", async () => {
    exportMock.impl = async () => {
      throw new Error("export dest repo create failed (422): name already exists");
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(502);
    expect(res.body.error.code).toBe("export_failed");
  });
});

describe("remembering an export so the popover can show it before any click", () => {
  const done = {
    exported: true as const,
    dest_full_name: "mohit-upcar/my-site",
    dest_url: "https://github.com/mohit-upcar/my-site",
    branch: "main",
    commit_sha: "c0ffee",
    source_sha: "5a1ce00",
    file_count: 42,
    created_dest_repo: false,
  };

  const remembered = (source_sha: string | null = "5a1ce00") => ({
    full_name: "mohit-upcar/my-site",
    url: "https://github.com/mohit-upcar/my-site",
    branch: "main",
    commit_sha: "c0ffee",
    ...(source_sha ? { source_sha } : {}),
    file_count: 42,
    exported_at: "2026-09-25T07:01:54.000Z",
  });

  function sourceHeadIs(sha: string) {
    const calls: string[] = [];
    vi.stubEnv("GITHUB_PROVISION_TOKEN", "umbrella_tok");
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (/\/git\/ref\/heads\//.test(url)) return new Response(JSON.stringify({ object: { sha } }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    return calls;
  }

  it("GET reports nothing until an export has landed, and never calls GitHub or the exporter", async () => {
    exportMock.impl = async () => {
      throw new Error("must not export on a status read");
    };
    const res = mockRes();
    await getWorkspaceExportGithubStatus({} as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, export: null, source: "Praxis-build/mohit-93bd8436", up_to_date: null });
    expect(db.updates).toEqual([]);
  });

  it("a successful export is written onto the tenant's repo row, keyed on the server-side tenant, without dropping the rest of external_ref", async () => {
    exportMock.impl = async () => done;
    sourceHeadIs("5a1ce00");
    const res = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(db.updates).toHaveLength(1);
    const [u] = db.updates;
    expect(u.table).toBe("tenant_resources");
    expect(u.filters).toEqual([
      ["tenant_id", "tenant-a"],
      ["resource_kind", "repo"],
    ]);
    const ref = u.patch.external_ref as Record<string, unknown>;
    expect(ref.github_full_name).toBe("Praxis-build/mohit-93bd8436");
    expect(ref.export).toMatchObject({
      full_name: "mohit-upcar/my-site",
      url: "https://github.com/mohit-upcar/my-site",
      branch: "main",
      commit_sha: "c0ffee",
      source_sha: "5a1ce00",
      file_count: 42,
    });
    expect(res.body.up_to_date).toBe(true);
    expect(Date.parse((ref.export as { exported_at: string }).exported_at)).not.toBeNaN();
  });

  it("GET returns what the export wrote, so the popover can show it before any click", async () => {
    db.repo = {
      mode: "provisioned",
      status: "ready",
      external_ref: {
        github_full_name: "Praxis-build/mohit-93bd8436",
        export: {
          full_name: "mohit-upcar/my-site",
          url: "https://github.com/mohit-upcar/my-site",
          branch: "main",
          commit_sha: "c0ffee",
          file_count: 42,
          exported_at: "2026-09-25T07:01:54.000Z",
        },
      },
    };
    const res = mockRes();
    await getWorkspaceExportGithubStatus({} as never, res as never);
    expect(res.body.export).toEqual({
      full_name: "mohit-upcar/my-site",
      url: "https://github.com/mohit-upcar/my-site",
      branch: "main",
      commit_sha: "c0ffee",
      source_sha: null,
      file_count: 42,
      exported_at: "2026-09-25T07:01:54.000Z",
    });
    expect(res.body.up_to_date).toBeNull();
  });

  it("GET says up to date only while the build's source head is the commit that was exported", async () => {
    db.repo = { mode: "provisioned", status: "ready", external_ref: { github_full_name: "Praxis-build/mohit-93bd8436", export: remembered() } };
    const calls = sourceHeadIs("5a1ce00");
    const same = mockRes();
    await getWorkspaceExportGithubStatus({} as never, same as never);
    expect(same.body.up_to_date).toBe(true);
    expect(calls.some((u) => u.includes("/repos/Praxis-build/mohit-93bd8436/git/ref/heads/main"))).toBe(true);

    sourceHeadIs("n3wc0de");
    const moved = mockRes();
    await getWorkspaceExportGithubStatus({} as never, moved as never);
    expect(moved.body.up_to_date).toBe(false);
    expect(moved.body.export.source_sha).toBe("5a1ce00");
  });

  it("POST says up to date only if the build did not move on while the copy ran", async () => {
    exportMock.impl = async () => done;
    sourceHeadIs("5a1ce00");
    const still = mockRes();
    await postWorkspaceExportGithub({ body: { dest_repo_name: "my-site" } } as never, still as never);
    expect(still.body.ok).toBe(true);
    expect(still.body.up_to_date).toBe(true);

    sourceHeadIs("n3wc0de");
    const moved = mockRes();
    await postWorkspaceExportGithub({ body: { dest_repo_name: "my-site" } } as never, moved as never);
    expect(moved.body.ok).toBe(true);
    expect(moved.body.up_to_date).toBe(false);
  });

  it("GET never claims up to date when it cannot tell: no source sha on the record, no umbrella token, or GitHub down", async () => {
    db.repo = { mode: "provisioned", status: "ready", external_ref: { github_full_name: "Praxis-build/mohit-93bd8436", export: remembered(null) } };
    sourceHeadIs("5a1ce00");
    const noSha = mockRes();
    await getWorkspaceExportGithubStatus({} as never, noSha as never);
    expect(noSha.body.up_to_date).toBeNull();

    db.repo = { mode: "provisioned", status: "ready", external_ref: { github_full_name: "Praxis-build/mohit-93bd8436", export: remembered() } };
    vi.stubEnv("GITHUB_PROVISION_TOKEN", "");
    const noToken = mockRes();
    await getWorkspaceExportGithubStatus({} as never, noToken as never);
    expect(noToken.body.up_to_date).toBeNull();

    vi.stubEnv("GITHUB_PROVISION_TOKEN", "umbrella_tok");
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const down = mockRes();
    await getWorkspaceExportGithubStatus({} as never, down as never);
    expect(down.statusCode).toBe(200);
    expect(down.body.up_to_date).toBeNull();
    expect(down.body.export.full_name).toBe("mohit-upcar/my-site");
  });

  it("an up-to-date re-run on a record without a source sha stores the sha once, so the next GET can answer", async () => {
    db.repo = { mode: "provisioned", status: "ready", external_ref: { github_full_name: "Praxis-build/mohit-93bd8436", export: remembered(null) } };
    exportMock.impl = async () => ({ ...done, exported: false, reason: "already_exported" });
    sourceHeadIs("5a1ce00");
    const res = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body.up_to_date).toBe(true);
    expect(db.updates).toHaveLength(1);
    const ref = db.updates[0].patch.external_ref as { export: { source_sha: string; exported_at: string } };
    expect(ref.export.source_sha).toBe("5a1ce00");
    expect(ref.export.exported_at).toBe("2026-09-25T07:01:54.000Z");
  });

  it("writes onto the repo row as it is after the export, not the snapshot read before it", async () => {
    exportMock.impl = async () => {
      db.repo = {
        mode: "provisioned",
        status: "ready",
        external_ref: {
          github_full_name: "Praxis-build/mohit-93bd8436",
          default_branch: "trunk",
          repo_url: "https://github.com/Praxis-build/mohit-93bd8436",
        },
      };
      return done;
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    const ref = db.updates[0].patch.external_ref as Record<string, unknown>;
    expect(ref).toMatchObject({
      github_full_name: "Praxis-build/mohit-93bd8436",
      default_branch: "trunk",
      repo_url: "https://github.com/Praxis-build/mohit-93bd8436",
      export: { full_name: "mohit-upcar/my-site" },
    });
  });

  it("an already-up-to-date re-run keeps the original export time instead of bumping it", async () => {
    db.repo = {
      mode: "provisioned",
      status: "ready",
      external_ref: {
        github_full_name: "Praxis-build/mohit-93bd8436",
        export: { ...done, full_name: "mohit-upcar/my-site", url: done.dest_url, exported_at: "2026-09-25T07:01:54.000Z" },
      },
    };
    exportMock.impl = async () => ({ ...done, exported: false, reason: "already_exported" });
    const res = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(db.updates).toEqual([]);
  });

  it("a failed export writes nothing", async () => {
    exportMock.impl = async () => {
      throw new Error("export dest tree failed (502): nope");
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(502);
    expect(db.updates).toEqual([]);
  });
});

describe("one export at a time per build", () => {
  const okResult = {
    exported: true,
    reason: "exported",
    dest_full_name: "mohit-upcar/my-site",
    dest_url: "https://github.com/mohit-upcar/my-site",
    branch: "main",
    created_dest_repo: false,
    file_count: 42,
    commit_sha: "c0ffee",
    source_sha: "s1",
  };

  it("a second click while the copy runs gets in-progress instead of racing the push, and the next click after it lands runs again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    exportMock.impl = async () => {
      runs += 1;
      await gate;
      return okResult;
    };
    const first = mockRes();
    const firstDone = postWorkspaceExportGithub({ body: {} } as never, first as never);
    await new Promise((r) => setTimeout(r, 0));
    const second = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, second as never);
    expect(second.statusCode).toBe(409);
    expect(second.body.error.code).toBe("idempotency_in_progress");
    expect(runs).toBe(1);
    release();
    await firstDone;
    expect(first.statusCode).toBe(200);
    expect(first.body.ok).toBe(true);
    const third = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, third as never);
    expect(third.statusCode).toBe(200);
    expect(runs).toBe(2);
  });

  it("a failed export frees the build for the next click", async () => {
    exportMock.impl = async () => {
      throw new Error("export dest tree failed (502): nope");
    };
    const first = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, first as never);
    expect(first.statusCode).toBe(502);
    exportMock.impl = async () => okResult;
    const second = mockRes();
    await postWorkspaceExportGithub({ body: {} } as never, second as never);
    expect(second.statusCode).toBe(200);
  });

  it("a different build of the same workspace is not blocked by the first one's export", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sources: string[] = [];
    exportMock.impl = async (input) => {
      sources.push((input as { source_full_name: string }).source_full_name);
      if (sources.length === 1) await gate;
      return okResult;
    };
    db.runs = [
      { id: "11111111-1111-4111-8111-111111111111", tenant_id: "tenant-a", kind: "build_app", goal_graph: [{ payload: { target: { github_full_name: "Praxis-build/app-one" } } }] },
      { id: "22222222-2222-4222-8222-222222222222", tenant_id: "tenant-a", kind: "build_app", goal_graph: [{ payload: { target: { github_full_name: "Praxis-build/app-two" } } }] },
    ];
    const first = mockRes();
    const firstDone = postWorkspaceExportGithub({ body: { conductor_run_id: "11111111-1111-4111-8111-111111111111" } } as never, first as never);
    await new Promise((r) => setTimeout(r, 0));
    const second = mockRes();
    await postWorkspaceExportGithub({ body: { conductor_run_id: "22222222-2222-4222-8222-222222222222" } } as never, second as never);
    expect(second.statusCode).toBe(200);
    release();
    await firstDone;
    expect(sources).toEqual(["Praxis-build/app-one", "Praxis-build/app-two"]);
  });
});

describe("exporting the build that is open, not whichever app is newest", () => {
  const BUILD_A = "8b282ce4-b91d-4b12-b842-a85cb0f14396";
  const BUILD_B = "11111111-2222-4333-8444-555555555555";
  const OTHER_TENANT_BUILD = "99999999-2222-4333-8444-555555555555";
  const done = {
    exported: true as const,
    dest_full_name: "mohit-upcar/cake-shop",
    dest_url: "https://github.com/mohit-upcar/cake-shop",
    branch: "main",
    commit_sha: "c0ffee",
    file_count: 12,
    created_dest_repo: true,
  };
  const target = (full: string) => [{ id: "spec", payload: { target: { github_full_name: full } } }];

  beforeEach(() => {
    db.repo = {
      mode: "provisioned",
      status: "ready",
      external_ref: { github_full_name: "Praxis-build/upcoming-cake-1111" },
    };
    db.runs = [
      { id: BUILD_A, tenant_id: "tenant-a", kind: "build_app", goal_graph: target("Praxis-build/cake-shop-2990") },
      { id: BUILD_B, tenant_id: "tenant-a", kind: "build_app", goal_graph: target("Praxis-build/upcoming-cake-1111") },
      { id: OTHER_TENANT_BUILD, tenant_id: "tenant-b", kind: "build_app", goal_graph: target("Praxis-build/secret-app-9999") },
    ];
  });

  it("copies the open build's repo even after a newer app took over the workspace repo row", async () => {
    let seen: { source_full_name?: string } = {};
    exportMock.impl = async (input) => {
      seen = input as { source_full_name?: string };
      return done;
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: { conductor_run_id: BUILD_A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(seen.source_full_name).toBe("Praxis-build/cake-shop-2990");
    const ref = db.updates[0].patch.external_ref as Record<string, unknown>;
    expect(ref.github_full_name).toBe("Praxis-build/upcoming-cake-1111");
    expect(ref.export).toBeUndefined();
    expect((ref.exports as Record<string, unknown>)["Praxis-build/cake-shop-2990"]).toMatchObject({
      full_name: "mohit-upcar/cake-shop",
    });
  });

  it("never exports another workspace's build, and never calls the exporter for it", async () => {
    exportMock.impl = async () => {
      throw new Error("must not export another tenant's code");
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: { conductor_run_id: OTHER_TENANT_BUILD } } as never, res as never);
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe("build_session_not_found");
    expect(db.updates).toEqual([]);
  });

  it("refuses a build whose repo is not in Zavi's GitHub org", async () => {
    db.runs.push({ id: "22222222-2222-4333-8444-555555555555", tenant_id: "tenant-a", kind: "build_app", goal_graph: target("someone-else/app") });
    exportMock.impl = async () => {
      throw new Error("must not export a repo Zavi does not manage");
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: { conductor_run_id: "22222222-2222-4333-8444-555555555555" } } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("not_zavi_managed");
  });

  it("rejects a malformed build id before any lookup", async () => {
    const res = mockRes();
    await postWorkspaceExportGithub({ body: { conductor_run_id: "../../etc" } } as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it("GET shows each build its own export, not the other app's", async () => {
    db.repo = {
      mode: "provisioned",
      status: "ready",
      external_ref: {
        github_full_name: "Praxis-build/upcoming-cake-1111",
        exports: {
          "Praxis-build/cake-shop-2990": {
            full_name: "mohit-upcar/cake-shop",
            url: "https://github.com/mohit-upcar/cake-shop",
            branch: "main",
            commit_sha: "c0ffee",
            file_count: 12,
            exported_at: "2026-09-30T08:00:00.000Z",
          },
        },
      },
    };
    const a = mockRes();
    await getWorkspaceExportGithubStatus({ query: { conductor_run_id: BUILD_A } } as never, a as never);
    expect(a.body.export).toMatchObject({ full_name: "mohit-upcar/cake-shop" });
    expect(a.body.source).toBe("Praxis-build/cake-shop-2990");
    const b = mockRes();
    await getWorkspaceExportGithubStatus({ query: { conductor_run_id: BUILD_B } } as never, b as never);
    expect(b.body.export).toBeNull();
    expect(b.body.source).toBe("Praxis-build/upcoming-cake-1111");
  });

  it("a member who is not an owner or admin cannot push the code out", async () => {
    db.role = "member";
    exportMock.impl = async () => {
      throw new Error("members must not export");
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: { conductor_run_id: BUILD_A } } as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(db.updates).toEqual([]);
  });
});

describe("many sites per workspace: a site session exports ITS repo and keeps ITS history", () => {
  const SA = "aaaaaaaa-0000-4000-8000-00000000000a";
  const SB = "bbbbbbbb-0000-4000-8000-00000000000b";
  const RUN_A = "aaaaaaaa-1111-4111-8111-11111111111a";
  const RUN_B = "bbbbbbbb-1111-4111-8111-11111111111b";
  const RUN_C = "cccccccc-1111-4111-8111-11111111111c";
  const done = {
    exported: true,
    reason: "exported",
    dest_full_name: "mohit-upcar/bakery",
    dest_url: "https://github.com/mohit-upcar/bakery",
    branch: "main",
    commit_sha: "beef",
    file_count: 7,
    created_dest_repo: true,
  };
  const siteRun = (id: string, site: string) => ({ id, tenant_id: "tenant-a", kind: "build_app", s0: site, s1: site, s2: null, goal_graph: [] });
  const site = (id: string, run: string, repo: string | null, extra: Record<string, unknown> = {}) => ({
    id,
    tenant_id: "tenant-a",
    root_conductor_run_id: run,
    status: "live",
    hostname: `${id.slice(0, 4)}.zaviagent.com`,
    github_full_name: repo,
    ...extra,
  });

  beforeEach(() => {
    db.repo = null;
    db.runs = [siteRun(RUN_A, SA), siteRun(RUN_B, SB), siteRun(RUN_C, SA)];
    db.sites = [
      site(SA, RUN_A, "praxis-built/bakery-a1b2", {
        github_export: {
          full_name: "mohit-upcar/bakery",
          url: "https://github.com/mohit-upcar/bakery",
          branch: "main",
          commit_sha: "c0ffee",
          file_count: 5,
          exported_at: "2026-09-30T08:00:00.000Z",
        },
      }),
      site(SB, RUN_B, "praxis-built/gym-c3d4"),
    ];
  });

  it("POST exports site A's own repo and remembers it on site A, never on a repo row", async () => {
    let seen: { source_full_name?: string; tenant_id?: string } = {};
    exportMock.impl = async (input) => {
      seen = input as typeof seen;
      return done;
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: { conductor_run_id: RUN_A } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(seen).toMatchObject({ source_full_name: "praxis-built/bakery-a1b2", tenant_id: "tenant-a" });
    expect(db.updates).toEqual([]);
    expect(db.rpcs).toEqual([
      expect.objectContaining({
        tenant: "tenant-a",
        name: "site_set_github_export",
        args: expect.objectContaining({ p_site_id: SA, p_record: expect.objectContaining({ full_name: "mohit-upcar/bakery", commit_sha: "beef" }) }),
      }),
    ]);
  });

  it("remembers against the site as it is after the export, not the snapshot read before it", async () => {
    db.sites[1] = site(SB, RUN_B, "praxis-built/gym-c3d4");
    const landed = { full_name: "mohit-upcar/gym", url: "https://github.com/mohit-upcar/gym", branch: "main", commit_sha: "f00d", file_count: 3, exported_at: "2026-10-01T09:00:00.000Z" };
    exportMock.impl = async () => {
      db.sites[1] = { ...db.sites[1], github_export: landed };
      return { ...done, exported: false, reason: "already_exported", dest_full_name: "mohit-upcar/gym", commit_sha: null };
    };
    const res = mockRes();
    await postWorkspaceExportGithub({ body: { conductor_run_id: RUN_B } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(db.rpcs).toEqual([]);
  });

  it("POST for site B exports B's repo, not A's", async () => {
    let seen: { source_full_name?: string } = {};
    exportMock.impl = async (input) => {
      seen = input as typeof seen;
      return { ...done, dest_full_name: "mohit-upcar/gym" };
    };
    await postWorkspaceExportGithub({ body: { conductor_run_id: RUN_B } } as never, mockRes() as never);
    expect(seen.source_full_name).toBe("praxis-built/gym-c3d4");
    expect(db.rpcs[0].args.p_site_id).toBe(SB);
  });

  it("GET shows each site its own export history", async () => {
    const a = mockRes();
    await getWorkspaceExportGithubStatus({ query: { conductor_run_id: RUN_A } } as never, a as never);
    expect(a.statusCode).toBe(200);
    expect(a.body).toMatchObject({ export: { full_name: "mohit-upcar/bakery", commit_sha: "c0ffee" }, source: "praxis-built/bakery-a1b2" });
    const b = mockRes();
    await getWorkspaceExportGithubStatus({ query: { conductor_run_id: RUN_B } } as never, b as never);
    expect(b.body).toMatchObject({ export: null, source: "praxis-built/gym-c3d4" });
  });

  it("GET refuses a malformed (400), foreign (404) or unreadable (503) build id instead of answering 'never exported'", async () => {
    db.runs.push({ id: "dddddddd-1111-4111-8111-11111111111d", tenant_id: "tenant-b", kind: "build_app", s0: SA, goal_graph: [] });
    const cases: Array<[string, number]> = [["nope", 400], ["dddddddd-1111-4111-8111-11111111111d", 404]];
    for (const [id, status] of cases) {
      const res = mockRes();
      await getWorkspaceExportGithubStatus({ query: { conductor_run_id: id } } as never, res as never);
      expect(res.statusCode).toBe(status);
    }
    db.runReadFails = true;
    const res = mockRes();
    await getWorkspaceExportGithubStatus({ query: { conductor_run_id: RUN_A } } as never, res as never);
    expect(res.statusCode).toBe(503);
  });

  it("a site whose repo is not created yet has nothing to export (GET null, POST 409)", async () => {
    db.sites[1] = site(SB, RUN_B, null);
    exportMock.impl = async () => {
      throw new Error("must not export");
    };
    const g = mockRes();
    await getWorkspaceExportGithubStatus({ query: { conductor_run_id: RUN_B } } as never, g as never);
    expect(g.body).toMatchObject({ export: null, source: null });
    const p = mockRes();
    await postWorkspaceExportGithub({ body: { conductor_run_id: RUN_B } } as never, p as never);
    expect(p.statusCode).toBe(409);
    expect(p.body.error.code).toBe("no_provisioned_repo");
  });
});

describe("GET /api/workspace/export-github/dest: does the founder's repo exist yet", () => {
  function githubAnswers(status: number) {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, auth: init?.headers?.Authorization });
        return { status, ok: status < 300, json: async () => ({}), text: async () => "" };
      }),
    );
    return calls;
  }

  it("asks GitHub with the workspace's install token, under the connected account, and says exists=true on 200", async () => {
    const calls = githubAnswers(200);
    const res = mockRes();
    await getWorkspaceExportGithubDest({ query: { dest_repo_name: "my-site" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, exists: true, full_name: "mohit-upcar/my-site" });
    expect(mint.calls).toEqual([{ tenant_id: "tenant-a", installation_id: 164038209 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/mohit-upcar/my-site");
    expect(calls[0].auth).toBe("token ghs_install_token");
  });

  it("says exists=false on 404 without erroring, so the popover keeps waiting", async () => {
    githubAnswers(404);
    const res = mockRes();
    await getWorkspaceExportGithubDest({ query: { dest_repo_name: "my-site" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, exists: false, full_name: "mohit-upcar/my-site" });
  });

  it("never treats a GitHub failure as 'repo exists': 5xx and a refused token both answer 502", async () => {
    githubAnswers(503);
    const flaky = mockRes();
    await getWorkspaceExportGithubDest({ query: { dest_repo_name: "my-site" } } as never, flaky as never);
    expect(flaky.statusCode).toBe(502);
    expect(flaky.body.error.code).toBe("dest_lookup_failed");

    mint.fail = true;
    const calls = githubAnswers(200);
    const noToken = mockRes();
    await getWorkspaceExportGithubDest({ query: { dest_repo_name: "my-site" } } as never, noToken as never);
    expect(noToken.statusCode).toBe(502);
    expect(calls).toHaveLength(0);
  });

  it("a member who cannot export cannot probe the connected account's repo names either", async () => {
    const calls = githubAnswers(200);
    db.role = "member";
    const res = mockRes();
    await getWorkspaceExportGithubDest({ query: { dest_repo_name: "secret-plans" } } as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    expect(mint.calls).toHaveLength(0);
  });

  it("rejects a missing or malformed name (400) and a workspace with no GitHub connected (409) before touching GitHub", async () => {
    const calls = githubAnswers(200);
    for (const query of [{}, { dest_repo_name: "has space" }, { dest_repo_name: ["a", "b"] }]) {
      const res = mockRes();
      await getWorkspaceExportGithubDest({ query } as never, res as never);
      expect(res.statusCode).toBe(400);
      expect(res.body.error.code).toBe("bad_dest_repo_name");
    }
    db.github = null;
    const res = mockRes();
    await getWorkspaceExportGithubDest({ query: { dest_repo_name: "my-site" } } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("github_not_connected");
    expect(calls).toHaveLength(0);
    expect(mint.calls).toHaveLength(0);
  });
});
