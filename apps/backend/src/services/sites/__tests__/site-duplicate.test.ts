import { describe, expect, it, vi } from "vitest";
import type { SiteRow, SiteStatus } from "../contract";
import type { SiteDesignRow } from "../site-design-store";
import type { BlobMode } from "@/services/provisioning/export-to-own-github";
import { fallbackDesignBrief, designDirections } from "../design-directions";
import { copyName, DuplicateRefused, duplicateSite, filesForCopy, type DuplicateSiteDeps, type PausedSchedule } from "../site-duplicate";
import { siteRow, T1, T2 } from "./fake-site-store";

const SRC = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW = "bbbbbbbb-0000-4000-8000-000000000002";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const text = (s: string | undefined) => Buffer.from(s ?? "", "base64").toString("utf8");

const SOURCE_CONFIG =
  'import { zaviHead } from "./vite-zavi-head";\nconst ZAVI_HEAD = {"name":"Harbor Yoga","url":"https://harbor-yoga-1.zaviagent.com/","image":""};\nexport default { plugins: [zaviHead(ZAVI_HEAD)] };\n';

function sourceRepo() {
  const files = new Map<string, string>([
    ["package.json", b64("{}")],
    ["src/App.tsx", b64("export default () => null;")],
    ["public/images/hero.webp", Buffer.from([0, 1, 2, 255]).toString("base64")],
    ["scripts/dev.sh", b64("#!/bin/sh\n")],
    [".env", b64("STRIPE_SECRET=sk_live_x")],
    [".env.example", b64("STRIPE_SECRET=sk_live_filled_in")],
    [".npmrc", b64("//registry.npmjs.org/:_authToken=x")],
    ["keys/server.pem", b64("-----BEGIN PRIVATE KEY-----")],
    [".dev.vars", b64("TOKEN=z")],
    [".aws/credentials", b64("aws_secret_access_key=x")],
    [".docker/config.json", b64("{}")],
    ["auth.json", b64("{}")],
    ["infra/prod.tfvars", b64("x")],
    ["Supabase/migrations/001.sql", b64("create table x();")],
    [".kube/config", b64("token: x")],
    ["deploy/credentials.yaml", b64("key: x")],
    ["src/integrations/supabase/client.ts", b64("export const client = null;")],
    ["server/.env.production", b64("TOKEN=y")],
    ["vite.config.ts", b64(SOURCE_CONFIG)],
    ["vite-zavi-head.ts", b64("export function zaviHead() {}")],
  ]);
  const modes = new Map<string, BlobMode>([["scripts/dev.sh", "100755"]]);
  return { files, modes };
}

function designRow(over: Partial<SiteDesignRow> = {}): SiteDesignRow {
  const brief = fallbackDesignBrief({ idea: "A yoga studio where members book classes." });
  const directions = designDirections(brief);
  return {
    site_id: SRC,
    tenant_id: T1,
    conductor_run_id: "run-src",
    brief,
    directions,
    theme_mode: "theme_css",
    chosen_direction: directions[1]!.id,
    chosen_at: "2026-10-01T00:00:00Z",
    applied_direction: directions[1]!.id,
    sealed_at: "2026-10-01T00:00:00Z",
    journey_fix_claimed_at: null,
    journey_fix_conductor_run_id: null,
    fidelity: null,
    updated_at: null,
    ...over,
  };
}

