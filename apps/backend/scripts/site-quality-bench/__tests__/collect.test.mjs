import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureSite, deriveRunMetrics, readRunFromDb, requirementCoverage, CONDUCTOR_COLUMNS, ATTEMPT_COLUMNS } from "../lib/collect.mjs";
import { serveStatic } from "../lib/serve.mjs";
import { pngSize, solidPng } from "../lib/png.mjs";
import { findBrief, loadBriefs, MOCK_DIR } from "../lib/io.mjs";
import { run, UsageError } from "../bench.mjs";
import { HAS_BROWSER, PLAYWRIGHT_MODULE, browserAvailable, captureOut, grepDir, tmp } from "./helpers.mjs";

const briefs = loadBriefs();
const NOW = () => new Date("2026-10-07T12:00:00.000Z");

const RUN = {
  id: "11111111-2222-3333-4444-555555555555",
  tenant_id: "t-1",
  status: "done",
  created_at: "2026-10-07T10:00:00.000Z",
  updated_at: "2026-10-07T11:30:00.000Z",
  first_preview_at: "2026-10-07T10:01:30.000Z",
  failure_reason: null,
};
const ATTEMPTS = [
  { id: "a1", stage: "spec", status: "done", finished_at: "2026-10-07T10:02:00.000Z", cost_usd: "0.40" },
  { id: "a2", stage: "build", status: "failed", error: "tsc exited 2", finished_at: "2026-10-07T10:09:00.000Z", cost_usd: 1.1 },
  { id: "a3", stage: "build", status: "done", finished_at: "2026-10-07T10:15:00.000Z", cost_usd: 0.9 },
  { id: "a4", stage: "build", status: "done", finished_at: "2026-10-07T10:20:00.000Z", cost_usd: null },
  { id: "a5", stage: "deploy", status: "done", finished_at: "2026-10-07T10:25:30.000Z", cost_usd: 0 },
];

