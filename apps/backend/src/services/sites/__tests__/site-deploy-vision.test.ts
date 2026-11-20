import { describe, expect, it, vi } from "vitest";
import { createSiteDeployHandler, memoryCheckpoints, type SiteDeployDeps, type SiteVisionRecord } from "../site-deploy";
import type { SiteGateResult, SiteKeptJourneys, SiteRow, SiteSandbox, StagedDeploy } from "../contract";
import type { SiteGateInput } from "../site-gate";
import { fakeGenerations, fakeSiteStore, siteRow, T1 } from "./fake-site-store";
import { VISION_DATA_RULE, VISION_FIX_MARK, VISION_KEEP_RULE, type SiteVisionFinding } from "../site-vision-review";
import { ERROR_TEXT_JOURNEY } from "../site-gate";
import type { SiteDesignRow } from "../site-design-store";
import type { DesignBrief } from "../design-brief";
import { nodePayloadCheckpoints, runWithNodeCheckpoints } from "../deploy-checkpoints";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const SHA = "abcdef1234567";
const LIVE = "1111111aaaa";
const ON = { SITE_GATE_VISION_REVIEW: "1" };

const defect = (over: Partial<SiteVisionFinding> = {}): SiteVisionFinding => ({
  screenshot: "3 (mobile /)",
  page: "/",
  category: "mobile",
  severity: "high",
  class: "defect",
  confidence: 0.9,
  evidence: "the Book button covers the menu at phone width",
  suggestion: "stack the header actions below 640px",
  ...over,
});

function activationState(site: SiteRow, staged: Pick<StagedDeploy, "deploy_id" | "sha">) {
  if (site.live_deploy_id === staged.deploy_id) return "live" as const;
  if (site.desired_sha !== staged.sha) return "superseded" as const;
  return "pending" as const;
}

type Scenario = {
  env?: NodeJS.ProcessEnv;
  mode?: string | Error;
  maxRepairs?: number | Error;
  gate?: Partial<SiteGateResult>;
  vision?: SiteGateResult["vision"] | "timeout";
  site?: Partial<SiteRow>;
  light?: boolean;
  recordVision?: SiteDeployDeps["recordVision"] | null;
  checkpoints?: SiteDeployDeps["checkpoints"];
  design?: SiteDesignRow | null;
};