type Done = { site_id: string; conductor_run_id: string; name: string };
function setup(opts: { manifest?: unknown; source?: Partial<SiteRow>; design?: SiteDesignRow | null; pushFails?: boolean; done?: { source: string; key: string; copy: Done }; doneAfterSlot?: boolean; gate?: "ok" | "builder_off" | "backend_unavailable" } = {}) {
  const sites: SiteRow[] = [
    siteRow({ id: SRC, tenant_id: T1, label: "harbor-yoga-1", name: "Harbor Yoga", status: "live", supabase_project_ref: null, supabase_url: null, backend_mode: "pooled", github_full_name: "Praxis-build/harbor-yoga-1", ...opts.source }),
    siteRow({ id: "cccccccc-0000-4000-8000-000000000003", tenant_id: T2, label: "other-1", name: "Other", status: "live", supabase_project_ref: null }),
  ];
  const calls: string[] = [];
  const pushed: Array<{ full_name: string; files: Map<string, string>; modes: Map<string, BlobMode>; message: string }> = [];
  const finished: Array<{ conductor_run_id: string; goal_graph: Array<{ status: string; payload: Record<string, unknown>; checkpoint?: unknown }> }> = [];
  const design = opts.design === undefined ? designRow() : opts.design;
  const designCalls: string[] = [];
  const deps: DuplicateSiteDeps = {
    canCreateSite: vi.fn(async () => opts.gate ?? "ok"),
    findDone: vi.fn(async (t: string, source: string, key: string) => {
      const d = opts.done;
      if (!d || t !== T1 || source !== d.source || key !== d.key) return null;
      if (opts.doneAfterSlot && !calls.includes("acquire")) return null;
      return d.copy;
    }),
    store: {
      get: vi.fn(async (t: string, id: string) => sites.find((s) => s.id === id && s.tenant_id === t) ?? null),
      getOrCreateForRun: vi.fn(async (input) => {
        calls.push(`site:${input.site_name}`);
        const row = siteRow({ id: NEW, tenant_id: input.tenant_id, label: "harbor-yoga-copy-2", name: input.site_name ?? null, status: "provisioning", github_full_name: null, supabase_project_ref: null, supabase_url: null, root_conductor_run_id: input.root_conductor_run_id });
        sites.push(row);
        return row;
      }),
      update: vi.fn(async (_t, id, patch) => {
        const s = sites.find((x) => x.id === id)!;
        Object.assign(s, patch);
        return { ...s };
      }),
      transition: vi.fn(async (_t, id, from: SiteStatus[], to: SiteStatus, patch = {}) => {
        const s = sites.find((x) => x.id === id)!;
        if (!from.includes(s.status)) return null;
        Object.assign(s, patch, { status: to });
        calls.push(`transition:${to}`);
        return { ...s };
      }),
      claimProvider: vi.fn(async () => undefined),
      setProviderState: vi.fn(async () => undefined),
    },
    designStore: {
      get: vi.fn(async (t: string, id: string) => (t === T1 && id === SRC ? design : null)),
      createIfAbsent: vi.fn(async (row) => {
        designCalls.push(`create:${row.site_id}`);
        return { ...designRow(), ...row, chosen_direction: "brand", applied_direction: "brand", sealed_at: null };
      }),
      choose: vi.fn(async (_t, site_id, d) => (designCalls.push(`choose:${site_id}:${d}`), null)),
      markApplied: vi.fn(async (_t, site_id, d) => void designCalls.push(`applied:${site_id}:${d}`)),
      seal: vi.fn(async (_t, site_id) => (designCalls.push(`seal:${site_id}`), null)),
    },
    acquireRun: vi.fn(async () => (calls.push("acquire"), "run-new")),
    finishRun: vi.fn(async (input) => {
      finished.push(input as (typeof finished)[number]);
      calls.push("finish");
    }),
    failRun: vi.fn(async (input: { tenant_id: string }) => void calls.push(`fail:${input.tenant_id}`)),
    initStatic: vi.fn(async () => void calls.push("initStatic")),
    repoOrg: () => "Praxis-build",
    ensureRepo: vi.fn(async (name: string) => ({ full_name: `Praxis-build/${name}`, default_branch: "main", repo_url: `https://github.com/Praxis-build/${name}` })),
    readRepo: vi.fn(async () => {
      const repo = sourceRepo();
      if (opts.manifest !== undefined) repo.files.set("zavi-site.json", b64(JSON.stringify(opts.manifest)));
      return repo;
    }),
    clearSchedules: vi.fn(async (_t, site_id) => void calls.push(`clear:${site_id}`)),
    pauseSchedules: vi.fn(async (_t, site_id, schedules) => void calls.push(`pause:${site_id}:${schedules.map((x: { name: string }) => x.name).join(",")}`)),
    pushRepo: vi.fn(async (input) => {
      if (opts.pushFails) throw new Error("github down");
      pushed.push(input);
      return "c0ffee0000000000000000000000000000000000";
    }),
    ensureGithubConnector: vi.fn(async () => undefined),
    deleteSite: vi.fn(async (_t, id) => void calls.push(`delete:${id}`)),
    webBase: () => "https://www.zaviagent.com",
    now: () => new Date("2026-10-07T12:00:00Z"),
  };
  return { deps, sites, calls, pushed, finished, designCalls };
}

