import { describe, expect, it, vi } from "vitest";
import { createSiteDeployHandler, memoryCheckpoints, type SiteDeployDeps } from "../site-deploy";
import type { SiteGateResult, SiteRow, SiteSandbox, StagedDeploy } from "../contract";
import { fakeGenerations, fakeSiteStore, siteRow, T1 } from "./fake-site-store";
import { designDirections, withCompleteLook } from "../design-directions";
import type { DesignBrief } from "../design-brief";
import type { SiteDesignRow } from "../site-design-store";
import type { FidelityResult } from "../design-fidelity";
import { renderThemeCss } from "@/services/provisioning/templates/vite-react-zavi/theme-presets";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const SHA = "abcdef1234567";

const BRIEF: DesignBrief = withCompleteLook(
  {
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
    plan: {
      tone: "reassuring",
      primary_action: { label: "Book a check-up", steps: "Pick a time and confirm." },
      pages: [
        {
          path: "/",
          title: "Home",
          sections: [
            { name: "Hero", headline: "Gentle family dentistry" },
            { name: "Services", headline: "Check-ups and cleanings" },
            { name: "Hours", headline: "Open six days a week" },
          ],
        },
      ],
    },
    look: { base: "fresh", layout: "split", alternates: ["clean", "trust"] },
    source: "model",
  },
  "",
);

function activationState(site: SiteRow, staged: Pick<StagedDeploy, "deploy_id" | "sha">) {
  if (site.live_deploy_id === staged.deploy_id) return "live" as const;
  if (site.desired_sha !== staged.sha) return "superseded" as const;
  return "pending" as const;
}