function setup(sc: Scenario = {}) {
  const { store, sites } = fakeSiteStore([siteRow({ id: A, label: "smile", name: "Millbrook Smiles", supabase_project_ref: null, supabase_url: null, ...sc.site })]);
  const kv: Record<string, string> = {};
  const sandbox = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })), readFile: vi.fn(), listFiles: vi.fn() } as unknown as SiteSandbox;
  const review = vi.fn();
  const runGate = vi.fn(async (i: SiteGateInput): Promise<SiteGateResult> => {
    const base: SiteGateResult = {
      ok: true,
      reason: "smoke journeys passed",
      evidence: "{}",
      owner_journey: "not_required",
      journeys: ["home", "book"],
      all_fingerprints: { home: "h1", book: "b1" },
      ...sc.gate,
    };
    if (!i.vision || i.vision.mode === "off") return base;
    review(i.vision);
    const v = sc.vision === "timeout" ? { status: "not_reviewed" as const, reason: "timeout" as const, findings: [] } : sc.vision;
    return v ? { ...base, vision: v } : base;
  });
  const runLightGate = vi.fn(async () => ({ ok: true, reason: "ok", evidence: "", owner_journey: "not_required" as const }));
  const records: SiteVisionRecord[] = [];
  const recordVision = sc.recordVision === null ? undefined : (sc.recordVision ?? vi.fn(async (r: SiteVisionRecord) => { records.push(r); }));
  const visionMode = vi.fn(async () => {
    if (sc.mode instanceof Error) throw sc.mode;
    return sc.mode ?? "observe";
  });
  const repairMaxAttempts = vi.fn(async () => {
    if (sc.maxRepairs instanceof Error) throw sc.maxRepairs;
    return sc.maxRepairs ?? 1;
  });
  const designBriefs = { get: vi.fn(async () => sc.design ?? null), recordFidelity: vi.fn(async () => undefined) };
  const requestActivate = vi.fn(async (i: { tenant_id: string; site_id: string; deploy_id: string; sha: string }) => {
    const s = await store.get(i.tenant_id, i.site_id);
    if (await store.activateIfDesired(i.tenant_id, i.site_id, i.sha, i.deploy_id, `https://${s!.hostname}`)) kv.host = i.deploy_id;
  });
  const deps: SiteDeployDeps = {
    store,
    sandboxes: { forSite: vi.fn(async () => sandbox) },
    supabase: { applySql: vi.fn(async () => "applied" as const), verifyCatalog: vi.fn(async () => []) },
    publisher: {
      stage: vi.fn(async (i: { sha: string }) => ({ deploy_id: "d000000001-00000001", preview_url: "https://p/__zavi_preview/x/?t=tok-1-abcdefgh", sha: i.sha })),
      previewUrl: async () => "https://unused.example/",
    },
    generations: fakeGenerations(sites).generations,
    requestActivate,
    activationState,
    verifySiteDeploy: vi.fn(async (_h: string, id: string) => (kv.host === id ? ({ ok: true } as const) : ({ ok: false, error: "no" } as const))),
    checkpoints: sc.checkpoints ?? memoryCheckpoints(),
    runGate: runGate as unknown as SiteDeployDeps["runGate"],
    lightGateEnabled: async () => sc.light === true,
    classifyChange: async () => ({ files: 1, migrations_touched: false, light: { ok: true, tokens: ["Smiles"] } }),
    runLightGate: runLightGate as unknown as SiteDeployDeps["runLightGate"],
    sleep: async () => {},
    activationWaitMs: 0,
    designBriefs,
    env: sc.env ?? ON,
    visionMode,
    repairMaxAttempts,
    ...(recordVision ? { recordVision } : {}),
  };
  const handler = createSiteDeployHandler(deps);
  const step = (attempt = 1, kept_journeys?: SiteKeptJourneys) =>
    handler.step({ tenant_id: T1, conductor_run_id: "run-1", site_id: A, sha: SHA, attempt, ...(kept_journeys ? { kept_journeys } : {}) });
  return { step, runGate, runLightGate, review, records, visionMode, repairMaxAttempts, requestActivate, designBriefs, stage: deps.publisher.stage as ReturnType<typeof vi.fn> };
}

const quiet = () => {
  const w = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const i = vi.spyOn(console, "info").mockImplementation(() => undefined);
  return () => {
    w.mockRestore();
    i.mockRestore();
  };
};
const reviewed = (findings: SiteVisionFinding[]): SiteGateResult["vision"] => ({ status: "reviewed", ok: true, findings });

describe("observe mode (the default): findings are recorded, nothing is ever repaired", () => {
  it("a qualifying defect on a passing site is recorded and the site goes live untouched", async () => {
    const done = quiet();
    const t = setup({ vision: reviewed([defect()]) });
    const out = await t.step();
    done();
    expect(out).toMatchObject({ kind: "live" });
    expect(t.repairMaxAttempts).not.toHaveBeenCalled();
    expect(t.records).toHaveLength(1);
    expect(t.records[0]).toMatchObject({ status: "reviewed", ok: true, mode: "observe", action: "none", sha: SHA, attempt: 1, counts: { findings: 1, high: 1, qualifying: 1, preferences: 0 } });
    expect(t.runGate.mock.calls[0]![0].vision).toMatchObject({ mode: "observe", brief: { business_name: "Millbrook Smiles" } });
  });

  it("an unknown or unreadable mode reads as observe, never correct", async () => {
    for (const mode of ["CORRECT", "yes", new Error("settings down")]) {
      const done = quiet();
      const t = setup({ mode, vision: reviewed([defect()]) });
      expect(await t.step()).toMatchObject({ kind: "live" });
      done();
      expect(t.records[0]!.mode).toBe("observe");
    }
  });

  it("a failing gate in observe mode gets no visual addendum", async () => {
    const done = quiet();
    const t = setup({ gate: { ok: false, reason: "journey book failed" }, vision: reviewed([defect()]) });
    const out = await t.step();
    done();
    expect(out).toMatchObject({ kind: "repair" });
    expect((out as { signal: string }).signal).not.toContain("screenshot");
    expect(t.records[0]!.action).toBe("none");
  });
});