const input = (over: Partial<Parameters<typeof duplicateSite>[0]> = {}) => ({
  tenant_id: T1,
  source_site_id: SRC,
  user_id: "user-1",
  owner_email: "founder@example.test",
  ...over,
});

describe("duplicateSite", () => {
  it("makes a new site in the same workspace with the code, minus env files, and the head pointed at the copy", async () => {
    const { deps, sites, pushed } = setup();
    const out = await duplicateSite(input(), deps);
    expect(out).toEqual({ site_id: NEW, conductor_run_id: "run-new", name: "Harbor Yoga (copy)" });
    const copy = sites.find((s) => s.id === NEW)!;
    expect(copy.tenant_id).toBe(T1);
    expect(copy.status).toBe("building");
    expect(copy.github_full_name).toBe("Praxis-build/harbor-yoga-copy-2");
    expect(copy.desired_sha).toBe("c0ffee0000000000000000000000000000000000");
    expect(copy.owner_email).toBe("founder@example.test");
    expect(pushed).toHaveLength(1);
    const files = pushed[0]!.files;
    expect([...files.keys()].sort()).toEqual([
      "package.json",
      "public/images/hero.webp",
      "scripts/dev.sh",
      "src/App.tsx",
      "src/integrations/supabase/client.ts",
      "vite-zavi-head.ts",
      "vite.config.ts",
    ]);
    expect(files.get("public/images/hero.webp")).toBe(Buffer.from([0, 1, 2, 255]).toString("base64"));
    expect(pushed[0]!.modes.get("scripts/dev.sh")).toBe("100755");
    const config = text(files.get("vite.config.ts"));
    expect(config).toContain("https://harbor-yoga-copy-2.zaviagent.com/");
    expect(config).not.toContain("harbor-yoga-1");
    expect(pushed[0]!.full_name).toBe("Praxis-build/harbor-yoga-copy-2");
  });

  it("copies the design in the look its files carry (the applied one), sealed", async () => {
    const d = designRow();
    const applied = d.directions[2]!.id;
    const { deps, designCalls } = setup({ design: { ...d, chosen_direction: d.directions[1]!.id, applied_direction: applied, sealed_at: null } });
    await duplicateSite(input(), deps);
    expect(designCalls).toEqual([`create:${NEW}`, `choose:${NEW}:${applied}`, `applied:${NEW}:${applied}`, `seal:${NEW}`]);
  });

  it("a retry with the same request key gets the copy already made, and nothing new is made", async () => {
    const copy = { site_id: NEW, conductor_run_id: "run-earlier", name: "Harbor Yoga (copy)" };
    const { deps, calls } = setup({ done: { source: SRC, key: "dup-key-12345", copy } });
    expect(await duplicateSite(input({ request_key: "dup-key-12345" }), deps)).toEqual(copy);
    expect(calls).toEqual([]);
  });

  it("a key reused for another source, or another workspace's site, never returns that copy", async () => {
    const copy = { site_id: NEW, conductor_run_id: "run-earlier", name: "Harbor Yoga (copy)" };
    const other = setup({ done: { source: "dddddddd-0000-4000-8000-000000000009", key: "dup-key-12345", copy } });
    const out = await duplicateSite(input({ request_key: "dup-key-12345" }), other.deps);
    expect(out.conductor_run_id).toBe("run-new");
    const foreign = setup({ done: { source: SRC, key: "dup-key-12345", copy } });
    await expect(duplicateSite(input({ tenant_id: T2, request_key: "dup-key-12345" }), foreign.deps)).rejects.toMatchObject({ status: 404 });
  });

  it("a same-key request that finished while this one waited is found once the slot is held, and no second copy is made", async () => {
    const copy = { site_id: NEW, conductor_run_id: "run-earlier", name: "Harbor Yoga (copy)" };
    const { deps, calls } = setup({ done: { source: SRC, key: "dup-key-12345", copy }, doneAfterSlot: true });
    expect(await duplicateSite(input({ request_key: "dup-key-12345" }), deps)).toEqual(copy);
    expect(calls).toEqual(["acquire", `fail:${T1}`]);
  });

  it("passes the gates a new site does: the builder switch and the site backend", async () => {
    for (const [gate, status] of [["builder_off", 403], ["backend_unavailable", 503]] as const) {
      const { deps, calls } = setup({ gate });
      await expect(duplicateSite(input(), deps)).rejects.toMatchObject({ status });
      expect(calls).toEqual([]);
      expect(deps.readRepo).not.toHaveBeenCalled();
    }
  });

  it("a replay returns the finished copy even after the source is gone or building is switched off", async () => {
    const copy = { site_id: NEW, conductor_run_id: "run-earlier", name: "Harbor Yoga (copy)" };
    for (const opt of [{ source: { status: "deleted" as const } }, { gate: "builder_off" as const }]) {
      const { deps, calls } = setup({ ...opt, done: { source: SRC, key: "dup-key-12345", copy } });
      expect(await duplicateSite(input({ request_key: "dup-key-12345" }), deps)).toEqual(copy);
      expect(calls).toEqual([]);
    }
  });

  it("refuses a malformed request key", async () => {
    const { deps, calls } = setup();
    await expect(duplicateSite(input({ request_key: "x" }), deps)).rejects.toMatchObject({ status: 400, code: "bad_request_key" });
    expect(calls).toEqual([]);
  });

  it("keeps the request key on the copy's build node", async () => {
    const { deps, finished } = setup();
    await duplicateSite(input({ request_key: "dup-key-12345" }), deps);
    expect(finished[0]!.goal_graph[1]!.payload.duplicate_of).toEqual({ site_id: SRC, request_key: "dup-key-12345" });
  });

  it("copies the design in the look the source uses, sealed", async () => {
    const { deps, designCalls } = setup();
    await duplicateSite(input(), deps);
    const alt = designRow().chosen_direction;
    expect(designCalls).toEqual([`create:${NEW}`, `choose:${NEW}:${alt}`, `applied:${NEW}:${alt}`, `seal:${NEW}`]);
  });

  it("records a finished build with no agent run behind it, and never a deploy", async () => {
    const { deps, finished } = setup();
    await duplicateSite(input(), deps);
    expect(finished).toHaveLength(1);
    const graph = finished[0]!.goal_graph;
    expect(graph.map((n) => n.payload.stage)).toEqual(["provision", "build"]);
    expect(graph.every((n) => n.status === "done")).toBe(true);
    const build = graph[1]!;
    expect(build.payload.duplicate_of).toEqual({ site_id: SRC });
    expect(build.checkpoint).toMatchObject({ kind: "pushed", commit_sha: "c0ffee0000000000000000000000000000000000" });
    expect(build.payload.site_id).toBe(NEW);
  });

  it("refuses another workspace's site as not found, before taking a build slot or reading code", async () => {
    const { deps, calls } = setup();
    const other = "cccccccc-0000-4000-8000-000000000003";
    await expect(duplicateSite(input({ source_site_id: other }), deps)).rejects.toMatchObject({ status: 404, code: "site_not_found" });
    await expect(duplicateSite(input({ tenant_id: T2 }), deps)).rejects.toMatchObject({ status: 404 });
    expect(deps.readRepo).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("refuses a dedicated-database site, one not built yet, and one with no code", async () => {
    for (const source of [{ backend_mode: "dedicated" as const }, { supabase_project_ref: "abc" }, { status: "provisioning" as const }, { github_full_name: null }]) {
      const { deps, calls } = setup({ source });
      await expect(duplicateSite(input(), deps)).rejects.toBeInstanceOf(DuplicateRefused);
      expect(calls).toEqual([]);
    }
  });

  it("a failure after the site exists fails the run and deletes the half-made copy", async () => {
    const { deps, calls } = setup({ pushFails: true });
    await expect(duplicateSite(input(), deps)).rejects.toThrow("github down");
    expect(calls).toContain(`fail:${T1}`);
    expect(calls).toContain(`delete:${NEW}`);
    expect(calls).not.toContain("finish");
  });

  it("copies a site with no design row as code only", async () => {
    const { deps, designCalls, finished } = setup({ design: null });
    await duplicateSite(input(), deps);
    expect(designCalls).toEqual([]);
    expect(finished[0]!.goal_graph[1]!.payload.design_brief).toBeUndefined();
  });
});

describe("schedules come paused", () => {
  it("registers every declared schedule of the copy as paused, before the run finishes", async () => {
    const manifest = {
      functions: {
        endpoints: { checkout: { type: "http" } },
        schedules: { "daily-digest": { cron: "0 8 * * *" }, cleanup: { cron: "*/30 * * * *", asAdmin: true } },
      },
    };
    const { deps, calls } = setup({ manifest });
    await duplicateSite(input(), deps);
    const pause = calls.find((c) => c.startsWith("pause:"))!;
    expect(pause.split(":")[2]!.split(",").sort()).toEqual(["cleanup", "daily-digest"]);
    expect(calls.indexOf(pause)).toBeLessThan(calls.indexOf("finish"));
    const rows = (deps.pauseSchedules as ReturnType<typeof vi.fn>).mock.calls[0]![2] as PausedSchedule[];
    expect(rows.find((r) => r.name === "cleanup")).toMatchObject({ cron: "*/30 * * * *", data_access: "admin" });
    expect(rows.every((r) => !Number.isNaN(Date.parse(r.next_run_at)))).toBe(true);
  });

  it("pauses nothing for a site without schedules", async () => {
    const { deps } = setup({ manifest: { smoke: { journeys: [] } } });
    await duplicateSite(input(), deps);
    expect(deps.pauseSchedules).not.toHaveBeenCalled();
  });

  it("still pauses the schedules of a manifest the parser refuses today (it may be fixed and published later)", async () => {
    const manifest = { functions: { bogus: true, schedules: { nightly: { cron: "0 2 * * *" }, "Bad Name": { cron: "0 2 * * *" }, broken: { cron: "nope nope" } } } };
    const { deps } = setup({ manifest });
    await duplicateSite(input(), deps);
    const rows = (deps.pauseSchedules as ReturnType<typeof vi.fn>).mock.calls[0]![2] as PausedSchedule[];
    expect(rows.map((r) => r.name)).toEqual(["nightly"]);
  });

  it("a failed copy removes the schedule rows it registered", async () => {
    const manifest = { functions: { schedules: { nightly: { cron: "0 2 * * *" } } } };
    const { deps, calls } = setup({ manifest });
    (deps.finishRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("stopped"));
    await expect(duplicateSite(input(), deps)).rejects.toThrow("stopped");
    expect(calls.indexOf(`clear:${NEW}`)).toBeLessThan(calls.indexOf(`delete:${NEW}`));
  });
});

describe("filesForCopy", () => {
  it("refuses a repo past the limits, and one with nothing but env files", () => {
    const site = { label: "x", name: "X", hostname: "x.zaviagent.com" };
    const big = { files: new Map([["a.bin", "A".repeat(36 * 1024 * 1024)]]), modes: new Map<string, BlobMode>() };
    expect(() => filesForCopy(big, site, "")).toThrow(DuplicateRefused);
    const envOnly = { files: new Map([[".env", b64("x")]]), modes: new Map<string, BlobMode>() };
    expect(() => filesForCopy(envOnly, site, "")).toThrow(DuplicateRefused);
  });
});

describe("copyName", () => {
  it("names the copy after the source", () => {
    expect(copyName({ label: "harbor-yoga-1", name: "Harbor Yoga" })).toBe("Harbor Yoga (copy)");
    expect(copyName({ label: "ledgerly-abc", name: null })).toMatch(/\(copy\)$/);
  });
});
