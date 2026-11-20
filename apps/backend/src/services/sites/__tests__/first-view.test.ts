
import { describe, expect, it, vi } from "vitest";
import { firstContentWriteHook, isSiteContentPath, markFirstView, readFirstView, siteFirstContentHookFor, type FirstViewClient } from "../first-view";
import { SITE_REPO_DIR } from "../contract";

type Call = { table: string; op: string; args: unknown[] };

function fakeClient(opts: {
  site?: { root_conductor_run_id: string | null } | null;
  siteError?: string;
  updated?: Array<{ created_at: string }>;
  updateError?: string;
  read?: Record<string, unknown> | null;
  readError?: string;
}) {
  const calls: Call[] = [];
  const client: FirstViewClient = {
    from: (table) => ({
      select: (cols) => ({
        eq: (c1, v1) => ({
          eq: (c2, v2) => ({
            maybeSingle: async () => {
              calls.push({ table, op: "select", args: [cols, c1, v1, c2, v2] });
              if (table === "sites") return { data: opts.site ?? null, error: opts.siteError ? { message: opts.siteError } : null };
              return { data: opts.read ?? null, error: opts.readError ? { message: opts.readError } : null };
            },
          }),
        }),
      }),
      update: (patch) => ({
        eq: (c1, v1) => ({
          eq: (c2, v2) => ({
            eq: (c3, v3) => ({
              is: (c4, v4) => ({
                select: async (cols) => {
                  calls.push({ table, op: "update", args: [patch, c1, v1, c2, v2, c3, v3, c4, v4, cols] });
                  return { data: opts.updated ?? [], error: opts.updateError ? { message: opts.updateError } : null };
                },
                not: (c5, op5, v5) => ({
                  select: async (cols) => {
                    calls.push({ table, op: "update", args: [patch, c1, v1, c2, v2, c3, v3, c4, v4, `not ${c5} ${op5} ${v5}`, cols] });
                    return { data: opts.updated ?? [], error: opts.updateError ? { message: opts.updateError } : null };
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
  return { client, calls };
}

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-07T10:00:30.000Z");

describe("markFirstView", () => {
  it("stamps the column once on the site's own active root run and logs the ms since the click", async () => {
    const { client, calls } = fakeClient({ site: { root_conductor_run_id: "run-1" }, updated: [{ created_at: "2026-10-07T10:00:00.000Z" }] });
    const log = vi.fn(async () => undefined);
    const r = await markFirstView({ tenant_id: T, site_id: "site-1", mark: "draft" }, { client: () => client, now: () => NOW, log });
    expect(r).toBe("recorded");
    expect(calls[0]).toEqual({ table: "sites", op: "select", args: ["root_conductor_run_id", "tenant_id", T, "id", "site-1"] });
    expect(calls[1]).toEqual({
      table: "conductor_runs",
      op: "update",
      args: [{ first_draft_at: NOW.toISOString() }, "tenant_id", T, "id", "run-1", "status", "active", "first_draft_at", null, "not first_preview_at is null", "created_at"],
    });
    expect(log).toHaveBeenCalledWith({ tenant_id: T, run_id: "run-1", mark: "draft", ms: 30_000 });
  });

  it("the preview mark needs nothing before it; content, like the draft, needs the preview", async () => {
    const preview = fakeClient({ site: { root_conductor_run_id: "run-1" }, updated: [{ created_at: "2026-10-07T10:00:00.000Z" }] });
    await markFirstView({ tenant_id: T, site_id: "s", mark: "preview" }, { client: () => preview.client, now: () => NOW, log: async () => undefined });
    expect(preview.calls[1].args).toEqual([{ first_preview_at: NOW.toISOString() }, "tenant_id", T, "id", "run-1", "status", "active", "first_preview_at", null, "created_at"]);
    const content = fakeClient({ site: { root_conductor_run_id: "run-1" }, updated: [] });
    expect(await markFirstView({ tenant_id: T, site_id: "s", mark: "content" }, { client: () => content.client, now: () => NOW, log: async () => undefined })).toBe("already");
    expect(content.calls[1].args).toContain("not first_preview_at is null");
  });

  it("a second mark (or a run no longer active) changes nothing and logs nothing", async () => {
    const { client } = fakeClient({ site: { root_conductor_run_id: "run-1" }, updated: [] });
    const log = vi.fn(async () => undefined);
    expect(await markFirstView({ tenant_id: T, site_id: "s", mark: "preview" }, { client: () => client, now: () => NOW, log })).toBe("already");
    expect(log).not.toHaveBeenCalled();
  });

  it("never throws: no site, a read error, a missing column all come back as a result", async () => {
    const log = vi.fn(async () => undefined);
    const none = fakeClient({ site: null });
    expect(await markFirstView({ tenant_id: T, site_id: "s", mark: "content" }, { client: () => none.client, now: () => NOW, log })).toBe("no_run");
    const broken = fakeClient({ siteError: "boom" });
    expect(await markFirstView({ tenant_id: T, site_id: "s", mark: "content" }, { client: () => broken.client, now: () => NOW, log })).toBe("failed");
    const noColumn = fakeClient({ site: { root_conductor_run_id: "run-1" }, updateError: 'column "first_content_at" does not exist' });
    expect(await markFirstView({ tenant_id: T, site_id: "s", mark: "content" }, { client: () => noColumn.client, now: () => NOW, log })).toBe("failed");
    const throws = { from: () => { throw new Error("down"); } } as unknown as FirstViewClient;
    expect(await markFirstView({ tenant_id: T, site_id: "s", mark: "content" }, { client: () => throws, now: () => NOW, log })).toBe("failed");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("readFirstView", () => {
  it("reads the three moments of the tenant's run", async () => {
    const { client, calls } = fakeClient({ read: { first_draft_at: "2026-10-07T10:00:20Z", first_preview_at: null, first_content_at: "2026-10-07T10:01:10Z" } });
    expect(await readFirstView(client, T, "run-1")).toEqual({ draft_at: "2026-10-07T10:00:20Z", preview_at: null, content_at: "2026-10-07T10:01:10Z" });
    expect(calls[0].args).toEqual(["first_draft_at, first_preview_at, first_content_at", "tenant_id", T, "id", "run-1"]);
  });

  it("an older database without the columns (or any error) reads as null, never as a failure", async () => {
    expect(await readFirstView(fakeClient({ readError: "column does not exist" }).client, T, "run-1")).toBeNull();
    expect(await readFirstView(fakeClient({ read: null }).client, T, "run-1")).toBeNull();
    expect(await readFirstView({ from: () => { throw new Error("x"); } }, T, "run-1")).toBeNull();
  });
});

describe("the first-content write hook", () => {
  it("counts only the site's own files, never tooling or paths outside the repo", () => {
    for (const p of ["src/pages/Home.tsx", `${SITE_REPO_DIR}/src/components/Hero.tsx`, "./public/logo.svg", "index.html"]) {
      expect(isSiteContentPath(p, SITE_REPO_DIR)).toBe(true);
    }
    for (const p of [undefined, "package.json", "zavi-site.json", "src/../../etc/passwd", "/tmp/x/src/a.ts", "node_modules/x/src/a.ts"]) {
      expect(isSiteContentPath(p, SITE_REPO_DIR)).toBe(false);
    }
  });

  const INPUT = { tenant_id: T, site_id: "site-1", repo_dir: SITE_REPO_DIR, home_path: "src/pages/Home.tsx" };

  it("stamps first_content_at once, when the home page (what replaces the draft) really changed", async () => {
    const mark = vi.fn(async () => "recorded" as const);
    let homeChanged = false;
    const changed = vi.fn(async (_sbx: string, _repo: string, rel: string) => rel !== "src/pages/Home.tsx" || homeChanged);
    const hook = firstContentWriteHook(INPUT, mark, changed);
    await hook({ tool: "mcp__sandbox__run_bash", sandbox_id: "sbx" });
    await hook({ tool: "mcp__sandbox__create", path: "package.json", sandbox_id: "sbx" });
    await hook({ tool: "mcp__sandbox__create", path: "src/components/Hero.tsx", sandbox_id: "sbx" });
    await hook({ tool: "mcp__sandbox__create", path: "src/pages/Home.tsx", sandbox_id: "sbx" });
    expect(mark).not.toHaveBeenCalled();
    homeChanged = true;
    await hook({ tool: "mcp__sandbox__create", path: `${SITE_REPO_DIR}/src/pages/Home.tsx`, sandbox_id: "sbx" });
    await hook({ tool: "mcp__sandbox__str_replace", path: "src/pages/Home.tsx", sandbox_id: "sbx" });
    expect(mark).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith({ tenant_id: T, site_id: "site-1", mark: "content" });
    expect(changed).toHaveBeenCalledWith("sbx", SITE_REPO_DIR, "src/pages/Home.tsx");
  });

  it("two writes racing stamp once; a failing check or a missing sandbox id is never content", async () => {
    const mark = vi.fn(async () => "recorded" as const);
    const hook = firstContentWriteHook(INPUT, mark, async () => true);
    await Promise.all([
      hook({ tool: "create", path: "src/pages/Home.tsx", sandbox_id: "sbx" }),
      hook({ tool: "str_replace", path: "./src/pages/Home.tsx", sandbox_id: "sbx" }),
    ]);
    expect(mark).toHaveBeenCalledTimes(1);
    const broken = vi.fn(async () => "recorded" as const);
    await firstContentWriteHook(INPUT, broken, async () => { throw new Error("exec down"); })({ tool: "create", path: "src/pages/Home.tsx", sandbox_id: "sbx" });
    await firstContentWriteHook(INPUT, broken, async () => true)({ tool: "create", path: "src/pages/Home.tsx" });
    expect(broken).not.toHaveBeenCalled();
  });

  it("is wired only for a site's first build (its first pass or a repair of it)", () => {
    const first = { stage: "build", fast_single_pass: true, site_id: "site-1", target: { github_full_name: "o/r" } };
    expect(siteFirstContentHookFor(first, T)).toBeTypeOf("function");
    expect(siteFirstContentHookFor({ ...first, refine_mode: true }, T)).toBeUndefined();
    expect(siteFirstContentHookFor({ ...first, repair_mode: true }, T)).toBeTypeOf("function");
    expect(siteFirstContentHookFor({ ...first, site_id: "" }, T)).toBeUndefined();
    expect(siteFirstContentHookFor({ stage: "scaffold", target: { github_full_name: "o/r" } }, T)).toBeUndefined();
  });
});