describe("correct mode: one bounded visual fix pass", () => {
  it("a passing site with a high-confidence high-severity defect gets exactly one repair that keeps every journey", async () => {
    const done = quiet();
    const t = setup({ mode: "correct", maxRepairs: 2, vision: reviewed([defect(), defect({ class: "preference", confidence: 0.9, evidence: "softer shadows" })]) });
    const out = await t.step();
    done();
    expect(out).toEqual({
      kind: "repair",
      signal: expect.any(String),
      journeys: { names: ["home", "book"], must_pass: [VISION_FIX_MARK], fingerprints: { home: "h1", book: "b1" } },
    });
    expect(out).not.toHaveProperty("free_fix");
    const signal = (out as { signal: string }).signal;
    expect(signal).toContain(VISION_KEEP_RULE);
    expect(signal).toContain('seen "the Book button covers the menu at phone width"; suggested fix "stack the header actions below 640px"');
    expect(signal).toMatch(/Advisory only[^\n]*\n[^\n]*softer shadows/);
    expect(t.requestActivate).not.toHaveBeenCalled();
    expect(t.records[0]).toMatchObject({ mode: "correct", action: "repair" });
  });

  it("a missed requirement qualifies like a defect", async () => {
    const done = quiet();
    const t = setup({ mode: "correct", maxRepairs: 2, vision: reviewed([defect({ class: "missed_requirement", category: "brief", confidence: 0.8 })]) });
    expect(await t.step()).toMatchObject({ kind: "repair" });
    done();
  });

  it.each([
    ["a preference", defect({ class: "preference", confidence: 1 })],
    ["confidence 0.79", defect({ confidence: 0.79 })],
    ["medium severity", defect({ severity: "medium", confidence: 1 })],
    ["low severity", defect({ severity: "low", confidence: 1 })],
  ])("%s never triggers a repair", async (_label, f) => {
    const done = quiet();
    const t = setup({ mode: "correct", vision: reviewed([f]) });
    expect(await t.step()).toMatchObject({ kind: "live" });
    done();
    expect(t.records[0]!.action).toBe("none");
    expect(t.records[0]!.counts.qualifying).toBe(0);
  });

  it("the visual pass has its own slot: with the default single fix pass, or after the fix passes were used, it still runs once", async () => {
    for (const [attempt, maxRepairs] of [[1, 1], [2, 2], [2, 1]] as const) {
      const done = quiet();
      const t = setup({ mode: "correct", maxRepairs, vision: reviewed([defect()]) });
      expect(await t.step(attempt)).toMatchObject({ kind: "repair", journeys: { must_pass: [VISION_FIX_MARK] } });
      done();
      expect(t.records[0]!.action).toBe("repair");
      expect(t.requestActivate).not.toHaveBeenCalled();
    }
  });

  it("fix passes turned off (max 0) or an unreadable max: no repair, the site goes live and the skip is recorded", async () => {
    for (const maxRepairs of [0, new Error("db")] as const) {
      const done = quiet();
      const t = setup({ mode: "correct", maxRepairs, vision: reviewed([defect()]) });
      expect(await t.step(1)).toMatchObject({ kind: "live" });
      done();
      expect(t.records[0]!.action).toBe("skipped_no_attempts");
    }
  });

  it("after the visual fix the gate re-runs in full with every journey kept, the review runs again, and a second fix is never asked", async () => {
    const done = quiet();
    const t = setup({ mode: "correct", light: true, site: { status: "live", live_sha: LIVE, live_deploy_id: "d0-live", desired_sha: LIVE }, vision: reviewed([defect()]) });
    const kept = { names: ["home", "book"], must_pass: [VISION_FIX_MARK], fingerprints: { home: "h1", book: "b1" } };
    const out = await t.step(2, kept);
    done();
    expect(out).toMatchObject({ kind: "live" });
    expect(t.runLightGate).not.toHaveBeenCalled();
    expect(t.runGate.mock.calls[0]![0].kept_journeys).toEqual(kept);
    expect(t.review).toHaveBeenCalledTimes(1);
    expect(t.repairMaxAttempts).not.toHaveBeenCalled();
    expect(t.records[0]).toMatchObject({ action: "skipped_used", counts: { qualifying: 1 } });
  });

  it("a review that timed out never triggers a repair and is recorded as not_reviewed, never as a pass", async () => {
    const done = quiet();
    const t = setup({ mode: "correct", vision: "timeout" });
    expect(await t.step()).toMatchObject({ kind: "live" });
    done();
    expect(t.records).toHaveLength(1);
    expect(t.records[0]).toMatchObject({ status: "not_reviewed", reason: "timeout", action: "none", counts: { findings: 0 } });
    expect(t.records[0]).not.toHaveProperty("ok");
  });

  it("a functionally failing gate gets ONE repair: the visual findings ride along on its signal, no extra pass", async () => {
    const done = quiet();
    const t = setup({
      mode: "correct",
      gate: { ok: false, reason: "journey book failed: no confirmation", failed_journeys: ["book"], fingerprints: { book: "b1" } },
      vision: reviewed([defect()]),
    });
    const out = await t.step();
    done();
    expect(out).toMatchObject({ kind: "repair", journeys: { names: ["home", "book"], must_pass: ["book"], fingerprints: { book: "b1" } } });
    const signal = (out as { signal: string }).signal;
    expect(signal.startsWith("The site's smoke check failed: journey book failed: no confirmation")).toBe(true);
    expect(signal).toContain(`While you fix that, a screenshot review also reported visible problems; verify them and fix the ones you confirm, changing nothing else.\n${VISION_DATA_RULE}\n- screenshot 3 (mobile /), mobile: seen "the Book button covers the menu at phone width"`);
    expect((out as { journeys: SiteKeptJourneys }).journeys.must_pass).not.toContain(VISION_FIX_MARK);
    expect(t.records[0]!.action).toBe("rode_along");
  });

  it("after the visual fix was used, a functional failure carries no visual addendum", async () => {
    const done = quiet();
    const t = setup({ mode: "correct", gate: { ok: false, reason: "journey book failed" }, vision: reviewed([defect()]) });
    const out = await t.step(2, { names: ["home", "book"], must_pass: [VISION_FIX_MARK], fingerprints: {} });
    done();
    expect((out as { signal: string }).signal).not.toContain("screenshot review");
  });
});