function setup(opts: { gate: Partial<SiteGateResult>; design: SiteDesignRow | null; themeCss?: string; visionMode?: string }) {
  const { store, sites } = fakeSiteStore([siteRow({ id: A, label: "smile", name: "Millbrook Smiles", supabase_project_ref: null, supabase_url: null })]);
  const gens = fakeGenerations(sites);
  const kv: Record<string, string> = {};
  const run = vi.fn(async (cmd: string) => {
    if (cmd === `git --no-replace-objects show ${SHA}:src/theme.css`) {
      return opts.themeCss === undefined ? { exitCode: 128, stdout: "", stderr: "missing" } : { exitCode: 0, stdout: opts.themeCss, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const sandbox = { run, readFile: vi.fn(), listFiles: vi.fn() } as unknown as SiteSandbox;
  const runGate = vi.fn(async (_i: { page_text?: boolean }) => ({ ok: true, reason: "ok", evidence: "{}", owner_journey: "not_required" as const, ...opts.gate }));
  const recorded: Array<{ fidelity: FidelityResult; applied: string | null }> = [];
  const designBriefs = {
    get: vi.fn(async () => opts.design),
    recordFidelity: vi.fn(async (_t: string, _s: string, fidelity: FidelityResult, applied: string | null) => {
      recorded.push({ fidelity, applied });
    }),
  };
  const requestActivate = vi.fn(async (i: { tenant_id: string; site_id: string; deploy_id: string; sha: string }) => {
    const s = await store.get(i.tenant_id, i.site_id);
    if (await store.activateIfDesired(i.tenant_id, i.site_id, i.sha, i.deploy_id, `https://${s!.hostname}`)) kv[`host:${s!.hostname}`] = i.deploy_id;
  });
  const deps: SiteDeployDeps = {
    store,
    sandboxes: { forSite: vi.fn(async () => sandbox) },
    supabase: { applySql: vi.fn(async () => "applied" as const), verifyCatalog: vi.fn(async () => []) },
    publisher: {
      stage: vi.fn(async (i: { sha: string }) => ({ deploy_id: "d000000001-00000001", preview_url: "https://p/__zavi_preview/x/?t=tok-1-abcdefgh", sha: i.sha })),
      previewUrl: async () => "https://unused.example/",
    },
    generations: gens.generations,
    requestActivate,
    activationState,
    verifySiteDeploy: vi.fn(async (hostname: string, deploy_id: string) =>
      kv[`host:${hostname}`] === deploy_id ? ({ ok: true } as const) : ({ ok: false, error: "not yet" } as const),
    ),
    checkpoints: memoryCheckpoints(),
    runGate: runGate as unknown as SiteDeployDeps["runGate"],
    sleep: async () => {},
    activationWaitMs: 0,
    designBriefs,
    ...(opts.visionMode ? { visionMode: async () => opts.visionMode! } : {}),
  };
  const handler = createSiteDeployHandler(deps);
  return { handler, runGate, recorded, designBriefs };
}

function design(over: Partial<SiteDesignRow> = {}): SiteDesignRow {
  return {
    site_id: A,
    tenant_id: T1,
    conductor_run_id: "run-1",
    brief: BRIEF,
    directions: designDirections(BRIEF),
    theme_mode: "theme_css",
    chosen_direction: "trust",
    chosen_at: null,
    applied_direction: "brand",
    sealed_at: null,
    journey_fix_claimed_at: null,
    journey_fix_conductor_run_id: null,
    fidelity: null,
    updated_at: null,
    ...over,
  };
}

const step = (h: ReturnType<typeof setup>["handler"]) => h.step({ tenant_id: T1, conductor_run_id: "run-1", site_id: A, sha: SHA, attempt: 0 });

const placeholder = [{ path: "/", text: "Welcome to our new site" }];

describe("the first deploy checks the site against its design brief", () => {
  it("records the checklist and the look the commit carries, and never sends a passing site back for plan misses", async () => {
    const trust = designDirections(BRIEF)[2]!;
    const t = setup({ gate: { page_text: placeholder }, design: design(), themeCss: renderThemeCss(trust.preset) });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "live" });
    expect(t.runGate.mock.calls[0][0].page_text).toBe(true);
    expect(t.recorded).toHaveLength(1);
    expect(t.recorded[0].applied).toBe(trust.id);
    expect(t.recorded[0].fidelity.gross).toBe(true);
    expect(t.recorded[0].fidelity.items.find((i) => i.kind === "name")).toMatchObject({ label: "Millbrook Smiles", found: false });
  });

  it("a fix pass that is coming anyway also gets the plan's misses", async () => {
    const t = setup({ gate: { ok: false, reason: "journey book failed: no confirmation", page_text: placeholder }, design: design() });
    const out = await step(t.handler);
    expect(out).toMatchObject({ kind: "repair" });
    const signal = (out as { signal: string }).signal;
    expect(signal).toContain("journey book failed");
    expect(signal).toContain('the "Services" section from the site plan');
    expect(signal).toContain('the main action "Book a check-up"');
    expect(t.recorded[0].applied).toBeNull();
  });

  it("a site with all of its plan on the home page gets no addendum", async () => {
    const t = setup({
      gate: {
        ok: false,
        reason: "journey book failed",
        page_text: [{ path: "/", text: "Millbrook Smiles\nGentle family dentistry\nCheck-ups and cleanings\nOpen six days a week\nBook a check-up" }],
      },
      design: design(),
    });
    const out = await step(t.handler);
    expect((out as { signal: string }).signal).not.toContain("site plan");
  });

  it("a main action that dead-ends on the empty published site gets one fix pass, never two", async () => {
    const pages = [
      { path: "/", text: "Millbrook Smiles\nGentle family dentistry\nCheck-ups and cleanings\nOpen six days a week\nBook a check-up" },
      { path: "/book", text: "Pick a time\nNo appointments available." },
    ];
    const t = setup({ gate: { page_text: pages }, design: design() });
    const out = await t.handler.step({ tenant_id: T1, conductor_run_id: "run-1", site_id: A, sha: SHA, attempt: 0 });
    expect(out).toMatchObject({ kind: "repair", journeys: { must_pass: ["zavi:brief-journey"] } });
    expect((out as { signal: string }).signal).toContain('/book: "No appointments available."');

    const again = setup({ gate: { page_text: pages }, design: design() });
    const second = await again.handler.step({
      tenant_id: T1,
      conductor_run_id: "run-1",
      site_id: A,
      sha: SHA,
      attempt: 1,
      kept_journeys: { names: [], must_pass: ["zavi:brief-journey"], fingerprints: {} },
    });
    expect(second).toMatchObject({ kind: "live" });
  });

  it("the dead-end fix is asked for once per site: never after another run used it, again when this run's own reservation never dispatched", async () => {
    const pages = [
      { path: "/", text: "Millbrook Smiles\nGentle family dentistry\nCheck-ups and cleanings\nOpen six days a week\nBook a check-up" },
      { path: "/book", text: "No appointments available." },
    ];
    const used = setup({ gate: { page_text: pages }, design: design({ journey_fix_claimed_at: "2026-10-07T00:00:00Z", journey_fix_conductor_run_id: "other-run" }) });
    expect(await step(used.handler)).toMatchObject({ kind: "live" });
    const own = setup({ gate: { page_text: pages }, design: design({ journey_fix_claimed_at: "2026-10-07T00:00:00Z", journey_fix_conductor_run_id: "run-1" }) });
    expect(await step(own.handler)).toMatchObject({ kind: "repair", free_fix: "brief_journey" });
  });

  it("without a brief and with the review off the gate reads no page text and nothing is recorded; an unreadable brief never blocks the deploy", async () => {
    const t = setup({ gate: {}, design: null, visionMode: "off" });
    expect(await step(t.handler)).toMatchObject({ kind: "live" });
    expect(t.runGate.mock.calls[0][0].page_text).toBe(false);
    expect(t.recorded).toEqual([]);

    const reviewed = setup({ gate: {}, design: null, visionMode: "observe" });
    expect(await step(reviewed.handler)).toMatchObject({ kind: "live" });
    expect(reviewed.runGate.mock.calls[0][0].page_text).toBe(true);
    expect(reviewed.recorded).toEqual([]);

    const broken = setup({ gate: {}, design: design() });
    broken.designBriefs.get.mockRejectedValueOnce(new Error("db down"));
    expect(await step(broken.handler)).toMatchObject({ kind: "live" });
  });
});