function fakeDb(run = RUN, attempts = ATTEMPTS) {
  const calls = [];
  const builder = (table) => {
    const q = { table, ops: [] };
    calls.push(q);
    const chain = new Proxy(
      {},
      {
        get(_, op) {
          if (op === "then") {
            const data = table === "conductor_runs" ? (q.ops.some(([o, c, v]) => o === "eq" && c === "id" && v === run.id) ? [run] : []) : attempts;
            return (ok) => ok({ data, error: null });
          }
          return (...args) => {
            q.ops.push([op, ...args]);
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { calls, from: builder };
}

describe("deriveRunMetrics", () => {
  it("derives preview and completion seconds, summed cost, per-stage repairs and failures", () => {
    const m = deriveRunMetrics(RUN, ATTEMPTS);
    expect(m.timings).toEqual({ to_first_preview_s: 90, to_usable_complete_s: 1530 });
    expect(m.cost).toEqual({ usd: 2.4, source: "agent_runs.cost_usd sum over 4 attempts" });
    expect(m.repairs).toBe(2);
    expect(m.failures).toEqual(["build: tsc exited 2"]);
  });

  it("a failed run has no usable-complete time and carries the run's reason", () => {
    const m = deriveRunMetrics({ ...RUN, status: "failed", first_preview_at: null, failure_reason: "deploy never reached a live state" }, ATTEMPTS.slice(0, 1));
    expect(m.timings).toEqual({ to_first_preview_s: null, to_usable_complete_s: null });
    expect(m.failures).toEqual(["run failed: deploy never reached a live state"]);
    expect(m.repairs).toBe(0);
  });

  it("no attempts means unknown cost and repairs, never zero", () => {
    const m = deriveRunMetrics(RUN, []);
    expect(m.cost.usd).toBeNull();
    expect(m.repairs).toBeNull();
    expect(m.timings.to_usable_complete_s).toBe(5400);
  });
});

describe("readRunFromDb", () => {
  it("only selects, with the same filters build-status.mjs uses", async () => {
    const db = fakeDb();
    const { run: r, attempts } = await readRunFromDb(db, RUN.id);
    expect(r).toBe(RUN);
    expect(attempts).toBe(ATTEMPTS);
    const ops = db.calls.flatMap((c) => c.ops.map(([o]) => o));
    expect(ops.filter((o) => !["select", "eq", "gte", "order", "limit"].includes(o))).toEqual([]);
    expect(db.calls[0].ops).toContainEqual(["select", CONDUCTOR_COLUMNS]);
    expect(db.calls[1].table).toBe("agent_runs");
    expect(db.calls[1].ops).toEqual(
      expect.arrayContaining([
        ["select", ATTEMPT_COLUMNS],
        ["eq", "tenant_id", "t-1"],
        ["eq", "payload->>build_conductor_run_id", RUN.id],
        ["gte", "enqueued_at", RUN.created_at],
      ]),
    );
  });

  it("throws for an unknown run", async () => {
    await expect(readRunFromDb(fakeDb(), "nope")).rejects.toThrow(/conductor run nope not found/);
  });
});

describe("requirementCoverage", () => {
  it("honours match_all and marks text-free requirements unverified", () => {
    const bakery = findBrief(briefs, "editorial-bakery");
    const cov = requirementCoverage(bakery, "Crumb & Column. Country loaf $9. Order for pickup.");
    const by = Object.fromEntries(cov.map((c) => [c.requirement, c]));
    expect(by["Weekly menu with items and prices"].met).toBe(false);
    expect(by["Weekly menu with items and prices"].evidence).toMatch(/missing "rye"/);
    expect(by["Order for pickup flow"].met).toBe(true);
    expect(by["Editorial look with serif headlines and photography"]).toMatchObject({ met: false, evidence: expect.stringMatching(/^unverified/) });
  });
});

describe.skipIf(!HAS_BROWSER)("screenshots against a local server", () => {
  let server;
  beforeAll(async () => {
    server = await serveStatic(join(MOCK_DIR, "demo-site"));
  });
  afterAll(async () => {
    await server?.close();
  });

  it("writes full-page desktop 1280 and mobile 390 PNGs, runs the journey and coverage", async () => {
    const out = tmp("sqb-shot-");
    const res = await captureSite({ url: server.url, outDir: out, baseName: "demo", brief: findBrief(briefs, "dental-clinic"), playwrightModule: PLAYWRIGHT_MODULE });
    const d = pngSize(readFileSync(res.screenshots.desktop));
    const m = pngSize(readFileSync(res.screenshots.mobile));
    expect(d.width).toBe(1280);
    expect(m.width).toBe(390);
    expect(d.height).toBeGreaterThan(800);
    expect(m.height).toBeGreaterThan(844);
    expect(readdirSync(out).sort()).toEqual(["demo-desktop.png", "demo-mobile.png"]);
    expect(res.journeys).toEqual([{ name: "book_appointment", passed: true, detail: expect.stringMatching(/4 visible form fields/) }]);
    expect(res.requirement_coverage.every((c) => c.met)).toBe(true);
  });

  it("a page whose CTA opens nothing fails the journey", async () => {
    const dir = tmp("sqb-site-");
    writeFileSync(join(dir, "index.html"), `<!doctype html><meta name=viewport content="width=device-width"><h1>Northline</h1><a href="#">Get a quote</a>`);
    const s = await serveStatic(dir);
    try {
      const res = await captureSite({ url: s.url, outDir: join(dir, "o"), baseName: "x", brief: findBrief(briefs, "home-services"), playwrightModule: PLAYWRIGHT_MODULE });
      expect(res.journeys[0]).toMatchObject({ name: "request_quote", passed: false });
      expect(res.journeys[0].detail).toMatch(/no visible form fields/);
    } finally {
      await s.close();
    }
  });
});

describe("bench CLI", () => {
  it("collect --live without env exits with a clear message and reads nothing", async () => {
    let dbCalls = 0;
    const out = tmp("sqb-live-");
    const p = run(["collect", "--live", "--run", RUN.id, "--brief", "dental-clinic", "--url", "http://127.0.0.1:9/", "--out", out], {
      env: { SUPABASE_URL: "https://x.test" },
      createDb: async () => {
        dbCalls++;
        return fakeDb();
      },
      now: NOW,
      out: () => {},
    });
    await expect(p).rejects.toThrow(UsageError);
    await expect(p).rejects.toThrow(/collect --live needs SUPABASE_SERVICE_ROLE_KEY .*Nothing was read/);
    expect(dbCalls).toBe(0);
    expect(readdirSync(out)).toEqual([]);
  });

  it("a dry collect cannot claim actual_ai_build", async () => {
    await expect(run(["collect", "--run", "r", "--brief", "dental-clinic", "--url", "http://x", "--provenance", "actual_ai_build"], { now: NOW, out: () => {} })).rejects.toThrow(
      /actual_ai_build requires --live/,
    );
  });

  it.skipIf(!HAS_BROWSER)("collect --live with env reads the run through the injected client and records actual_ai_build", async () => {
    const out = tmp("sqb-live2-");
    const db = fakeDb();
    const o = captureOut();
    const res = await run(["collect", "--live", "--run", RUN.id, "--brief", "dental-clinic", "--serve", join(MOCK_DIR, "demo-site"), "--out", out, "--playwright", PLAYWRIGHT_MODULE], {
      env: { SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "y" },
      createDb: async () => db,
      now: NOW,
      out: o.out,
    });
    expect(res.record).toMatchObject({ provenance: "actual_ai_build", system: "zavi", run_id: RUN.id, repairs: 2, timings: { to_first_preview_s: 90, to_usable_complete_s: 1530 } });
    expect(JSON.parse(readFileSync(res.file, "utf8")).provenance).toBe("actual_ai_build");
    expect(db.calls.map((c) => c.table)).toEqual(["conductor_runs", "agent_runs"]);
  });

  it("import-manual stores a manual_import record with metadata-stripped PNGs and refuses zavi or non-PNG input", async () => {
    const dir = tmp("sqb-imp-");
    const png = solidPng(20, 10, [1, 2, 3]);
    const tagged = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 12]), Buffer.from("tEXtlovable\0acct"), Buffer.from([0, 0, 0, 0]), png.subarray(33)]);
    writeFileSync(join(dir, "d.png"), tagged);
    writeFileSync(join(dir, "m.png"), png);
    writeFileSync(join(dir, "bad.png"), "not a png");
    const out = join(dir, "out");
    const res = await run(["import-manual", "--system", "lovable", "--brief", "saas-landing", "--desktop", join(dir, "d.png"), "--mobile", join(dir, "m.png"), "--url", "https://x.lovable.app", "--first-preview-s", "12", "--out", out], { now: NOW, out: () => {} });
    expect(res.record).toMatchObject({ system: "lovable", provenance: "manual_import", brief_id: "saas-landing", timings: { to_first_preview_s: 12, to_usable_complete_s: null }, urls: { site: "https://x.lovable.app" } });
    const stored = readFileSync(join(out, res.record.screenshots.desktop));
    expect(stored).toEqual(png);
    await expect(run(["import-manual", "--system", "zavi", "--brief", "saas-landing", "--desktop", join(dir, "d.png"), "--mobile", join(dir, "m.png")], { now: NOW, out: () => {} })).rejects.toThrow(/competitor outputs/);
    await expect(run(["import-manual", "--system", "lovable", "--brief", "saas-landing", "--desktop", join(dir, "bad.png"), "--mobile", join(dir, "m.png"), "--out", out], { now: NOW, out: () => {} })).rejects.toThrow(/is not a PNG/);
  });

  it.skipIf(!HAS_BROWSER)("runs the whole offline pipeline: collect demo, practice pack, unblind, report", async () => {
    const root = tmp("sqb-e2e-");
    const o = captureOut();
    const io = { now: NOW, out: o.out };
    await run(["collect", "--run", "demo-1", "--brief", "dental-clinic", "--serve", join(MOCK_DIR, "demo-site"), "--provenance", "hand_written_demo", "--out", join(root, "collected"), "--playwright", PLAYWRIGHT_MODULE], io);
    const packRes = await run(["blind-pack", "--records", MOCK_DIR, "--out", join(root, "pack"), "--key", join(root, "key.json"), "--seed", "e2e", "--allow-mocked"], io);
    const key = JSON.parse(readFileSync(join(root, "key.json"), "utf8"));
    expect(key.items).toHaveLength(6);
    expect(packRes.items).toHaveLength(6);
    const ratings = { pack_id: key.pack_id, rater: "e2e", ratings: key.items.map((it) => ({ item_id: it.item_id, viewport: "desktop", A: { hierarchy: 4 }, B: { hierarchy: 2 }, preference: "A" })) };
    writeFileSync(join(root, "r.json"), JSON.stringify(ratings));
    await run(["unblind", "--key", join(root, "key.json"), "--ratings", join(root, "r.json"), "--out", join(root, "joined.json")], io);
    const rep = await run(["report", "--records", `${MOCK_DIR},${join(root, "collected")}`, "--joined", join(root, "joined.json")], io);
    expect(rep.data.headline).toBe(false);
    expect(rep.data.not_evidence_records).toBe(13);
    expect(rep.text).toMatch(/demo-1 +dental-clinic +zavi +hand_written_demo/);
    expect(rep.text).toMatch(/blind ratings touching these rows: 12 \(practice only\)/);
    expect(existsSync(join(root, "pack", "rate.html"))).toBe(true);
  });

  it("report refuses invalid records instead of silently dropping them", async () => {
    const dir = tmp("sqb-inv-");
    mkdirSync(join(dir, "r"));
    writeFileSync(join(dir, "r", "x.record.json"), JSON.stringify({ run_id: "x" }));
    await expect(run(["report", "--records", dir], { now: NOW, out: () => {} })).rejects.toThrow(/invalid records:[\s\S]*provenance is required/);
  });
});

describe("playwright module resolution", () => {
  it("defaults to the backend's own playwright-core dependency, never a path on one machine", () => {
    expect(process.env.BENCH_PLAYWRIGHT_MODULE ? true : PLAYWRIGHT_MODULE === "playwright-core").toBe(true);
    expect(PLAYWRIGHT_MODULE).not.toMatch(/^\/Users\//);
  });

  it("reports no browser, without throwing, for a module that is missing or has no chromium", async () => {
    await expect(browserAvailable("definitely-not-a-playwright-module")).resolves.toBe(false);
    await expect(browserAvailable("node:path")).resolves.toBe(false);
  });

  it("no bench file hardcodes a path on a developer's machine", () => {
    const root = join(MOCK_DIR, "..", "..");
    const hits = grepDir(root, ["", "Users", ""].join("/"));
    expect(hits).toEqual([]);
  });
});