describe("switches", () => {
  it("env flag unset: the review is on by default and the stored mode is read", async () => {
    const done = quiet();
    const t = setup({ env: {}, mode: "observe", vision: reviewed([defect()]) });
    expect(await t.step()).toMatchObject({ kind: "live" });
    done();
    expect(t.visionMode).toHaveBeenCalledTimes(1);
    expect(t.review).toHaveBeenCalledTimes(1);
    expect(t.records).toHaveLength(1);
  });

  it("env flag 0: no mode read, no review input, no record, even with correct mode stored", async () => {
    const t = setup({ env: { SITE_GATE_VISION_REVIEW: "0" }, mode: "correct", vision: reviewed([defect()]) });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.visionMode).not.toHaveBeenCalled();
    expect(t.runGate.mock.calls[0]![0]).not.toHaveProperty("vision");
    expect(t.review).not.toHaveBeenCalled();
    expect(t.records).toEqual([]);
  });

  it("tenant mode off: the gate is told off, nothing is reviewed or repaired", async () => {
    const done = quiet();
    const t = setup({ mode: "off", vision: reviewed([defect()]) });
    expect(await t.step()).toMatchObject({ kind: "live" });
    done();
    expect(t.runGate.mock.calls[0]![0].vision).toEqual({ mode: "off", brief: null });
    expect(t.review).not.toHaveBeenCalled();
  });

  it("the light path never calls the reviewer, even in correct mode", async () => {
    const t = setup({ mode: "correct", light: true, site: { status: "live", live_sha: LIVE, live_deploy_id: "d0-live", desired_sha: LIVE }, vision: reviewed([defect()]) });
    expect(await t.step()).toMatchObject({ kind: "live" });
    expect(t.runLightGate).toHaveBeenCalledTimes(1);
    expect(t.runGate).not.toHaveBeenCalled();
    expect(t.review).not.toHaveBeenCalled();
    expect(t.records).toEqual([]);
  });
});

