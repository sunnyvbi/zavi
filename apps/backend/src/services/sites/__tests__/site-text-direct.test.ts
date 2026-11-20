import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SiteRow, SiteSandbox } from "../contract";
import type { SiteEditRow } from "../site-inline-edits";
import {
  directEditSummary,
  applySiteTextEditsDirect,
  directTextRow,
  normalizeCopy,
  planTextEdits,
  textSitesOf,
  type DirectTextDeps,
} from "../site-text-direct";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";
const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const REPO = "praxis-build/lucky-bakery";
const HEAD = "a".repeat(40);
const APP = `site:${SITE_ID}`;

const APP_TSX = `import { Hero } from "./Hero";

const items = [
  { title: "Sourdough loaf", note: 'Mom\\'s recipe' },
  { title: "Rye bread", note: "Dark and dense" },
];

export default function App() {
  return (
    <main>
      <h1 className="hero">
        Fresh bread daily
      </h1>
      <p>Tom &amp; Jerry&apos;s bakery</p>
      <Hero heading="Baked with love" />
      <span>Order now</span>
      <span>Order now</span>
      <ul>{items.map((i) => <li key={i.title}>{i.title} {i.note}</li>)}</ul>
    </main>
  );
}
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>Lucky Bakery</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const MENU_JSON = `{ "special": "Seeded spelt" }`;

const SITE: SiteRow = {
  id: SITE_ID,
  tenant_id: T,
  root_conductor_run_id: "cccccccc-0000-4000-8000-000000000003",
  started_by_user_id: null,
  owner_email: null,
  label: "lucky",
  hostname: "lucky.zavi.site",
  github_full_name: REPO,
  supabase_project_ref: null,
  supabase_url: null,
  status: "live",
  live_url: null,
  desired_sha: null,
  live_sha: null,
  live_deploy_id: null,
  last_visit_at: null,
  last_edit_at: null,
  paused_at: null,
  last_error: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

let dir = "";
const initial: Record<string, string> = {};

function put(rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  initial[rel] = content;
}

function read(rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}

function localSandbox(calls: string[]): SiteSandbox {
  return {
    async run(cmd) {
      calls.push(cmd);
      const r = spawnSync("bash", ["-c", `(set -e; ${cmd}\n)`], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    async readFile(p) {
      return readFileSync(join(dir, p));
    },
    async listFiles() {
      return [];
    },
  };
}

let clock = 0;
function row(before: string, text: string, over: Partial<SiteEditRow> = {}): SiteEditRow {
  clock += 1;
  return {
    id: `e${clock}`,
    selector: `p.n${clock}`,
    patch: { text, before: { text: before } },
    removed: false,
    updated_at: new Date(Date.UTC(2026, 9, 7, 10, 0, clock)).toISOString(),
    ...over,
  };
}

function harness(over: Partial<DirectTextDeps> = {}) {
  const calls: string[] = [];
  const released = vi.fn(async () => undefined);
  const commits: Array<Parameters<DirectTextDeps["commit"]>[0]> = [];
  const cleared: Array<{ app: string; rows: unknown }> = [];
  const recorded: unknown[] = [];
  const deps: DirectTextDeps = {
    claimLease: vi.fn(async () => ({ release: released })),
    hasActiveBuild: vi.fn(async () => false),
    sandboxFor: vi.fn(async (tid: string, sid: string) => (tid === T && sid === SITE_ID ? localSandbox(calls) : null)),
    repoGate: vi.fn(async () => ({ ok: true, site_id: SITE_ID })),
    installation: vi.fn(async () => -1),
    mainHead: vi.fn(async () => HEAD),
    readMainFile: vi.fn(async (a) => (a.sha === HEAD ? initial[a.path] ?? null : null)),
    commit: vi.fn(async (a) => {
      commits.push(a);
      return { commit_sha: "b".repeat(40) };
    }),
    reserveChange: vi.fn(async (input) => {
      recorded.push({ reserve: input });
    }),
    finishChange: vi.fn(async (input) => {
      recorded.push({ finish: input });
    }),
    dropChange: vi.fn(async (input) => {
      recorded.push({ drop: input });
    }),
    clearRows: vi.fn(async (_tid, app, rows) => {
      cleared.push({ app, rows });
      return { cleared: rows.length };
    }),
    log: () => undefined,
    ...over,
  };
  return { deps, calls, released, commits, cleared, recorded };
}

const label = (n: number) => (n === 1 ? "Applied 1 edit" : `Applied ${n} edits`);

function apply(rows: SiteEditRow[], deps: DirectTextDeps, site: SiteRow = SITE, tenant_id = T) {
  return applySiteTextEditsDirect({ tenant_id, site, app_id: APP, rows, label }, deps);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zavi-text-direct-"));
  for (const k of Object.keys(initial)) delete initial[k];
  put("src/App.tsx", APP_TSX);
  put("index.html", INDEX_HTML);
  put("public/menu.json", MENU_JSON);
  mkdirSync(join(dir, "canary"));
  writeFileSync(join(dir, "canary", "keep.txt"), "still here");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["remote", "add", "origin", `https://github.com/${REPO}.git`], { cwd: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("direct text apply: the edit lands in the source in one pass, committed and cleared", () => {
  it("starts the repo check early, then checks the build after the lease, while GitHub and sandbox reads overlap", async () => {
    const order: string[] = [];
    let releaseBuild!: () => void;
    const buildGate = new Promise<void>((r) => (releaseBuild = r));
    const base = harness();
    const h = harness({
      hasActiveBuild: vi.fn(async () => {
        order.push("build:start");
        await buildGate;
        order.push("build:end");
        return false;
      }),
      repoGate: vi.fn(async () => {
        order.push("gate:start");
        return { ok: true, site_id: SITE_ID };
      }),
      sandboxFor: vi.fn(async () => {
        const sb = localSandbox(base.calls);
        return {
          ...sb,
          async run(cmd: string, opts?: unknown) {
            order.push("sandbox:run");
            await new Promise((r) => setTimeout(r, 30));
            const out = await (sb.run as (c: string, o?: unknown) => ReturnType<SiteSandbox["run"]>)(cmd, opts);
            order.push("sandbox:done");
            return out;
          },
        } as SiteSandbox;
      }),
      installation: vi.fn(async () => {
        order.push("installation");
        return -1;
      }),
    });
    const p = apply([row("Fresh bread daily", "Warm loaves every morning")], h.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["gate:start", "build:start"]);
    releaseBuild();
    const res = await p;
    expect(res.reason).toBeNull();
    expect(order.slice(0, 3)).toEqual(["gate:start", "build:start", "build:end"]);
    expect(order.indexOf("installation")).toBeGreaterThan(-1);
    expect(order.indexOf("installation")).toBeLessThan(order.indexOf("sandbox:done"));
  });

  it("checks for an active build only after the edit lease is held", async () => {
    const order: string[] = [];
    let grantLease!: () => void;
    const leaseGate = new Promise<void>((r) => (grantLease = r));
    const released = vi.fn(async () => undefined);
    const h = harness({
      claimLease: vi.fn(async () => {
        order.push("lease:start");
        await leaseGate;
        order.push("lease:held");
        return { release: released };
      }),
      hasActiveBuild: vi.fn(async () => {
        order.push("build");
        return false;
      }),
      repoGate: vi.fn(async () => {
        order.push("gate");
        return { ok: true, site_id: SITE_ID };
      }),
    });
    const p = apply([row("Fresh bread daily", "Warm loaves every morning")], h.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["lease:start", "gate"]);
    expect(h.deps.sandboxFor).not.toHaveBeenCalled();
    expect(h.commits).toHaveLength(0);
    expect(read("src/App.tsx")).toBe(APP_TSX);
    grantLease();
    const res = await p;
    expect(res.reason).toBeNull();
    expect(order.indexOf("build")).toBeGreaterThan(order.indexOf("lease:held"));
    expect(h.commits).toHaveLength(1);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("a lease another apply holds still refuses, even though the checks already ran", async () => {
    const h = harness({ claimLease: vi.fn(async () => ({ held: "unknown" as const })) });
    const res = await apply([row("Fresh bread daily", "Warm loaves every morning")], h.deps);
    expect(res.reason).toBe("lease_held");
    expect(h.deps.sandboxFor).not.toHaveBeenCalled();
    expect(h.commits).toHaveLength(0);
    expect(read("src/App.tsx")).toBe(APP_TSX);
  });

  it("replaces a single JSX text match, keeps its layout, commits on the read main HEAD and clears only that draft", async () => {
    const h = harness();
    const r1 = row("Fresh bread daily", "Warm loaves every morning");
    const res = await apply([r1], h.deps);
    const id = (h.recorded[0] as { reserve: { id: string } }).reserve.id;
    expect(res).toMatchObject({ reason: null, conductor_run_id: id });
    expect(res.applied.map((r) => r.id)).toEqual([r1.id]);
    expect(res.fallback).toEqual([]);
    const after = read("src/App.tsx");
    expect(after).toContain(`<h1 className="hero">\n        Warm loaves every morning\n      </h1>`);
    expect(after.replace("Warm loaves every morning", "Fresh bread daily")).toBe(APP_TSX);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]).toMatchObject({ expected_parent_sha: HEAD, owner: "praxis-build", repo: "lucky-bakery", message: "Applied 1 edit" });
    expect(h.commits[0].files).toEqual([{ path: "src/App.tsx", action: "modify", content: after }]);
    expect(h.cleared).toEqual([{ app: APP, rows: [{ id: r1.id, updated_at: r1.updated_at }] }]);
    expect(h.recorded).toEqual([
      { reserve: { tenant_id: T, id, site: SITE, label: "Applied 1 edit", summary: 'Changed "Fresh bread daily" to "Warm loaves every morning"' } },
      { finish: { tenant_id: T, id, site: SITE, label: "Applied 1 edit", summary: 'Changed "Fresh bread daily" to "Warm loaves every morning"', commit_sha: "b".repeat(40) } },
    ]);
    expect((h.deps.reserveChange as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!).toBeLessThan(
      (h.deps.commit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(h.released).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(2);
  });

  it("a reserve retried after a lost answer reuses the same record id (no duplicate in Publish)", async () => {
    const ids: string[] = [];
    const h = harness({
      reserveChange: vi.fn(async (input: { id: string }) => {
        ids.push(input.id);
        if (ids.length === 1) throw new Error("connection reset");
      }),
    });
    const res = await apply([row("Fresh bread daily", "Warm loaves every morning")], h.deps);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(res).toMatchObject({ reason: null, conductor_run_id: ids[0] });
  });

  it("no change record, no commit: the edit is not reported as applied and goes to the AI edit", async () => {
    const h = harness({ reserveChange: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const r1 = row("Fresh bread daily", "Warm loaves every morning");
    const res = await apply([r1], h.deps);
    expect(res).toMatchObject({ applied: [], reason: "record_failed", conductor_run_id: null });
    expect(h.deps.dropChange).toHaveBeenCalled();
    expect(res.fallback).toEqual([r1]);
    expect(h.commits).toHaveLength(0);
    expect(read("src/App.tsx")).toBe(APP_TSX);
    expect(h.cleared).toEqual([]);
  });

  it("a stamp that never lands keeps the edit listed and raises one alert", async () => {
    const alert = vi.fn();
    const h = harness({ finishChange: vi.fn(async () => Promise.reject(new Error("timeout"))), alert });
    const res = await apply([row("Fresh bread daily", "Warm loaves every morning")], h.deps);
    expect(res).toMatchObject({ reason: null });
    expect(res.conductor_run_id).toEqual(expect.any(String));
    expect(h.deps.finishChange).toHaveBeenCalledTimes(3);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("edits a string literal in a data array", async () => {
    const h = harness();
    const res = await apply([row("Rye bread", "Dark rye")], h.deps);
    expect(res.applied).toHaveLength(1);
    expect(read("src/App.tsx")).toContain(`{ title: "Dark rye", note: "Dark and dense" }`);
  });

  it("edits the index.html title, escaping the ampersand for HTML", async () => {
    const h = harness();
    const res = await apply([row("Lucky Bakery", "Lucky Bakery & Cafe <2>")], h.deps);
    expect(res.applied).toHaveLength(1);
    expect(read("index.html")).toContain("<title>Lucky Bakery &amp; Cafe &lt;2&gt;</title>");
    expect(read("src/App.tsx")).toBe(APP_TSX);
  });

  it("matches entity-encoded JSX text and writes apostrophes, ampersands, quotes and braces safely", async () => {
    const h = harness();
    const res = await apply([row("Tom & Jerry's bakery", `Tom & Jerry's "best" {bakery}`)], h.deps);
    expect(res.applied).toHaveLength(1);
    const after = read("src/App.tsx");
    expect(after).toContain(`<p>Tom &amp; Jerry&apos;s "best" &#123;bakery&#125;</p>`);
    const values = (textSitesOf("src/App.tsx", after) ?? []).map((s) => s.value);
    expect(values).toContain(`Tom & Jerry's "best" {bakery}`);
  });

  it("re-escapes a single-quoted string literal and a JSX attribute string", async () => {
    const h = harness();
    const res = await apply(
      [row("Mom's recipe", `Mom's "secret" recipe`), row("Baked with love", `Baked "fresh" & warm`)],
      h.deps,
    );
    expect(res.applied).toHaveLength(2);
    const after = read("src/App.tsx");
    expect(after).toContain(`note: 'Mom\\'s "secret" recipe'`);
    expect(after).toContain(`<Hero heading="Baked &quot;fresh&quot; &amp; warm" />`);
    const values = (textSitesOf("src/App.tsx", after) ?? []).map((s) => s.value);
    expect(values).toEqual(expect.arrayContaining([`Mom's "secret" recipe`, `Baked "fresh" & warm`]));
    expect(h.commits).toHaveLength(1);
    expect(h.cleared[0].rows).toHaveLength(2);
  });

  it("a shell payload in the text is written as text and never runs", async () => {
    const h = harness();
    const payload = `"; rm -rf ./canary # $(touch PWNED1) \`touch PWNED2\` '; touch PWNED3 '`;
    const res = await apply([row("Fresh bread daily", payload)], h.deps);
    expect(res.applied).toHaveLength(1);
    expect(existsSync(join(dir, "canary", "keep.txt"))).toBe(true);
    for (const f of ["PWNED1", "PWNED2", "PWNED3"]) expect(existsSync(join(dir, f))).toBe(false);
    const values = (textSitesOf("src/App.tsx", read("src/App.tsx")) ?? []).map((s) => s.value);
    expect(values).toContain(normalizeCopy(payload));
    for (const cmd of h.calls) expect(cmd).not.toContain("touch PWNED");
  });
});

describe("direct text apply falls back to the AI edit for exactly the rows it cannot place", () => {
  it("0 matches: nothing written, nothing committed, the row goes to the refine", async () => {
    const h = harness();
    const r1 = row("Not on the page anywhere", "x y");
    const res = await apply([r1], h.deps);
    expect(res.applied).toEqual([]);
    expect(res.fallback).toEqual([r1]);
    expect(res.reason).toBe("no_match");
    expect(read("src/App.tsx")).toBe(APP_TSX);
    expect(h.commits).toEqual([]);
    expect(h.cleared).toEqual([]);
  });

  it("2 matches: falls back, and a placeable row in the same batch still lands alone", async () => {
    const h = harness();
    const dup = row("Order now", "Buy now");
    const ok = row("Fresh bread daily", "Hot bread");
    const res = await apply([dup, ok], h.deps);
    expect(res.applied.map((r) => r.id)).toEqual([ok.id]);
    expect(res.fallback).toEqual([dup]);
    expect(read("src/App.tsx").match(/Order now/g)).toHaveLength(2);
    expect(h.cleared[0].rows).toEqual([{ id: ok.id, updated_at: ok.updated_at }]);
  });

  it("text that also sits in a file the matcher cannot edit (public JSON) is ambiguous: falls back", async () => {
    const h = harness();
    put("src/Special.tsx", `export const S = () => <b>Seeded spelt</b>;\n`);
    const res = await apply([row("Seeded spelt", "Spelt")], h.deps);
    expect(res.applied).toEqual([]);
    expect(res.reason).toBe("ambiguous");
    expect(read("src/Special.tsx")).toContain("Seeded spelt");
  });

  it("a change the copy gate rejects is never written or committed", async () => {
    const h = harness({ gate: () => ({ ok: false }) });
    const r1 = row("Fresh bread daily", "Hot bread");
    const res = await apply([r1], h.deps);
    expect(res.reason).toBe("not_copy");
    expect(res.fallback).toEqual([r1]);
    expect(read("src/App.tsx")).toBe(APP_TSX);
    expect(h.commits).toEqual([]);
  });

  it("sandbox unavailable (null or throwing): falls back without touching GitHub", async () => {
    for (const sandboxFor of [vi.fn(async () => null), vi.fn(async () => { throw new Error("e2b down"); })]) {
      const h = harness({ sandboxFor });
      const res = await apply([row("Fresh bread daily", "Hot bread")], h.deps);
      expect(res.reason).toBe("sandbox_unavailable");
      expect(h.deps.mainHead).not.toHaveBeenCalled();
      expect(h.commits).toEqual([]);
      expect(h.released).toHaveBeenCalledTimes(1);
    }
  });

  it("persist failure: the sandbox file is put back byte for byte and every row falls back", async () => {
    const h = harness({ commit: vi.fn(async () => { throw new Error("commit-to-branch: main moved under us (422)"); }) });
    const r1 = row("Fresh bread daily", "Hot bread");
    const res = await apply([r1], h.deps);
    expect(res.reason).toBe("persist_failed");
    expect(res.fallback).toEqual([r1]);
    expect(read("src/App.tsx")).toBe(APP_TSX);
    expect(h.cleared).toEqual([]);
    expect(h.recorded).toEqual([{ reserve: expect.anything() }, { drop: { tenant_id: T, id: (h.recorded[0] as { reserve: { id: string } }).reserve.id } }]);
    expect(h.calls).toHaveLength(3);
  });

  it("the sandbox file differs from main (an unpushed or newer change): falls back, no write", async () => {
    const h = harness({ readMainFile: vi.fn(async () => APP_TSX.replace("Rye bread", "Rye")) });
    const res = await apply([row("Fresh bread daily", "Hot bread")], h.deps);
    expect(res.reason).toBe("behind_main");
    expect(read("src/App.tsx")).toBe(APP_TSX);
    expect(h.commits).toEqual([]);
  });

  it("a sandbox tree wired to another repo is never edited", async () => {
    spawnSync("git", ["remote", "set-url", "origin", "https://github.com/praxis-build/someone-else.git"], { cwd: dir });
    const h = harness();
    const res = await apply([row("Fresh bread daily", "Hot bread")], h.deps);
    expect(res.reason).toBe("foreign_tree");
    expect(read("src/App.tsx")).toBe(APP_TSX);
  });

  it("another tenant's site, or a repo gate naming another site, is refused before the sandbox", async () => {
    const h = harness();
    const foreign = await apply([row("Fresh bread daily", "Hot bread")], h.deps, SITE, OTHER_T);
    expect(foreign.reason).toBe("not_your_site");
    const h2 = harness({ repoGate: vi.fn(async () => ({ ok: true, site_id: "bbbbbbbb-0000-4000-8000-000000000002" })) });
    const other = await apply([row("Fresh bread daily", "Hot bread")], h2.deps);
    expect(other.reason).toBe("repo_gate");
    expect(h.deps.sandboxFor).not.toHaveBeenCalled();
    expect(h2.deps.sandboxFor).not.toHaveBeenCalled();
    expect(read("src/App.tsx")).toBe(APP_TSX);
  });

  it("a preview that is waking or restarting says so, not that another change is running", async () => {
    for (const held of ["wake", "restart"] as const) {
      const h = harness({ claimLease: vi.fn(async () => ({ held })) });
      expect((await apply([row("Fresh bread daily", "Hot bread")], h.deps)).reason).toBe("preview_starting");
    }
    expect(read("src/App.tsx")).toBe(APP_TSX);
  });

  it("a held site lease or a running build sends everything to the refine", async () => {
    const held = harness({ claimLease: vi.fn(async () => ({ held: "edit" as const })) });
    expect((await apply([row("Fresh bread daily", "Hot bread")], held.deps)).reason).toBe("lease_held");
    const busy = harness({ hasActiveBuild: vi.fn(async () => true) });
    expect((await apply([row("Fresh bread daily", "Hot bread")], busy.deps)).reason).toBe("build_active");
    expect(busy.released).toHaveBeenCalledTimes(1);
    expect(read("src/App.tsx")).toBe(APP_TSX);
  });

  it("style, link, removal and mixed rows never take the direct path", async () => {
    const h = harness();
    const style = row("Fresh bread daily", "Fresh bread daily", { patch: { style: { color: "#f00" }, before: { style: { color: "#000" } } } });
    const removal = row("Rye bread", "", { removed: true, patch: {} });
    const mixed = row("Fresh bread daily", "Hot", { patch: { text: "Hot", style: { color: "#f00" }, before: { text: "Fresh bread daily" } } });
    const res = await apply([style, removal, mixed], h.deps);
    expect(res.reason).toBe("no_text_rows");
    expect(res.fallback).toEqual([style, removal, mixed]);
    expect(h.deps.claimLease).not.toHaveBeenCalled();
  });
});

describe("directEditSummary: the words that changed, in plain English", () => {
  const row = (before: string, text: string) => ({ before, text });

  it("one edit: before and after, quoted", () => {
    expect(directEditSummary([row("Fresh bread daily", "Warm loaves every morning")])).toBe('Changed "Fresh bread daily" to "Warm loaves every morning"');
  });

  it("several edits are listed, long text is cut, whitespace is folded, and the rest is counted", () => {
    const long = "Slow-fermented sourdough, buttery croissants and custom cakes, made by hand for the families around us.";
    const out = directEditSummary([row("A", "B"), row("C  \n D", "E"), row(long, "Short"), row("F", "G"), row("H", "I")]);
    expect(out).toBe('Changed "A" to "B", "C D" to "E" and "Slow-fermented sourdough, buttery croissants and custom cak…" to "Short", and 2 more');
    expect(out!.length).toBeLessThan(280);
  });

  it("an edit that changed nothing, or no edits at all, gives no summary", () => {
    expect(directEditSummary([row("Same", " Same ")])).toBeNull();
    expect(directEditSummary([])).toBeNull();
  });
});

describe("the pure planner", () => {
  const rowsOf = (...pairs: Array<[string, string]>) => pairs.map(([b, t]) => directTextRow(row(b, t))!);

  it("two drafts aimed at the same element both fall back", () => {
    const plan = planTextEdits(rowsOf(["Fresh bread daily", "A"], ["Fresh  bread\ndaily", "B"]), [{ path: "src/App.tsx", content: APP_TSX }]);
    expect(plan.files).toEqual([]);
    expect(plan.failed.map((f) => f.reason)).toEqual(["same_element", "same_element"]);
  });

  it("a match in a path outside src/ and index.html is never edited", () => {
    const plan = planTextEdits(rowsOf(["Fresh bread daily", "A"]), [{ path: "scripts/App.tsx", content: APP_TSX }]);
    expect(plan.failed.map((f) => f.reason)).toEqual(["unsafe_path"]);
  });

  it("a file that does not parse and holds the text makes the row ambiguous", () => {
    const plan = planTextEdits(rowsOf(["Fresh bread daily", "A"]), [
      { path: "src/App.tsx", content: APP_TSX },
      { path: "src/Broken.tsx", content: "export const X = () => <p>Fresh bread daily</p" },
    ]);
    expect(plan.failed.map((f) => f.reason)).toEqual(["unreadable_source"]);
  });

  it("the same words in two places: the element the founder clicked, named by its selector, is the one edited", () => {
    const src = [
      'export const Page = () => (',
      "  <div>",
      "    <header><nav><a href=\"/menu\">Menu</a><a href=\"/order\">Order now</a></nav></header>",
      "    <main><section><div><div><a href=\"/order\">Order now</a><a href=\"/breads\">See our breads</a></div></div></section></main>",
      "  </div>",
      ");",
      "",
    ].join("\n");
    const hero = directTextRow(row("Order now", "Order today", { selector: "main > section > div > div > a:nth-of-type(1)" }))!;
    const plan = planTextEdits([hero], [{ path: "src/Page.tsx", content: src }]);
    expect(plan.failed).toEqual([]);
    expect(plan.files[0]!.after).toContain('<header><nav><a href="/menu">Menu</a><a href="/order">Order now</a></nav></header>');
    expect(plan.files[0]!.after).toContain('<main><section><div><div><a href="/order">Order today</a>');
    const header = directTextRow(row("Order now", "Order here", { selector: "header > nav > a:nth-of-type(2)" }))!;
    const plan2 = planTextEdits([header], [{ path: "src/Page.tsx", content: src }]);
    expect(plan2.failed).toEqual([]);
    expect(plan2.files[0]!.after).toContain('<nav><a href="/menu">Menu</a><a href="/order">Order here</a></nav>');
    expect(plan2.files[0]!.after).toContain('<div><div><a href="/order">Order now</a>');
  });

  it("the same words in two places the selector cannot tell apart still fall back", () => {
    const src = "export const L = () => <ul><li><a>More</a></li><li><a>More</a></li></ul>;\n";
    const plan = planTextEdits([directTextRow(row("More", "Less", { selector: "ul > li > a" }))!], [{ path: "src/L.tsx", content: src }]);
    expect(plan.files).toEqual([]);
    expect(plan.failed.map((f) => f.reason)).toEqual(["many_matches"]);
    const byId = planTextEdits([directTextRow(row("Order now", "X", { selector: "#cta" }))!], [
      { path: "src/P.tsx", content: "export const P = () => <div><a>Order now</a><p>Order now</p></div>;\n" },
    ]);
    expect(byId.failed.map((f) => f.reason)).toEqual(["many_matches"]);
    const oneTag = planTextEdits([directTextRow(row("Order now", "X", { selector: "header > nav > a" }))!], [
      { path: "src/N.tsx", content: 'const links = ["Order now"];\nexport const N = () => <main><section><a>Order now</a>{links.map((l) => <b key={l}>{l}</b>)}</section></main>;\n' },
    ]);
    expect(oneTag.failed.map((f) => f.reason)).toEqual(["many_matches"]);
  });

  it("a selector whose tag chain is only partly found in the source never picks a place, and the clicked element's position among its siblings must agree", () => {
    const src = "export const P = () => <div><nav><a>Home</a><a>Order now</a></nav><section><a>Order now</a></section></div>;\n";
    const files = [{ path: "src/P.tsx", content: src }];
    const second = planTextEdits([directTextRow(row("Order now", "Order today", { selector: "nav > a:nth-of-type(2)" }))!], files);
    expect(second.failed).toEqual([]);
    expect(second.files[0]!.after).toContain("<nav><a>Home</a><a>Order today</a></nav><section><a>Order now</a></section>");
    const first = planTextEdits([directTextRow(row("Order now", "X", { selector: "nav > a:nth-of-type(1)" }))!], files);
    expect(first.failed.map((f) => f.reason)).toEqual(["many_matches"]);
    const partial = planTextEdits([directTextRow(row("Order now", "X", { selector: "main > div > section > a" }))!], files);
    expect(partial.failed.map((f) => f.reason)).toEqual(["many_matches"]);
    const mapped = "export const L = () => <div><nav>{[\"Home\", \"Order now\"].map((t) => <a key={t}>{t}</a>)}</nav><section><a>Order now</a></section></div>;\n";
    const lone = planTextEdits([directTextRow(row("Order now", "X", { selector: "section > a" }))!], [{ path: "src/L.tsx", content: mapped }]);
    expect(lone.failed).toEqual([]);
    expect(lone.files[0]!.after).toContain("<section><a>X</a></section>");
  });

  it("a hit whose source sits inside a custom component makes the whole edit ambiguous, since its rendered ancestry is unknown", () => {
    const src = 'export const P = () => <main><section><Button label="Save" />{open && <section><button>Save</button></section>}</section></main>;\n';
    const plan = planTextEdits([directTextRow(row("Save", "Keep", { selector: "main > section > button" }))!], [{ path: "src/P.tsx", content: src }]);
    expect(plan.files).toEqual([]);
    expect(plan.failed.map((f) => f.reason)).toEqual(["many_matches"]);
  });

  it("nth-of-type never lands on a link rendered behind a condition, whose position on the page is unknown", () => {
    const src = "export const P = ({ cond }: { cond: boolean }) => <main>{cond && <a>Order now</a>}<a>Order now</a></main>;\n";
    const files = [{ path: "src/P.tsx", content: src }];
    for (const nth of [1, 2]) {
      const plan = planTextEdits([directTextRow(row("Order now", "Order today", { selector: `main > a:nth-of-type(${nth})` }))!], files);
      expect(plan.files).toEqual([]);
      expect(plan.failed.map((f) => f.reason)).toEqual(["many_matches"]);
    }
    const onlyHidden = "export const H = ({ cond }: { cond: boolean }) => <div><main>{cond && <a>Order now</a>}<a>Menu</a></main><footer><a>Order now</a></footer></div>;\n";
    const hidden = planTextEdits([directTextRow(row("Order now", "X", { selector: "main > a:nth-of-type(2)" }))!], [{ path: "src/H.tsx", content: onlyHidden }]);
    expect(hidden.files).toEqual([]);
    expect(hidden.failed.map((f) => f.reason)).toEqual(["many_matches"]);
    const fragment = "export const F = () => <main><><a>Order now</a></><a>Order now</a></main>;\n";
    const viaFragment = planTextEdits([directTextRow(row("Order now", "X", { selector: "main > a:nth-of-type(2)" }))!], [{ path: "src/F.tsx", content: fragment }]);
    expect(viaFragment.files).toEqual([]);
    const ternary = "export const T = ({ on }: { on: boolean }) => <nav>{on ? <a>Menu</a> : null}<a>Menu</a><a>Order now</a></nav>;\n";
    const viaTernary = planTextEdits([directTextRow(row("Menu", "X", { selector: "nav > a:nth-of-type(1)" }))!], [{ path: "src/T.tsx", content: ternary }]);
    expect(viaTernary.files).toEqual([]);
  });

  it("a condition that renders a different tag, or plain text, leaves nth-of-type exact", () => {
    const src = "export const P = ({ cond, name }: { cond: boolean; name: string }) => <div><nav>{cond && <span>New</span>}{name}<a>Home</a><a>Order now</a></nav><section><a>Order now</a></section></div>;\n";
    const plan = planTextEdits([directTextRow(row("Order now", "Order today", { selector: "nav > a:nth-of-type(2)" }))!], [{ path: "src/P.tsx", content: src }]);
    expect(plan.failed).toEqual([]);
    expect(plan.files[0]!.after).toContain("<a>Home</a><a>Order today</a></nav><section><a>Order now</a></section>");
  });

  it("nth-of-type on an ancestor tells two matching containers apart", () => {
    const src = "export const P = () => <main><section><a>Order now</a></section><section><a>Order now</a></section></main>;\n";
    const plan = planTextEdits([directTextRow(row("Order now", "Order today", { selector: "main > section:nth-of-type(2) > a" }))!], [{ path: "src/P.tsx", content: src }]);
    expect(plan.failed).toEqual([]);
    expect(plan.files[0]!.after).toContain("<section><a>Order now</a></section><section><a>Order today</a></section>");
    const none = planTextEdits([directTextRow(row("Order now", "X", { selector: "main > section > a" }))!], [{ path: "src/P.tsx", content: src }]);
    expect(none.failed.map((f) => f.reason)).toEqual(["many_matches"]);
  });

  it("the same words in two places of a plain HTML page are told apart the same way", () => {
    const src = "<html><body><header><a>Order now</a></header><main><section><a>Order now</a></section></main></body></html>";
    const plan = planTextEdits([directTextRow(row("Order now", "Order today", { selector: "main > section > a" }))!], [{ path: "index.html", content: src }]);
    expect(plan.failed).toEqual([]);
    expect(plan.files[0]!.after).toBe("<html><body><header><a>Order now</a></header><main><section><a>Order today</a></section></main></body></html>");
  });

  it("import paths, object keys and directives are never treated as copy", () => {
    const src = `"use client";\nimport x from "Hero";\nconst o = { "Hero": 1 };\nexport const Y = () => <p>{o.Hero}{x}</p>;\n`;
    const plan = planTextEdits(rowsOf(["Hero", "Villain"], ["use client", "x"]), [{ path: "src/Y.tsx", content: src }]);
    expect(plan.files).toEqual([]);
    expect(plan.failed.map((f) => f.reason)).toEqual(["no_match", "no_match"]);
  });
});