describe("the production recorder writes the node's checkpoint bag", () => {
  it("the record lands under site_vision in the bag the conductor persists, capped to 5 findings of 200 chars", async () => {
    const done = quiet();
    const bag: Record<string, unknown> = {};
    const many = Array.from({ length: 8 }, (_, i) => defect({ evidence: `${i}${"e".repeat(299)}`, severity: "medium" }));
    const t = setup({ recordVision: null, checkpoints: nodePayloadCheckpoints(), vision: reviewed(many) });
    const out = await runWithNodeCheckpoints(bag, () => t.step());
    done();
    expect(out).toMatchObject({ kind: "live" });
    const rec = bag.site_vision as SiteVisionRecord;
    expect(rec).toMatchObject({ status: "reviewed", mode: "observe", action: "none", counts: { findings: 8 } });
    expect(rec.findings).toHaveLength(5);
    expect(rec.findings[0]!.evidence).toHaveLength(200);
  });
});

const CORE_BRIEF = {
  industry: "dentist",
  mood: "calm clean kind",
  mode: "light",
  colors: {
    background: "#ffffff",
    foreground: "#0f2e2a",
    muted: "#f0fdfa",
    "muted-foreground": "#3d5753",
    primary: "#0f766e",
    "primary-foreground": "#ffffff",
    border: "#d5e5e2",
  },
  fonts: { heading: "Nunito", body: "Nunito" },
};

function designRow(brief: Record<string, unknown>): SiteDesignRow {
  return {
    site_id: A,
    tenant_id: T1,
    conductor_run_id: "run-1",
    brief: { ...CORE_BRIEF, ...brief } as unknown as DesignBrief,
    directions: [],
    theme_mode: "none",
    chosen_direction: "brand",
    chosen_at: null,
    applied_direction: null,
    sealed_at: null,
    journey_fix_claimed_at: null,
    journey_fix_conductor_run_id: null,
    fidelity: null,
    updated_at: null,
  };
}

const LIVE_SITE = { status: "live" as const, live_sha: LIVE, live_deploy_id: "d0-live", desired_sha: LIVE };

describe("a malformed stored brief never blocks a publish", () => {
  const shapes: Array<[string, Record<string, unknown>]> = [
    ["a plan without pages", { plan: { tone: "warm" } }],
    ["a section whose name is not a string", { plan: { primary_action: { label: "Book", steps: "Pick a time" }, pages: [{ path: "/", title: "Home", sections: [{ name: 42, headline: "Hi" }] }] } }],
    ["image subjects that are not strings", { imagery: { subjects: [7, { x: 1 }], style: 3 } }],
  ];

  it.each(shapes)("%s: the gate passes, the review still runs on the name and look, and the site goes live", async (_label, bad) => {
    for (const site of [LIVE_SITE, {}]) {
      const done = quiet();
      const t = setup({
        mode: "correct",
        site,
        design: designRow(bad),
        gate: { page_text: [{ path: "/", text: "Millbrook Smiles", sections: [] }] },
        vision: reviewed([]),
      });
      const out = await t.step();
      done();
      expect(out).toMatchObject({ kind: "live" });
      expect(t.review).toHaveBeenCalledTimes(1);
      expect(t.review.mock.calls[0]![0].brief).toMatchObject({ business_name: "Millbrook Smiles", industry: "dentist" });
      expect(t.records[0]).toMatchObject({ status: "reviewed", action: "none" });
    }
  });
});

describe("the visual fix is decided once and a decline never re-gates", () => {
  it("a visual fix keeps this commit's gated checkpoint: the next tick on the same attempt goes live without staging, gating or reviewing again", async () => {
    const done = quiet();
    const bag: Record<string, unknown> = {};
    const t = setup({ mode: "correct", maxRepairs: 2, recordVision: null, checkpoints: nodePayloadCheckpoints(), vision: reviewed([defect()]) });
    const first = await runWithNodeCheckpoints(bag, () => t.step(1));
    expect(first).toMatchObject({ kind: "repair", journeys: { must_pass: [VISION_FIX_MARK] } });
    const gated = Object.values(bag).find((v) => (v as { phase?: string })?.phase === "gated");
    expect(gated).toMatchObject({ sha: SHA, phase: "gated" });
    const second = await runWithNodeCheckpoints(bag, () => t.step(1, { names: [], must_pass: [VISION_FIX_MARK], fingerprints: {} }));
    done();
    expect(second).toMatchObject({ kind: "live" });
    expect(t.stage).toHaveBeenCalledTimes(1);
    expect(t.runGate).toHaveBeenCalledTimes(1);
    expect(t.review).toHaveBeenCalledTimes(1);
  });
});

describe("a ride-along never costs the functional evidence and never rides a repair that cannot run", () => {
  it("no fix pass left for the functional repair: the signal carries no screenshot findings and the skip is recorded", async () => {
    const done = quiet();
    const t = setup({ mode: "correct", maxRepairs: 1, gate: { ok: false, reason: "journey book failed" }, vision: reviewed([defect()]) });
    const out = await t.step(2);
    done();
    expect(out).toMatchObject({ kind: "repair" });
    expect((out as { signal: string }).signal).not.toContain("screenshot");
    expect((out as { signal: string }).signal).not.toContain("the Book button covers the menu");
    expect(t.records[0]!.action).toBe("skipped_no_attempts");
  });

  it("long gate evidence is kept whole; the visual findings only take the room that is left", async () => {
    const evidence = `${"E".repeat(1_399)}Z`;
    const done = quiet();
    const t = setup({ mode: "correct", gate: { ok: false, reason: "journey book failed", evidence }, vision: reviewed([defect()]) });
    const out = await t.step();
    done();
    const signal = (out as { signal: string }).signal;
    expect(signal.startsWith(`The site's smoke check failed: journey book failed\nEvidence: ${evidence}`)).toBe(true);
    expect(signal).not.toContain("screenshot review");
    expect(t.records[0]!.action).toBe("skipped_no_room");
  });
});

describe("a qualifying finding that is not acted on records why", () => {
  it("the main action dead-ends: the free fix runs and the visual finding is recorded as deferred to it", async () => {
    const done = quiet();
    const t = setup({
      mode: "correct",
      maxRepairs: 2,
      design: designRow({
        plan: {
          tone: "reassuring",
          primary_action: { label: "Book a check-up", steps: "Pick a time and confirm." },
          pages: [{ path: "/", title: "Home", sections: [{ name: "Hero", headline: "Gentle family dentistry" }] }],
        },
      }),
      gate: {
        page_text: [
          { path: "/", text: "Millbrook Smiles\nGentle family dentistry\nBook a check-up", sections: [] },
          { path: "/book", text: "Pick a time\nNo appointments available.", sections: [] },
        ],
      },
      vision: reviewed([defect()]),
    });
    const out = await t.step();
    done();
    expect(out).toMatchObject({ kind: "repair", free_fix: "brief_journey" });
    expect(t.records[0]).toMatchObject({ action: "deferred_free_fix", counts: { qualifying: 1 } });
  });

  it("error text still present after its one fix: the site goes live and the visual finding is recorded as skipped for it", async () => {
    const done = quiet();
    const t = setup({ mode: "correct", maxRepairs: 3, gate: { ok: false, reason: "error text on /", error_text: "only" }, vision: reviewed([defect()]) });
    const out = await t.step(2, { names: [], must_pass: [ERROR_TEXT_JOURNEY], fingerprints: {} });
    done();
    expect(out).toMatchObject({ kind: "live" });
    expect(t.records[0]!.action).toBe("skipped_error_text");
  });
});

describe("the page check (repeated sections and copied pages)", () => {
  const section = (seed: string) => {
    let t = seed;
    while (t.length < 360) t += ` ${seed}`;
    return t.slice(0, 360);
  };
  const REVIEWS = section("Customers say the team arrives on time, explains every step and leaves the place spotless.");
  const repeatedPage = {
    page_text: [
      {
        path: "/",
        text: `Northside Movers\n${REVIEWS}\n${REVIEWS}`,
        sections: [],
        blocks: [{ len: REVIEWS.length, head: REVIEWS.slice(0, 160) }, { len: REVIEWS.length, head: REVIEWS.slice(0, 160) }],
      },
    ],
  };

  it("the gate is asked for the pages' text whenever the review runs, even after the first build", async () => {
    const done = quiet();
    const t = setup({ vision: reviewed([]) });
    await t.step();
    done();
    expect(t.runGate.mock.calls[0]![0].page_text).toBe(true);
  });

  it("tenant mode off: no page text is asked for and no page check runs", async () => {
    const done = quiet();
    const t = setup({ mode: "off", gate: repeatedPage });
    expect(await t.step()).toMatchObject({ kind: "live" });
    done();
    expect(t.runGate.mock.calls[0]![0].page_text).toBe(false);
  });

  it("observe: a section shown twice is recorded with the review's findings and the site goes live", async () => {
    const done = quiet();
    const t = setup({ gate: repeatedPage, vision: reviewed([defect()]) });
    expect(await t.step()).toMatchObject({ kind: "live" });
    done();
    expect(t.records[0]).toMatchObject({
      status: "reviewed",
      action: "none",
      counts: { findings: 2, high: 2, qualifying: 2, qualifying_page: 1 },
      page_check: { pages: 1 },
    });
    expect(t.records[0]!.findings.some((f) => f.source === "page" && f.category === "repetition")).toBe(true);
  });

  it("correct: a section shown twice gets the one fix pass even when the screenshot review timed out, and the signal names the page", async () => {
    const done = quiet();
    const t = setup({ mode: "correct", maxRepairs: 1, gate: repeatedPage, vision: "timeout" });
    const out = await t.step();
    done();
    expect(out).toMatchObject({ kind: "repair", journeys: { must_pass: [VISION_FIX_MARK] } });
    const signal = (out as { signal: string }).signal;
    expect(signal).toContain("its screenshots and its pages' text");
    expect(signal).toContain("- page / (read from the page's text), repetition: seen");
    expect(t.records[0]).toMatchObject({ status: "not_reviewed", reason: "timeout", action: "repair", counts: { qualifying: 1, qualifying_page: 1 } });
  });

  it("correct: a short repeated band is recorded but never starts a fix pass", async () => {
    const band = "Ready to move? Get a free quote today and pick a date that suits you.";
    const done = quiet();
    const t = setup({
      mode: "correct",
      gate: { page_text: [{ path: "/", text: band, sections: [], blocks: [{ len: band.length, head: band }, { len: band.length, head: band }] }] },
      vision: reviewed([]),
    });
    expect(await t.step()).toMatchObject({ kind: "live" });
    done();
    expect(t.records[0]).toMatchObject({ action: "none", counts: { findings: 1, qualifying: 0, qualifying_page: 0 } });
  });
});
